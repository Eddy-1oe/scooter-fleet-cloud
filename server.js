let express, multer, path, QRCode, db;
try {
  express = require('express');
  multer = require('multer');
  path = require('path');
  QRCode = require('qrcode');
  db = require('./db');
} catch (e) {
  console.error('[FATAL] Module load failed:', e.message);
  console.error(e.stack);
  process.exit(1);
}
const app = express();

const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

// ==========================================
// FILE UPLOAD CONFIG (multer)
// ==========================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = file.fieldname === 'selfie' ? 'uploads/selfies' : 'uploads/id_photos';
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}_${file.fieldname}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ==========================================
// SCOOTER FLEET STATE (in-memory, real-time)
// ==========================================
const fleet = {};
const scooterHistory = {};
const MAX_HISTORY_ENTRIES = 100;
const pendingCommands = {};

// ==========================================
// ADMIN AUTH MIDDLEWARE
// ==========================================
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token === 'admin123') return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ==========================================
// EXISTING ENDPOINTS (unchanged)
// ==========================================

// POST /telemetry — scooter pushes data
app.post('/telemetry', (req, res) => {
  const data = req.body;
  if (!data.id) return res.status(400).json({ error: 'Missing scooter ID' });

  fleet[data.id] = { ...data, lastSeen: Date.now() };

  if (!scooterHistory[data.id]) scooterHistory[data.id] = [];
  scooterHistory[data.id].push({ ...data, timestamp: Date.now() });
  if (scooterHistory[data.id].length > MAX_HISTORY_ENTRIES) {
    scooterHistory[data.id] = scooterHistory[data.id].slice(-MAX_HISTORY_ENTRIES);
  }

  // Auto-register scooter in database
  db.ensureScooter(data.id);

  console.log(`[${data.id}] Battery: ${data.battery}% Speed: ${data.speed} mph Mode: ${data.mode}`);
  res.json({ ok: true });
});

// GET /fleet — fetch all scooter states
app.get('/fleet', (req, res) => {
  const now = Date.now();
  const result = {};
  Object.keys(fleet).forEach(id => {
    result[id] = { ...fleet[id], online: (now - fleet[id].lastSeen) < 10000 };
  });
  res.json(result);
});

// POST /command/:id — send command to scooter
app.post('/command/:id', (req, res) => {
  const id = req.params.id;
  const action = req.body.action;
  if (!action) return res.status(400).json({ error: 'Missing action' });
  if (!pendingCommands[id]) pendingCommands[id] = [];
  pendingCommands[id].push(action);
  console.log(`[CMD] ${id} -> ${action}`);
  res.json({ ok: true });
});

// GET /commands/:id — scooter polls for commands
app.get('/commands/:id', (req, res) => {
  const id = req.params.id;
  const cmds = pendingCommands[id] || [];
  pendingCommands[id] = [];
  res.json({ commands: cmds });
});

// GET /history/:id
app.get('/history/:id', (req, res) => {
  const id = req.params.id;
  res.json({ history: scooterHistory[id] || [] });
});

// GET /health
app.get('/health', (req, res) => res.status(200).send('OK'));

// ==========================================
// RIDER PUBLIC ENDPOINTS
// ==========================================

// POST /api/rider/register — KYC registration with photo uploads
app.post('/api/rider/register', upload.fields([
  { name: 'id_photo', maxCount: 1 },
  { name: 'selfie', maxCount: 1 }
]), (req, res) => {
  try {
    const { full_name, phone, email, national_id } = req.body;
    if (!full_name || !phone || !email || !national_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if phone already registered
    const existing = db.getRiderByPhone(phone);
    if (existing) {
      return res.json({ ok: true, riderId: existing.id, status: existing.kyc_status, existing: true });
    }

    const idPhotoPath = req.files?.id_photo?.[0]?.path || null;
    const selfiePath = req.files?.selfie?.[0]?.path || null;

    const riderId = db.createRider({
      phone, email, fullName: full_name, nationalId: national_id,
      idPhotoPath, selfiePath
    });

    db.audit('rider_register', `${full_name} (${phone}) registered`, 'system');
    console.log(`[RIDER] Registered: ${full_name} -> ${riderId}`);
    res.json({ ok: true, riderId, status: 'pending' });
  } catch (err) {
    console.error('[RIDER] Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// GET /api/rider/:id/status — poll KYC + payment status
app.get('/api/rider/:id/status', (req, res) => {
  const rider = db.getRider(req.params.id);
  if (!rider) return res.status(404).json({ error: 'Rider not found' });

  const activeRide = db.getActiveRideByRider(rider.id);
  const pricing = db.getPricing();
  const balance = rider.balance || 0;
  const remainingMin = balance > 0 ? Math.max(0, (balance - pricing.base_fee) / pricing.rate_per_minute) : 0;

  res.json({
    riderId: rider.id,
    fullName: rider.full_name,
    kycStatus: rider.kyc_status,
    paymentStatus: rider.payment_status,
    balance: Math.round(balance * 100) / 100,
    remainingMin: Math.round(remainingMin * 10) / 10,
    status: rider.status,
    activeRide: activeRide ? {
      rideId: activeRide.id,
      scooterId: activeRide.scooter_id,
      startTime: activeRide.start_time
    } : null
  });
});

// POST /api/scan — unlock scooter after QR scan
app.post('/api/scan', (req, res) => {
  try {
    const { riderId, scooterId, type } = req.body;
    if (!riderId) return res.status(400).json({ error: 'Missing riderId' });

    const rider = db.getRider(riderId);
    if (!rider) return res.status(404).json({ error: 'Rider not found' });
    if (rider.kyc_status !== 'approved') return res.status(403).json({ error: 'KYC not approved', code: 'not_approved' });

    // Check balance — must cover at least the base fee
    const pricing = db.getPricing();
    if ((rider.balance || 0) < pricing.base_fee) {
      return res.status(403).json({ error: 'Insufficient balance. Please top up.', code: 'low_balance', balance: rider.balance || 0, required: pricing.base_fee });
    }

    // Check rider doesn't already have an active ride
    const existingRide = db.getActiveRideByRider(riderId);
    if (existingRide) return res.status(400).json({ error: 'Already have an active ride', code: 'active_ride', rideId: existingRide.id });

    let targetScooter = null;

    if (type === 'scooter' && scooterId) {
      // Per-scooter QR — check this specific scooter
      const scooterReg = db.getScooter(scooterId);
      if (!scooterReg || scooterReg.status !== 'available') {
        return res.status(400).json({ error: 'Scooter not available', code: 'scooter_unavailable' });
      }
      const liveData = fleet[scooterId];
      if (!liveData || (Date.now() - liveData.lastSeen) > 10000) {
        return res.status(400).json({ error: 'Scooter is offline', code: 'scooter_offline' });
      }
      targetScooter = scooterId;
    } else {
      // Fleet-wide QR — find best available scooter (highest battery)
      const allScooters = db.getAllScooters().filter(s => s.status === 'available');
      let best = null, bestBattery = -1;
      for (const s of allScooters) {
        const live = fleet[s.id];
        if (!live || (Date.now() - live.lastSeen) > 10000) continue;
        if ((live.battery || 0) > bestBattery) {
          best = s.id;
          bestBattery = live.battery || 0;
        }
      }
      if (!best) return res.status(400).json({ error: 'No available scooters', code: 'no_scooters' });
      targetScooter = best;
    }

    // Start ride
    const startBattery = fleet[targetScooter]?.battery || 0;
    const rideId = db.createRide({ riderId, scooterId: targetScooter, startBattery });
    db.setScooterStatus(targetScooter, 'in_use');
    db.updateRiderStatus(riderId, 'active');

    // Unlock scooter
    if (!pendingCommands[targetScooter]) pendingCommands[targetScooter] = [];
    pendingCommands[targetScooter].push('brake_off');

    db.audit('ride_start', `${rider.full_name} unlocked ${targetScooter}`, 'system');
    console.log(`[RIDE] Started: ${rider.full_name} -> ${targetScooter}`);

    res.json({ ok: true, rideId, scooterId: targetScooter });
  } catch (err) {
    console.error('[SCAN] Error:', err.message);
    res.status(500).json({ error: 'Scan failed' });
  }
});

// ── Billable time helper ──
// Time always ticks UNLESS battery < 5% (not rider's fault)
function calcRideBilling(ride, live, pricing) {
  const now = Date.now();
  const totalMin = (now - ride.start_time) / 60000;
  const battery = live?.battery ?? 100;
  let pausedMin = ride.paused_min || 0;

  // If battery < 5%, accumulate paused time since last poll
  if (battery < 5 && ride.last_poll) {
    const sinceLast = (now - ride.last_poll) / 60000;
    pausedMin += sinceLast;
    db.addPausedTime(ride.id, sinceLast);
  } else {
    db.updateLastPoll(ride.id);
  }

  const billableMin = Math.max(0, totalMin - pausedMin);
  const cost = pricing.base_fee + (pricing.rate_per_minute * billableMin);

  return { totalMin, billableMin, pausedMin, cost: Math.round(cost * 100) / 100, battery };
}

// ── Auto-end ride when balance depleted ──
function autoEndRide(ride, live, pricing, reason) {
  const { billableMin, pausedMin, cost } = calcRideBilling(ride, live, pricing);

  db.endRide(ride.id, {
    endBattery: live?.battery || 0,
    durationMin: Math.round(billableMin * 10) / 10,
    pausedMin: Math.round(pausedMin * 10) / 10,
    distanceMiles: 0,
    maxSpeedMph: live?.speed || 0,
    cost
  });

  db.deductBalance(ride.rider_id, cost);
  db.setScooterStatus(ride.scooter_id, 'available');
  db.updateRiderStatus(ride.rider_id, 'registered');

  if (!pendingCommands[ride.scooter_id]) pendingCommands[ride.scooter_id] = [];
  pendingCommands[ride.scooter_id].push('brake_on');

  db.audit('ride_auto_end', `${reason}: ride ${ride.id} on ${ride.scooter_id}, cost: $${cost}`, 'system');
  console.log(`[RIDE] Auto-ended (${reason}): ${ride.scooter_id}, cost: $${cost}`);
}

// GET /api/rider/:id/ride — get active ride + live telemetry
app.get('/api/rider/:id/ride', (req, res) => {
  const ride = db.getActiveRideByRider(req.params.id);
  if (!ride) return res.status(404).json({ error: 'No active ride' });

  const live = fleet[ride.scooter_id] || {};
  const pricing = db.getPricing();
  const rider = db.getRider(ride.rider_id);
  const balance = rider?.balance || 0;

  const billing = calcRideBilling(ride, live, pricing);

  // Auto-end if balance depleted
  if (balance <= billing.cost && billing.billableMin > 0.5) {
    autoEndRide(ride, live, pricing, 'balance depleted');
    const updatedRider = db.getRider(ride.rider_id);
    return res.json({
      ended: true,
      reason: 'balance_depleted',
      summary: {
        durationMin: Math.round(billing.billableMin * 10) / 10,
        pausedMin: Math.round(billing.pausedMin * 10) / 10,
        cost: billing.cost,
        scooterId: ride.scooter_id,
        remainingBalance: Math.round((updatedRider?.balance || 0) * 100) / 100
      }
    });
  }

  const remainingBalance = Math.max(0, balance - billing.cost);
  const remainingMin = remainingBalance > 0 ? remainingBalance / pricing.rate_per_minute : 0;

  res.json({
    rideId: ride.id,
    scooterId: ride.scooter_id,
    startTime: ride.start_time,
    totalMin: Math.round(billing.totalMin * 10) / 10,
    billableMin: Math.round(billing.billableMin * 10) / 10,
    pausedMin: Math.round(billing.pausedMin * 10) / 10,
    estimatedCost: billing.cost,
    balance: Math.round(balance * 100) / 100,
    remainingBalance: Math.round(remainingBalance * 100) / 100,
    remainingMin: Math.round(remainingMin * 10) / 10,
    lowBattery: billing.battery < 5,
    billingPaused: billing.battery < 5,
    battery: billing.battery,
    speed: live.speed || 0,
    mode: live.mode || '—',
    gps: live.gps || null
  });
});

// POST /api/ride/:rideId/end — end ride
app.post('/api/ride/:rideId/end', (req, res) => {
  try {
    const ride = db.getRide(req.params.rideId);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    if (ride.status !== 'active') return res.status(400).json({ error: 'Ride not active' });

    const live = fleet[ride.scooter_id] || {};
    const pricing = db.getPricing();
    const billing = calcRideBilling(ride, live, pricing);

    db.endRide(ride.id, {
      endBattery: live.battery || 0,
      durationMin: Math.round(billing.billableMin * 10) / 10,
      pausedMin: Math.round(billing.pausedMin * 10) / 10,
      distanceMiles: Math.round(billing.billableMin * (live.speed || 0) / 60 * 10) / 10,
      maxSpeedMph: live.speed || 0,
      cost: billing.cost
    });

    // Deduct cost from rider balance
    db.deductBalance(ride.rider_id, billing.cost);
    const updatedRider = db.getRider(ride.rider_id);

    db.setScooterStatus(ride.scooter_id, 'available');
    db.updateRiderStatus(ride.rider_id, 'registered');

    // Lock scooter
    if (!pendingCommands[ride.scooter_id]) pendingCommands[ride.scooter_id] = [];
    pendingCommands[ride.scooter_id].push('brake_on');

    db.audit('ride_end', `Ride ${ride.id} on ${ride.scooter_id}, billed: ${billing.billableMin.toFixed(1)}min (paused: ${billing.pausedMin.toFixed(1)}min), cost: $${billing.cost}`, 'system');
    console.log(`[RIDE] Ended: ${ride.scooter_id}, billed: ${billing.billableMin.toFixed(1)}min, paused: ${billing.pausedMin.toFixed(1)}min, cost: $${billing.cost}`);

    res.json({
      ok: true,
      summary: {
        billableMin: Math.round(billing.billableMin * 10) / 10,
        pausedMin: Math.round(billing.pausedMin * 10) / 10,
        cost: billing.cost,
        startBattery: ride.start_battery,
        endBattery: live.battery || 0,
        scooterId: ride.scooter_id,
        remainingBalance: Math.round((updatedRider?.balance || 0) * 100) / 100
      }
    });
  } catch (err) {
    console.error('[RIDE] End error:', err.message);
    res.status(500).json({ error: 'Failed to end ride' });
  }
});

// ==========================================
// ADMIN ENDPOINTS
// ==========================================

// GET /api/admin/riders
app.get('/api/admin/riders', adminAuth, (req, res) => {
  const { kyc, payment } = req.query;
  let riders;
  if (kyc) riders = db.getRidersByKyc(kyc);
  else if (payment) riders = db.getRidersByPayment(payment);
  else riders = db.getAllRiders();

  // Attach active ride info
  riders = riders.map(r => ({
    ...r,
    activeRide: db.getActiveRideByRider(r.id) || null
  }));

  res.json(riders);
});

// PUT /api/admin/rider/:id/kyc
app.put('/api/admin/rider/:id/kyc', adminAuth, (req, res) => {
  const { status } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.updateKyc(req.params.id, status);
  db.audit('kyc_update', `Rider ${req.params.id} KYC ${status}`, 'admin');
  res.json({ ok: true });
});

// PUT /api/admin/rider/:id/payment
app.put('/api/admin/rider/:id/payment', adminAuth, (req, res) => {
  const { status, amount, notes } = req.body;
  if (!['paid', 'unpaid'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const parsedAmount = parseFloat(amount) || 0;

  if (status === 'paid' && parsedAmount > 0) {
    // Add to rider's balance
    db.addBalance(req.params.id, parsedAmount);
    db.createPayment({
      riderId: req.params.id,
      amount: parsedAmount,
      method: 'manual',
      status: 'approved',
      approvedBy: 'admin',
      notes: notes || ''
    });
  } else {
    db.updatePayment(req.params.id, status);
  }

  db.audit('payment_update', `Rider ${req.params.id} payment ${status}${parsedAmount ? ', +$' + parsedAmount.toFixed(2) : ''}`, 'admin');
  const updatedRider = db.getRider(req.params.id);
  res.json({ ok: true, balance: updatedRider?.balance || 0 });
});

// PUT /api/admin/rider/:id/topup — add balance (works mid-ride too)
app.put('/api/admin/rider/:id/topup', adminAuth, (req, res) => {
  const { amount, notes } = req.body;
  const parsedAmount = parseFloat(amount);
  if (!parsedAmount || parsedAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  db.addBalance(req.params.id, parsedAmount);
  db.createPayment({
    riderId: req.params.id, amount: parsedAmount,
    method: 'manual', status: 'approved', approvedBy: 'admin',
    notes: notes || 'Top-up'
  });

  const rider = db.getRider(req.params.id);
  db.audit('topup', `Rider ${req.params.id} topped up +$${parsedAmount.toFixed(2)}, balance: $${(rider?.balance||0).toFixed(2)}`, 'admin');
  res.json({ ok: true, balance: rider?.balance || 0 });
});

// GET /api/admin/rides
app.get('/api/admin/rides', adminAuth, (req, res) => {
  const { status } = req.query;
  if (status === 'active') {
    res.json(db.getAllActiveRides());
  } else {
    res.json(db.getCompletedRides(parseInt(req.query.limit) || 50));
  }
});

// POST /api/admin/ride/:rideId/end — admin force-end a ride
app.post('/api/admin/ride/:rideId/end', adminAuth, (req, res) => {
  const ride = db.getRide(req.params.rideId);
  if (!ride || ride.status !== 'active') return res.status(404).json({ error: 'Active ride not found' });

  const live = fleet[ride.scooter_id] || {};
  const pricing = db.getPricing();

  autoEndRide(ride, live, pricing, 'admin force-end');
  res.json({ ok: true });
});

// GET /api/admin/scooters — registry + live state
app.get('/api/admin/scooters', adminAuth, (req, res) => {
  const scooters = db.getAllScooters();
  const result = scooters.map(s => ({
    ...s,
    live: fleet[s.id] || null,
    online: fleet[s.id] ? (Date.now() - fleet[s.id].lastSeen) < 10000 : false
  }));
  res.json(result);
});

// PUT /api/admin/scooter/:id — update registry
app.put('/api/admin/scooter/:id', adminAuth, (req, res) => {
  const { name, notes, status, speedLimit } = req.body;
  db.ensureScooter(req.params.id);
  db.updateScooter(req.params.id, { name, notes, status, speedLimit });
  db.audit('scooter_update', `${req.params.id} updated`, 'admin');
  res.json({ ok: true });
});

// GET/PUT /api/admin/pricing
app.get('/api/admin/pricing', adminAuth, (req, res) => {
  res.json(db.getPricing());
});
app.put('/api/admin/pricing', adminAuth, (req, res) => {
  const { ratePerMinute, baseFee, currency } = req.body;
  db.updatePricing({ ratePerMinute: parseFloat(ratePerMinute), baseFee: parseFloat(baseFee), currency });
  db.audit('pricing_update', `Rate: ${ratePerMinute}/min, Base: ${baseFee}`, 'admin');
  res.json({ ok: true });
});

// GET /api/admin/audit
app.get('/api/admin/audit', adminAuth, (req, res) => {
  res.json(db.getAuditLog(parseInt(req.query.limit) || 100));
});

// GET /api/admin/rider-photo/:riderId/:type — serve KYC photos
app.get('/api/admin/rider-photo/:riderId/:type', adminAuth, (req, res) => {
  const rider = db.getRider(req.params.riderId);
  if (!rider) return res.status(404).json({ error: 'Rider not found' });

  const filePath = req.params.type === 'selfie' ? rider.selfie_path : rider.id_photo_path;
  if (!filePath) return res.status(404).json({ error: 'Photo not found' });

  res.sendFile(path.resolve(filePath));
});

// ==========================================
// QR CODE GENERATION
// ==========================================

// GET /api/admin/qr/scooter/:id — QR for specific scooter
app.get('/api/admin/qr/scooter/:id', adminAuth, async (req, res) => {
  try {
    const host = req.headers.host;
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const url = `${protocol}://${host}/rider.html?scooter=${req.params.id}`;
    const dataUrl = await QRCode.toDataURL(url, { width: 400, margin: 2 });
    res.json({ qr: dataUrl, url, scooterId: req.params.id });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// GET /api/admin/qr/fleet — fleet-wide QR
app.get('/api/admin/qr/fleet', adminAuth, async (req, res) => {
  try {
    const host = req.headers.host;
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const url = `${protocol}://${host}/rider.html?mode=fleet`;
    const dataUrl = await QRCode.toDataURL(url, { width: 400, margin: 2 });
    res.json({ qr: dataUrl, url });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('=============================');
  console.log('Scooter Fleet Cloud Server running');
  console.log(`Listening on port: ${PORT}`);
  console.log(`Database: data/fleet.db`);
  console.log('=============================');
});

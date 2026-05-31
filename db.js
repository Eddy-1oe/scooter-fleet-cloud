// ==========================================
// DATABASE MODULE — JSON file persistence
// No native dependencies — works on any platform
// ==========================================
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

// Ensure directories exist
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const uploadsDir = path.join(__dirname, 'uploads');
['id_photos', 'selfies'].forEach(sub => {
  const dir = path.join(uploadsDir, sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ==========================================
// JSON STORE
// ==========================================
const DB_PATH = path.join(dataDir, 'fleet.json');

const DEFAULTS = {
  scooters: {},
  riders: {},
  rides: {},
  payments: {},
  pricing: { rate_per_minute: 0.25, base_fee: 1.00, currency: 'USD' },
  audit_log: []
};

let store = loadStore();

function loadStore() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, 'utf8');
      const data = JSON.parse(raw);
      // Merge with defaults for any missing keys
      return { ...DEFAULTS, ...data };
    }
  } catch (e) {
    console.error('[DB] Failed to load, starting fresh:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function save() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.error('[DB] Save error:', e.message);
  }
}

// Debounced save — batches rapid writes
let saveTimer = null;
function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 200);
}

// ==========================================
// EXPORTED API (same interface as SQLite version)
// ==========================================
module.exports = {

  // ── Scooters ──
  ensureScooter(id) {
    if (!store.scooters[id]) {
      store.scooters[id] = { id, name: '', notes: '', status: 'available', speed_limit: null, created_at: Date.now(), updated_at: Date.now() };
      debouncedSave();
    }
  },
  getScooter(id) { return store.scooters[id] || null; },
  getAllScooters() { return Object.values(store.scooters).sort((a, b) => (a.id > b.id ? 1 : -1)); },
  updateScooter(id, { name, notes, status, speedLimit }) {
    this.ensureScooter(id);
    Object.assign(store.scooters[id], { name: name || '', notes: notes || '', status: status || 'available', speed_limit: speedLimit || null, updated_at: Date.now() });
    debouncedSave();
  },
  setScooterStatus(id, status) {
    if (store.scooters[id]) { store.scooters[id].status = status; store.scooters[id].updated_at = Date.now(); debouncedSave(); }
  },

  // ── Riders ──
  createRider({ phone, email, fullName, nationalId, idPhotoPath, selfiePath }) {
    const id = uuidv4();
    store.riders[id] = {
      id, phone, email, full_name: fullName, national_id: nationalId,
      id_photo_path: idPhotoPath || null, selfie_path: selfiePath || null,
      kyc_status: 'pending', payment_status: 'unpaid', balance: 0,
      status: 'registered', created_at: Date.now(), updated_at: Date.now()
    };
    debouncedSave();
    return id;
  },
  getRider(id) { return store.riders[id] || null; },
  getRiderByPhone(phone) { return Object.values(store.riders).find(r => r.phone === phone) || null; },
  getAllRiders() { return Object.values(store.riders).sort((a, b) => b.created_at - a.created_at); },
  getRidersByKyc(status) { return Object.values(store.riders).filter(r => r.kyc_status === status).sort((a, b) => b.created_at - a.created_at); },
  getRidersByPayment(st) { return Object.values(store.riders).filter(r => r.payment_status === st).sort((a, b) => b.created_at - a.created_at); },
  updateKyc(id, status) { if (store.riders[id]) { store.riders[id].kyc_status = status; store.riders[id].updated_at = Date.now(); debouncedSave(); } },
  updatePayment(id, st) { if (store.riders[id]) { store.riders[id].payment_status = st; store.riders[id].updated_at = Date.now(); debouncedSave(); } },
  updateRiderStatus(id, st) { if (store.riders[id]) { store.riders[id].status = st; store.riders[id].updated_at = Date.now(); debouncedSave(); } },
  addBalance(id, amount) {
    if (store.riders[id]) {
      store.riders[id].balance = (store.riders[id].balance || 0) + amount;
      store.riders[id].payment_status = 'paid';
      store.riders[id].updated_at = Date.now();
      debouncedSave();
    }
  },
  deductBalance(id, amount) {
    if (store.riders[id]) {
      store.riders[id].balance = Math.max(0, (store.riders[id].balance || 0) - amount);
      store.riders[id].updated_at = Date.now();
      debouncedSave();
    }
  },

  // ── Rides ──
  createRide({ riderId, scooterId, startBattery }) {
    const id = uuidv4();
    store.rides[id] = {
      id, rider_id: riderId, scooter_id: scooterId,
      start_time: Date.now(), end_time: null,
      duration_min: 0, paused_min: 0, last_poll: null,
      distance_miles: 0, max_speed_mph: 0,
      start_battery: startBattery || 0, end_battery: null,
      cost: 0, status: 'active', created_at: Date.now()
    };
    debouncedSave();
    return id;
  },
  getRide(id) { return store.rides[id] || null; },
  getActiveRideByRider(rid) { return Object.values(store.rides).find(r => r.rider_id === rid && r.status === 'active') || null; },
  getActiveRideByScooter(sid) { return Object.values(store.rides).find(r => r.scooter_id === sid && r.status === 'active') || null; },
  getAllActiveRides() {
    return Object.values(store.rides)
      .filter(r => r.status === 'active')
      .map(r => ({ ...r, rider_name: store.riders[r.rider_id]?.full_name || '—', rider_phone: store.riders[r.rider_id]?.phone || '' }))
      .sort((a, b) => b.start_time - a.start_time);
  },
  endRide(id, { endBattery, durationMin, pausedMin, distanceMiles, maxSpeedMph, cost }) {
    if (store.rides[id]) {
      Object.assign(store.rides[id], {
        end_time: Date.now(), duration_min: durationMin || 0, paused_min: pausedMin || 0,
        distance_miles: distanceMiles || 0, max_speed_mph: maxSpeedMph || 0,
        end_battery: endBattery || 0, cost: cost || 0, status: 'completed'
      });
      debouncedSave();
    }
  },
  addPausedTime(id, minutes) {
    if (store.rides[id]) {
      store.rides[id].paused_min = (store.rides[id].paused_min || 0) + minutes;
      store.rides[id].last_poll = Date.now();
      debouncedSave();
    }
  },
  updateLastPoll(id) {
    if (store.rides[id]) { store.rides[id].last_poll = Date.now(); }
    // No save needed — last_poll is transient
  },
  getCompletedRides(limit = 50) {
    return Object.values(store.rides)
      .filter(r => r.status === 'completed')
      .map(r => ({ ...r, rider_name: store.riders[r.rider_id]?.full_name || '—', rider_phone: store.riders[r.rider_id]?.phone || '' }))
      .sort((a, b) => b.end_time - a.end_time)
      .slice(0, limit);
  },
  getRidesByRider(rid) { return Object.values(store.rides).filter(r => r.rider_id === rid).sort((a, b) => b.start_time - a.start_time); },

  // ── Payments ──
  createPayment({ riderId, amount, currency, method, status, approvedBy, notes }) {
    const id = uuidv4();
    store.payments[id] = {
      id, rider_id: riderId, ride_id: null, amount,
      currency: currency || 'USD', method: method || 'manual',
      status: status || 'pending', approved_by: approvedBy || null,
      approved_at: status === 'approved' ? Date.now() : null,
      notes: notes || '', created_at: Date.now()
    };
    debouncedSave();
    return id;
  },
  getPaymentsByRider(rid) { return Object.values(store.payments).filter(p => p.rider_id === rid).sort((a, b) => b.created_at - a.created_at); },

  // ── Pricing ──
  getPricing() { return store.pricing; },
  updatePricing({ ratePerMinute, baseFee, currency }) {
    store.pricing = { rate_per_minute: ratePerMinute, base_fee: baseFee, currency: currency || 'USD', updated_at: Date.now() };
    debouncedSave();
  },

  // ── Audit Log ──
  audit(action, details, user = 'system') {
    store.audit_log.unshift({ id: store.audit_log.length + 1, action, details, user, created_at: Date.now() });
    if (store.audit_log.length > 500) store.audit_log = store.audit_log.slice(0, 500);
    debouncedSave();
  },
  getAuditLog(limit = 100) { return store.audit_log.slice(0, limit); },

  // Utility
  uuid: uuidv4,
};

console.log('[DB] JSON store loaded from', DB_PATH);

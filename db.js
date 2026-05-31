// ==========================================
// DATABASE MODULE — SQLite via better-sqlite3
// ==========================================
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Ensure upload directories exist
const uploadsDir = path.join(__dirname, 'uploads');
['id_photos', 'selfies'].forEach(sub => {
  const dir = path.join(uploadsDir, sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const db = new Database(path.join(dataDir, 'fleet.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ==========================================
// SCHEMA
// ==========================================
db.exec(`
  CREATE TABLE IF NOT EXISTS scooters (
    id          TEXT PRIMARY KEY,
    name        TEXT DEFAULT '',
    notes       TEXT DEFAULT '',
    status      TEXT DEFAULT 'available',
    speed_limit TEXT DEFAULT NULL,
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000),
    updated_at  INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS riders (
    id              TEXT PRIMARY KEY,
    phone           TEXT NOT NULL,
    email           TEXT NOT NULL,
    full_name       TEXT NOT NULL,
    national_id     TEXT NOT NULL,
    id_photo_path   TEXT DEFAULT NULL,
    selfie_path     TEXT DEFAULT NULL,
    kyc_status      TEXT DEFAULT 'pending',
    payment_status  TEXT DEFAULT 'unpaid',
    status          TEXT DEFAULT 'registered',
    created_at      INTEGER DEFAULT (strftime('%s','now') * 1000),
    updated_at      INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS rides (
    id              TEXT PRIMARY KEY,
    rider_id        TEXT NOT NULL REFERENCES riders(id),
    scooter_id      TEXT NOT NULL,
    start_time      INTEGER NOT NULL,
    end_time        INTEGER DEFAULT NULL,
    duration_min    REAL DEFAULT 0,
    distance_miles  REAL DEFAULT 0,
    max_speed_mph   REAL DEFAULT 0,
    start_battery   REAL DEFAULT 0,
    end_battery     REAL DEFAULT NULL,
    cost            REAL DEFAULT 0,
    status          TEXT DEFAULT 'active',
    created_at      INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id          TEXT PRIMARY KEY,
    rider_id    TEXT NOT NULL REFERENCES riders(id),
    ride_id     TEXT DEFAULT NULL,
    amount      REAL NOT NULL,
    currency    TEXT DEFAULT 'USD',
    method      TEXT DEFAULT 'manual',
    status      TEXT DEFAULT 'pending',
    approved_by TEXT DEFAULT NULL,
    approved_at INTEGER DEFAULT NULL,
    notes       TEXT DEFAULT '',
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS pricing (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    rate_per_minute REAL DEFAULT 0.25,
    base_fee        REAL DEFAULT 1.00,
    currency        TEXT DEFAULT 'USD',
    updated_at      INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    action     TEXT NOT NULL,
    details    TEXT DEFAULT '',
    user       TEXT DEFAULT 'system',
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  -- Seed pricing if empty
  INSERT OR IGNORE INTO pricing (id) VALUES (1);
`);

// ==========================================
// SCOOTER HELPERS
// ==========================================
const stmts = {
  ensureScooter: db.prepare(`INSERT OR IGNORE INTO scooters (id) VALUES (?)`),
  getScooter: db.prepare(`SELECT * FROM scooters WHERE id = ?`),
  getAllScooters: db.prepare(`SELECT * FROM scooters ORDER BY id`),
  updateScooter: db.prepare(`UPDATE scooters SET name=?, notes=?, status=?, speed_limit=?, updated_at=? WHERE id=?`),
  setScooterStatus: db.prepare(`UPDATE scooters SET status=?, updated_at=? WHERE id=?`),

  // RIDER HELPERS
  createRider: db.prepare(`INSERT INTO riders (id, phone, email, full_name, national_id, id_photo_path, selfie_path) VALUES (?,?,?,?,?,?,?)`),
  getRider: db.prepare(`SELECT * FROM riders WHERE id = ?`),
  getRiderByPhone: db.prepare(`SELECT * FROM riders WHERE phone = ?`),
  getAllRiders: db.prepare(`SELECT * FROM riders ORDER BY created_at DESC`),
  getRidersByKyc: db.prepare(`SELECT * FROM riders WHERE kyc_status = ? ORDER BY created_at DESC`),
  getRidersByPayment: db.prepare(`SELECT * FROM riders WHERE payment_status = ? ORDER BY created_at DESC`),
  updateKyc: db.prepare(`UPDATE riders SET kyc_status=?, updated_at=? WHERE id=?`),
  updatePayment: db.prepare(`UPDATE riders SET payment_status=?, updated_at=? WHERE id=?`),
  updateRiderStatus: db.prepare(`UPDATE riders SET status=?, updated_at=? WHERE id=?`),

  // RIDE HELPERS
  createRide: db.prepare(`INSERT INTO rides (id, rider_id, scooter_id, start_time, start_battery) VALUES (?,?,?,?,?)`),
  getRide: db.prepare(`SELECT * FROM rides WHERE id = ?`),
  getActiveRideByRider: db.prepare(`SELECT * FROM rides WHERE rider_id = ? AND status = 'active' LIMIT 1`),
  getActiveRideByScooter: db.prepare(`SELECT * FROM rides WHERE scooter_id = ? AND status = 'active' LIMIT 1`),
  getAllActiveRides: db.prepare(`SELECT r.*, rd.full_name AS rider_name, rd.phone AS rider_phone FROM rides r JOIN riders rd ON r.rider_id = rd.id WHERE r.status = 'active' ORDER BY r.start_time DESC`),
  endRide: db.prepare(`UPDATE rides SET end_time=?, duration_min=?, distance_miles=?, max_speed_mph=?, end_battery=?, cost=?, status='completed' WHERE id=?`),
  getCompletedRides: db.prepare(`SELECT r.*, rd.full_name AS rider_name, rd.phone AS rider_phone FROM rides r JOIN riders rd ON r.rider_id = rd.id WHERE r.status = 'completed' ORDER BY r.end_time DESC LIMIT ?`),
  getRidesByRider: db.prepare(`SELECT * FROM rides WHERE rider_id = ? ORDER BY start_time DESC`),

  // PAYMENT HELPERS
  createPayment: db.prepare(`INSERT INTO payments (id, rider_id, amount, currency, method, status, approved_by, approved_at, notes) VALUES (?,?,?,?,?,?,?,?,?)`),
  getPaymentsByRider: db.prepare(`SELECT * FROM payments WHERE rider_id = ? ORDER BY created_at DESC`),

  // PRICING HELPERS
  getPricing: db.prepare(`SELECT * FROM pricing WHERE id = 1`),
  updatePricing: db.prepare(`UPDATE pricing SET rate_per_minute=?, base_fee=?, currency=?, updated_at=? WHERE id=1`),

  // AUDIT LOG HELPERS
  addAudit: db.prepare(`INSERT INTO audit_log (action, details, user) VALUES (?,?,?)`),
  getAuditLog: db.prepare(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?`),
};

// ==========================================
// EXPORTED API
// ==========================================
module.exports = {
  raw: db,

  // Scooters
  ensureScooter(id)  { return stmts.ensureScooter.run(id); },
  getScooter(id)     { return stmts.getScooter.get(id); },
  getAllScooters()    { return stmts.getAllScooters.all(); },
  updateScooter(id, { name, notes, status, speedLimit }) {
    return stmts.updateScooter.run(name || '', notes || '', status || 'available', speedLimit || null, Date.now(), id);
  },
  setScooterStatus(id, status) { return stmts.setScooterStatus.run(status, Date.now(), id); },

  // Riders
  createRider({ phone, email, fullName, nationalId, idPhotoPath, selfiePath }) {
    const id = uuidv4();
    stmts.createRider.run(id, phone, email, fullName, nationalId, idPhotoPath || null, selfiePath || null);
    return id;
  },
  getRider(id)           { return stmts.getRider.get(id); },
  getRiderByPhone(phone) { return stmts.getRiderByPhone.get(phone); },
  getAllRiders()          { return stmts.getAllRiders.all(); },
  getRidersByKyc(status) { return stmts.getRidersByKyc.all(status); },
  getRidersByPayment(st) { return stmts.getRidersByPayment.all(st); },
  updateKyc(id, status)  { return stmts.updateKyc.run(status, Date.now(), id); },
  updatePayment(id, st)  { return stmts.updatePayment.run(st, Date.now(), id); },
  updateRiderStatus(id, st) { return stmts.updateRiderStatus.run(st, Date.now(), id); },

  // Rides
  createRide({ riderId, scooterId, startBattery }) {
    const id = uuidv4();
    stmts.createRide.run(id, riderId, scooterId, Date.now(), startBattery || 0);
    return id;
  },
  getRide(id)                  { return stmts.getRide.get(id); },
  getActiveRideByRider(rid)    { return stmts.getActiveRideByRider.get(rid); },
  getActiveRideByScooter(sid)  { return stmts.getActiveRideByScooter.get(sid); },
  getAllActiveRides()           { return stmts.getAllActiveRides.all(); },
  endRide(id, { endBattery, durationMin, distanceMiles, maxSpeedMph, cost }) {
    return stmts.endRide.run(Date.now(), durationMin || 0, distanceMiles || 0, maxSpeedMph || 0, endBattery || 0, cost || 0, id);
  },
  getCompletedRides(limit = 50) { return stmts.getCompletedRides.all(limit); },
  getRidesByRider(rid)          { return stmts.getRidesByRider.all(rid); },

  // Payments
  createPayment({ riderId, amount, currency, method, status, approvedBy, notes }) {
    const id = uuidv4();
    stmts.createPayment.run(id, riderId, amount, currency || 'USD', method || 'manual', status || 'pending', approvedBy || null, status === 'approved' ? Date.now() : null, notes || '');
    return id;
  },
  getPaymentsByRider(rid) { return stmts.getPaymentsByRider.all(rid); },

  // Pricing
  getPricing()  { return stmts.getPricing.get(); },
  updatePricing({ ratePerMinute, baseFee, currency }) {
    return stmts.updatePricing.run(ratePerMinute, baseFee, currency || 'USD', Date.now());
  },

  // Audit
  audit(action, details, user = 'system') { return stmts.addAudit.run(action, details, user); },
  getAuditLog(limit = 100) { return stmts.getAuditLog.all(limit); },

  // Utility
  uuid: uuidv4,
};

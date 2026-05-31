const express = require('express');
const app = express();

const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

// ==========================================
// SCOOTER FLEET STATE
// Keyed by scooter ID
// ==========================================
const fleet = {};

// ==========================================
// SCOOTER HISTORY
// Stores historical telemetry for each scooter
// Keyed by scooter ID, value is array of telemetry entries
// ==========================================
const scooterHistory = {};
const MAX_HISTORY_ENTRIES = 100; // Keep last 100 entries per scooter

// ==========================================
// SCOOTER PUSHES TELEMETRY HERE
// POST /telemetry
// Body: JSON with all scooter data
// ==========================================
app.post('/telemetry', (req, res) => {
  const data = req.body;
  if (!data.id) return res.status(400).json({ error: 'Missing scooter ID' });

  fleet[data.id] = {
    ...data,
    lastSeen: Date.now()
  };

  // Store history
  if (!scooterHistory[data.id]) scooterHistory[data.id] = [];
  scooterHistory[data.id].push({
    ...data,
    timestamp: Date.now()
  });

  // Keep only last MAX_HISTORY_ENTRIES
  if (scooterHistory[data.id].length > MAX_HISTORY_ENTRIES) {
    scooterHistory[data.id] = scooterHistory[data.id].slice(-MAX_HISTORY_ENTRIES);
  }

  console.log(`[${data.id}] Battery: ${data.battery}% Speed: ${data.speed} mph Mode: ${data.mode}`);
  res.json({ ok: true });
});

// ==========================================
// APP FETCHES ALL SCOOTER DATA HERE
// GET /fleet
// Returns all scooters and their state
// ==========================================
app.get('/fleet', (req, res) => {
  // Mark scooters offline if not seen for 10 seconds (increased for cloud latency)
  const now = Date.now();
  const result = {};

  Object.keys(fleet).forEach(id => {
    result[id] = {
      ...fleet[id],
      online: (now - fleet[id].lastSeen) < 10000
    };
  });

  res.json(result);
});

// ==========================================
// APP SENDS COMMAND TO SCOOTER HERE
// POST /command/:id
// Body: { action: "brakeOn" }
// ==========================================
const pendingCommands = {};

app.post('/command/:id', (req, res) => {
  const id = req.params.id;
  const action = req.body.action;

  if (!action) return res.status(400).json({ error: 'Missing action' });

  // Queue command for that scooter
  if (!pendingCommands[id]) pendingCommands[id] = [];
  pendingCommands[id].push(action);

  console.log(`[CMD] ${id} → ${action}`);
  res.json({ ok: true });
});

// ==========================================
// SCOOTER POLLS FOR PENDING COMMANDS
// GET /commands/:id
// Returns and clears any pending commands
// ==========================================
app.get('/commands/:id', (req, res) => {
  const id = req.params.id;
  const cmds = pendingCommands[id] || [];
  pendingCommands[id] = []; // clear after sending
  res.json({ commands: cmds });
});

// ==========================================
// APP FETCHES HISTORY FOR A SPECIFIC SCOOTER
// GET /history/:id
// Returns historical telemetry data for a scooter
// ==========================================
app.get('/history/:id', (req, res) => {
  const id = req.params.id;
  const history = scooterHistory[id] || [];
  res.json({ history });
});

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('=============================');
  console.log('Scooter Fleet Cloud Server running');
  console.log(`Listening on port: ${PORT}`);
  console.log('=============================');
});

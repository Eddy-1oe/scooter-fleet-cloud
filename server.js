const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ==========================================
// SCOOTER FLEET STATE
// Keyed by scooter ID
// ==========================================
const fleet = {};

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

  console.log(`[${data.id}] Battery: ${data.battery}% Speed: ${data.speed} mph Mode: ${data.mode}`);
  res.json({ ok: true });
});

// ==========================================
// APP FETCHES ALL SCOOTER DATA HERE
// GET /fleet
// Returns all scooters and their state
// ==========================================
app.get('/fleet', (req, res) => {
  // Mark scooters offline if not seen for 5 seconds
  const now = Date.now();
  const result = {};

  Object.keys(fleet).forEach(id => {
    result[id] = {
      ...fleet[id],
      online: (now - fleet[id].lastSeen) < 5000
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
// HEALTH CHECK (Railway uses this)
// ==========================================
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('=============================');
  console.log('Scooter Fleet Server running');
  console.log(`Open in browser: http://localhost:${PORT}`);
  console.log('=============================');
});

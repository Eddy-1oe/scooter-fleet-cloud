// ============================================================
// Scooter XIAO ESP32-C6 — Pin Test v6
// Manual command tester with multi-variant light timing
// ============================================================
#include <HardwareSerial.h>

// ---- Pin definitions (XIAO ESP32-C6 remapped) ----
#define BRAKE_PIN   D6   // GPIO22 — BC327-25 PNP base, LOW=ON
#define SW_PIN      D5   // GPIO23 — scooter button
#define RX_PIN      D3   // GPIO4  — scooter display UART RX
#define RESET_PIN   D0   // GPIO2  — reset button to GND

#define SCOOTER_BAUD 9600

HardwareSerial ScooterSerial(1);

// ---- Safe delay (keeps FreeRTOS watchdog happy) ----
void safeDelay(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    vTaskDelay(1);
  }
}

// ============================================================
// BRAKE  (BC327-25 PNP — LOW fires it)
// ============================================================
void doBrakeOn() {
  Serial.println("  -> BRAKE ON  (D6=HIGH, optocoupler LED on, brake wires shorted)");
  digitalWrite(BRAKE_PIN, HIGH);
}

void doBrakeOff() {
  Serial.println("  -> BRAKE OFF (D6=LOW, optocoupler LED off, brake open)");
  digitalWrite(BRAKE_PIN, LOW);
}

// ============================================================
// SW helpers
// ============================================================
void swPulse(int ms) {
  digitalWrite(SW_PIN, HIGH);
  safeDelay(ms);
  digitalWrite(SW_PIN, LOW);
}

// Single press — mode cycle
void doSwMode() {
  Serial.println("  -> MODE: single press 100ms");
  swPulse(100);
}

// Light — 6 timing variants for the double-press gap
void doSwLight(int gapMs, int variant) {
  Serial.print("  -> LIGHT v");
  Serial.print(variant);
  Serial.print(": double press, gap=");
  Serial.print(gapMs);
  Serial.println("ms");
  swPulse(100);
  safeDelay(gapMs);
  swPulse(100);
}

// Walk mode — long press + short press
void doSwWalk() {
  Serial.println("  -> WALK: 500ms + 100ms");
  swPulse(500);
  safeDelay(100);
  swPulse(100);
}

// Power toggle — hold 3s
void doSwPower() {
  Serial.println("  -> POWER: hold 3000ms");
  swPulse(3000);
}

// ============================================================
// UART packet decoder
// ============================================================
uint8_t pkt[14];
int     pktIdx  = 0;
bool    inPkt   = false;

float parseVoltage(uint8_t raw)  { return (raw * 0.1f) + 20.0f; }
float parseBattery(uint8_t raw)  {
  float v = parseVoltage(raw);
  float pct = ((v - 32.0f) / 10.0f) * 100.0f;
  if (pct < 0)   pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

const char* parseMode(uint8_t b8, uint8_t b10) {
  if (b10 == 0x06) return "DIAG";
  switch (b8) {
    case 0x00: return "ECO";
    case 0x10: return "D";
    case 0x20: return "S";
    default:   return "?";
  }
}

void printPacket() {
  Serial.print("[PKT] V:");
  Serial.print(parseVoltage(pkt[1]), 1);
  Serial.print("V  Bat:");
  Serial.print((int)parseBattery(pkt[1]));
  Serial.print("%  Spd:");
  Serial.print(pkt[3]);
  Serial.print("  Mode:");
  Serial.print(parseMode(pkt[8], pkt[10]));
  Serial.print("  Brake:");
  Serial.print((pkt[6] == 0xFF) ? "ON " : "OFF");
  Serial.print("  Light:");
  Serial.print((pkt[5] & 0x40) ? "ON " : "OFF");
  Serial.print("  Diag:");
  Serial.println((pkt[10] == 0x06) ? "ON" : "OFF");
}

void processUART() {
  while (ScooterSerial.available()) {
    uint8_t b = ScooterSerial.read();

    if (!inPkt) {
      if (b == 0xA5) {
        pkt[0] = b;
        pktIdx = 1;
        inPkt  = true;
      }
      continue;
    }

    pkt[pktIdx++] = b;

    if (pktIdx == 14) {
      inPkt  = false;
      pktIdx = 0;

      // Loose checksum — also accept 0x01 (scooter quirk)
      uint8_t sum = 0;
      for (int i = 1; i <= 12; i++) sum += pkt[i];
      if (sum == pkt[13] || pkt[13] == 0x01) {
        printPacket();
      } else {
        Serial.print("[PKT] BAD CKSUM exp:0x");
        Serial.print(sum, HEX);
        Serial.print(" got:0x");
        Serial.print(pkt[13], HEX);
        Serial.print("  raw:");
        for (int i = 0; i < 14; i++) {
          if (pkt[i] < 0x10) Serial.print("0");
          Serial.print(pkt[i], HEX);
          Serial.print(" ");
        }
        Serial.println();
      }
    }
  }
}

// ============================================================
// Command interpreter
// ============================================================
void printHelp() {
  Serial.println("----------------------------------------");
  Serial.println("  Commands:");
  Serial.println("  brake_on   — engage brake (BC327-25)");
  Serial.println("  brake_off  — release brake");
  Serial.println("  mode       — single press (mode cycle)");
  Serial.println("  light      — double press, gap=50ms");
  Serial.println("  light2     — double press, gap=30ms");
  Serial.println("  light3     — double press, gap=20ms");
  Serial.println("  light4     — double press, gap=10ms");
  Serial.println("  light5     — double press, gap=5ms");
  Serial.println("  light6     — double press, gap=75ms");
  Serial.println("  walk       — walk mode");
  Serial.println("  power      — power toggle (3s hold)");
  Serial.println("  status     — pin state snapshot");
  Serial.println("  help       — show this list");
  Serial.println("----------------------------------------");
  Serial.println("(set Serial Monitor line ending to Newline)");
}

void doStatus() {
  Serial.println("--- STATUS ---");
  Serial.print("  BRAKE pin (D6): ");
  Serial.println(digitalRead(BRAKE_PIN) == LOW ? "LOW  (brake ON)" : "HIGH (brake OFF)");
  Serial.print("  SW    pin (D5): ");
  Serial.println(digitalRead(SW_PIN) == HIGH ? "HIGH (pressed)" : "LOW  (idle)");
  Serial.print("  RESET pin (D0): ");
  Serial.println(digitalRead(RESET_PIN) == LOW ? "LOW  (pressed)" : "HIGH (normal)");
  Serial.println("--------------");
}

void handleCommand(String cmd) {
  cmd.trim();
  Serial.print("> ");
  Serial.println(cmd);

  if      (cmd == "brake_on")  doBrakeOn();
  else if (cmd == "brake_off") doBrakeOff();
  else if (cmd == "mode")      doSwMode();
  else if (cmd == "light")     doSwLight(50,  1);
  else if (cmd == "light2")    doSwLight(30,  2);
  else if (cmd == "light3")    doSwLight(20,  3);
  else if (cmd == "light4")    doSwLight(10,  4);
  else if (cmd == "light5")    doSwLight(5,   5);
  else if (cmd == "light6")    doSwLight(75,  6);
  else if (cmd == "walk")      doSwWalk();
  else if (cmd == "power")     doSwPower();
  else if (cmd == "status")    doStatus();
  else if (cmd == "help")      printHelp();
  else {
    Serial.print("  Unknown command: ");
    Serial.println(cmd);
    Serial.println("  Type 'help' for command list.");
  }
}

// ============================================================
// SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  safeDelay(1500);

  // Brake pin — optocoupler, LOW = off (safe default at boot)
  pinMode(BRAKE_PIN, OUTPUT);
  digitalWrite(BRAKE_PIN, LOW);

  // SW pin — LOW at rest
  pinMode(SW_PIN, OUTPUT);
  digitalWrite(SW_PIN, LOW);

  // Reset pin — read with internal pull-up
  pinMode(RESET_PIN, INPUT_PULLUP);

  // XIAO ESP32-C6: UART1, RX=D3, no TX needed
  ScooterSerial.begin(SCOOTER_BAUD, SERIAL_8N1, RX_PIN, -1);

  Serial.println("========================================");
  Serial.println("  Scooter C6 Pin Test v6");
  Serial.println("  BRAKE=D6  SW=D5  UART-RX=D3  RST=D0");
  Serial.println("========================================");
  printHelp();
}

// ============================================================
// LOOP
// ============================================================
String inputBuf = "";

void loop() {
  vTaskDelay(1);

  // Serial command input
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (inputBuf.length() > 0) {
        handleCommand(inputBuf);
        inputBuf = "";
      }
    } else {
      inputBuf += c;
    }
  }

  // Live scooter telemetry
  processUART();
}

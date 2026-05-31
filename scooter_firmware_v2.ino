// ============================================================
//  ScooterFleet — XIAO ESP32-C6 Hardware Pin Test v7
//
//  Pin mapping (XIAO ESP32-C6):
//  GPIO0  (RESET) -> D0  INPUT_PULLUP
//  GPIO16 (RX)    -> D3  UART1 RX from scooter display
//  GPIO26 (BRAKE) -> D6  Optocoupler (HIGH=ON, LOW=OFF)
//  GPIO15 (SW)    -> D5  BC337 NPN   (HIGH=ON, LOW=OFF)
//
//  Commands:
//  brake_on     - engage brake
//  brake_off    - release brake
//  mode         - single press 100ms
//  headlight    - toggle head light (double press, gap 50ms)
//  sidelight    - toggle side lights (brake hold + double SW press)
//  walk         - walk mode
//  power        - power hold 3s
//  status       - pin states
//  help         - command list
// ============================================================

#include <HardwareSerial.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Preferences.h>

// ==========================================
// PIN DEFINITIONS — XIAO ESP32-C6
// ==========================================
#define RESET_PIN  D0
#define RX_PIN     D3
#define BRAKE_PIN  D6
#define SW_PIN     D5

#define BRAKE_ON   HIGH
#define BRAKE_OFF  LOW

// ==========================================
// SCOOTER ID
// Change this for each scooter (SCO-001, SCO-002, etc.)
// ==========================================
const char* SCOOTER_ID = "SCO-001";

// ==========================================
// SERVER CONFIG
// Saved to flash — changeable via WiFiManager portal
// Set serverURL to full https:// domain for cloud, or leave blank to use serverIP:serverPort (local)
// ==========================================
Preferences prefs;
String serverURL  = "https://scooter-fleet-cloud-production.up.railway.app";  // Railway deployment URL
String serverIP   = "10.104.13.197";
int    serverPort = 3000;

HardwareSerial ScooterSerial(1);
float smoothedSpeed = 0;

// ==========================================
// SCOOTER DATA STRUCTURE
// ==========================================
struct ScooterData {
  float   battery;
  float   voltage;
  float   speedMph;
  bool    brakeActive;
  bool    isMoving;
  bool    lightOn;
  bool    diagMode;
  String  mode;
  bool    valid;
};

ScooterData scooter;

// ==========================================
// PACKET BUFFER
// ==========================================
static uint8_t pkt[14];
static uint8_t pktIdx   = 0;
static bool    inPacket = false;

// ==========================================
// LOAD SERVER CONFIG FROM FLASH
// ==========================================
void loadServerConfig() {
  prefs.begin("fleet", false);
  serverURL  = prefs.getString("serverURL",  "");
  serverIP   = prefs.getString("serverIP",   "10.104.13.197");
  serverPort = prefs.getInt("serverPort",    3000);
  prefs.end();
  if (serverURL.length() > 0) {
    Serial.print("Server (cloud): ");
    Serial.println(serverURL);
  } else {
    Serial.print("Server (local): http://");
    Serial.print(serverIP);
    Serial.print(":");
    Serial.println(serverPort);
  }
}

void saveServerConfig(String url, String ip, int port) {
  prefs.begin("fleet", false);
  prefs.putString("serverURL",  url);
  prefs.putString("serverIP",   ip);
  prefs.putInt("serverPort",    port);
  prefs.end();
  serverURL  = url;
  serverIP   = ip;
  serverPort = port;
  Serial.println("Server config saved");
}

// ==========================================
// safeDelay
// ==========================================
void safeDelay(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    vTaskDelay(1);
  }
}

// ==========================================
// Brake
// ==========================================
void doBrakeOn() {
  digitalWrite(BRAKE_PIN, BRAKE_ON);
  Serial.println("  -> BRAKE ON  (D6=HIGH)");
}

void doBrakeOff() {
  digitalWrite(BRAKE_PIN, BRAKE_OFF);
  Serial.println("  -> BRAKE OFF (D6=LOW)");
}

// ==========================================
// SW mode
// ==========================================
void doSwMode() {
  Serial.println("  -> MODE: single press 100ms");
  digitalWrite(SW_PIN, HIGH);
  safeDelay(100);
  digitalWrite(SW_PIN, LOW);
  Serial.println("  -> done");
}

// ==========================================
// Head light — double press, 50ms gap
// ============================================
void doHeadLight() {
  Serial.println("  -> HEADLIGHT: double press gap=50ms");
  digitalWrite(SW_PIN, HIGH);
  safeDelay(100);
  digitalWrite(SW_PIN, LOW);
  safeDelay(50);
  digitalWrite(SW_PIN, HIGH);
  safeDelay(100);
  digitalWrite(SW_PIN, LOW);
  Serial.println("  -> done — check [PKT] Light field");
}

// ==========================================
// Side lights — brake hold + double SW press
// ==========================================
void doSideLight() {
  Serial.println("  -> SIDELIGHT: brake hold + double SW press");
  digitalWrite(BRAKE_PIN, BRAKE_ON);
  safeDelay(500);
  digitalWrite(SW_PIN, HIGH);
  safeDelay(100);
  digitalWrite(SW_PIN, LOW);
  safeDelay(200);                     // longer gap between presses
  digitalWrite(SW_PIN, HIGH);
  safeDelay(100);
  digitalWrite(SW_PIN, LOW);
  safeDelay(500);
  digitalWrite(BRAKE_PIN, BRAKE_OFF);
  Serial.println("  -> done");
}

void doAlarm() {
  Serial.println("  -> ALARM: brake on, power off, power on");
  digitalWrite(BRAKE_PIN, BRAKE_ON);
  safeDelay(500);
  digitalWrite(SW_PIN, HIGH);  // power off
  safeDelay(3000);
  digitalWrite(SW_PIN, LOW);
  safeDelay(1000);
  digitalWrite(SW_PIN, HIGH);  // power on
  safeDelay(1000);
  digitalWrite(SW_PIN, LOW);
  safeDelay(500);
  digitalWrite(BRAKE_PIN, BRAKE_OFF);
  Serial.println("  -> done");
}

// ==========================================
// Walk + Power
// ==========================================
void doSwWalk() {
  Serial.println("  -> WALK: 500ms + 100ms");
  digitalWrite(SW_PIN, HIGH);
  safeDelay(500);
  digitalWrite(SW_PIN, LOW);
  safeDelay(100);
  digitalWrite(SW_PIN, HIGH);
  safeDelay(100);
  digitalWrite(SW_PIN, LOW);
  Serial.println("  -> done");
}

void doMetric() {
  Serial.println("  -> METRIC: triple press");
  digitalWrite(SW_PIN, HIGH); safeDelay(100);
  digitalWrite(SW_PIN, LOW);  safeDelay(50);
  digitalWrite(SW_PIN, HIGH); safeDelay(100);
  digitalWrite(SW_PIN, LOW);  safeDelay(50);
  digitalWrite(SW_PIN, HIGH); safeDelay(100);
  digitalWrite(SW_PIN, LOW);
  Serial.println("  -> done");
}

void doCruise() {
  Serial.println("  -> CRUISE: quadruple press");
  digitalWrite(SW_PIN, HIGH); safeDelay(100);
  digitalWrite(SW_PIN, LOW);  safeDelay(50);
  digitalWrite(SW_PIN, HIGH); safeDelay(100);
  digitalWrite(SW_PIN, LOW);  safeDelay(50);
  digitalWrite(SW_PIN, HIGH); safeDelay(100);
  digitalWrite(SW_PIN, LOW);  safeDelay(50);
  digitalWrite(SW_PIN, HIGH); safeDelay(100);
  digitalWrite(SW_PIN, LOW);
  Serial.println("  -> done");
}

void doAlarmOff() {
  Serial.println("  -> ALARM OFF: brake off, power off, power on");
  digitalWrite(BRAKE_PIN, BRAKE_OFF);
  safeDelay(500);
  digitalWrite(SW_PIN, HIGH);  // power off
  safeDelay(3000);
  digitalWrite(SW_PIN, LOW);
  safeDelay(1000);
  digitalWrite(SW_PIN, HIGH);  // power on
  safeDelay(1000);
  digitalWrite(SW_PIN, LOW);
  Serial.println("  -> done");
}

void doZeroStart() {
  Serial.println("  -> ZEROSTART: quintuple press");
  digitalWrite(SW_PIN, HIGH); safeDelay(100);
  digitalWrite(SW_PIN, LOW);  safeDelay(50);
  digitalWrite(SW_PIN, HIGH); safeDelay(100);
  digitalWrite(SW_PIN, LOW);  safeDelay(50);
  digitalWrite(SW_PIN, HIGH); safeDelay(100);
  digitalWrite(SW_PIN, LOW);  safeDelay(50);
  digitalWrite(SW_PIN, HIGH); safeDelay(100);
  digitalWrite(SW_PIN, LOW);  safeDelay(50);
  digitalWrite(SW_PIN, HIGH); safeDelay(100);
  digitalWrite(SW_PIN, LOW);
  Serial.println("  -> done");
}

void doSwPower() {
  Serial.println("  -> POWER: 3s hold");
  Serial.println("     holding...");
  digitalWrite(SW_PIN, HIGH);
  safeDelay(3000);
  digitalWrite(SW_PIN, LOW);
  Serial.println("  -> done");
}

// ==========================================
// Status + Help
// ==========================================
void printStatus() {
  Serial.println("\n--- Pin Status ---");
  Serial.print("  BRAKE D6: ");
  Serial.println(digitalRead(BRAKE_PIN) == HIGH ? "HIGH (brake ON)" : "LOW  (brake OFF)");
  Serial.print("  SW    D5: ");
  Serial.println(digitalRead(SW_PIN) == HIGH ? "HIGH (active)" : "LOW  (idle)");
  Serial.print("  RESET D0: ");
  Serial.println(digitalRead(RESET_PIN) == LOW ? "LOW  (pressed)" : "HIGH (not pressed)");
  Serial.println("-----------------");
}

void printHelp() {
  Serial.println("\n--- Commands ---");
  Serial.println("  brake_on   engage brake");
  Serial.println("  brake_off  release brake");
  Serial.println("  mode       single press 100ms");
  Serial.println("  headlight  toggle head light");
  Serial.println("  sidelight  toggle side lights");
  Serial.println("  walk       walk mode");
  Serial.println("  power      power hold 3s");
  Serial.println("  metric     switch metric/imperial");
  Serial.println("  cruise     toggle cruise control");
  Serial.println("  alarm      brake on + power off + power on");
  Serial.println("  alarmoff   alarm off");
  Serial.println("  zerostart  toggle zero/non-zero start");
  Serial.println("  status     pin states");
  Serial.println("  help       this list");
  Serial.println("----------------");
}

// ==========================================
// Packet decoder
// ==========================================
void processUART() {
  while (ScooterSerial.available()) {
    uint8_t b = ScooterSerial.read();

    if (b == 0xA5) {
      inPacket = true;
      pktIdx   = 0;
    }

    if (!inPacket) continue;

    pkt[pktIdx++] = b;

    if (pktIdx == 14) {
      uint8_t sum = 0;
      for (int i = 1; i <= 12; i++) sum += pkt[i];

      if (sum == pkt[13] || pkt[13] == 0x01) {
        float   voltage = (pkt[1] * 0.1f) + 20.0f;
        int     rawSpd  = pkt[3];
        bool    light   = (pkt[5] & 0x40) != 0;
        bool    brake   = (pkt[6] == 0xFF);
        uint8_t modeB   = pkt[8];
        bool    diag    = (pkt[10] == 0x06);
        int     bat     = constrain((int)((voltage - 32.0f) / 10.0f * 100.0f), 0, 100);

        String mode = "UNKNOWN";
        if      (diag)          mode = "DIAG";
        else if (modeB == 0x00) mode = "ECO";
        else if (modeB == 0x10) mode = "D";
        else if (modeB == 0x20) mode = "S";

        // Update scooter data structure
        scooter.voltage     = voltage;
        scooter.battery     = bat;
        scooter.speedMph    = rawSpd;
        scooter.isMoving    = (rawSpd > 0);
        scooter.lightOn     = light;
        scooter.brakeActive = brake;
        scooter.mode        = mode;
        scooter.diagMode    = diag;
        scooter.valid       = true;

        Serial.print("[PKT] V:");  Serial.print(voltage, 1);
        Serial.print("V Bat:");    Serial.print(bat);
        Serial.print("% Spd:");    Serial.print(rawSpd);
        Serial.print(" Mode:");    Serial.print(mode);
        Serial.print(" Brake:");   Serial.print(brake ? "ON " : "OFF");
        Serial.print(" Light:");   Serial.print(light ? "ON " : "OFF");
        Serial.print(" Diag:");    Serial.println(diag ? "ON" : "OFF");
      } else {
        Serial.print("[PKT] BAD CHECKSUM (got:0x");
        Serial.print(pkt[13], HEX);
        Serial.print(" exp:0x");
        Serial.print(sum, HEX);
        Serial.print(") raw: ");
        for (int i = 0; i < 14; i++) {
          if (pkt[i] < 0x10) Serial.print("0");
          Serial.print(pkt[i], HEX);
          Serial.print(" ");
        }
        Serial.println();
      }

      inPacket = false;
      pktIdx   = 0;
    }
  }
}

// ==========================================
// EXECUTE COMMAND (from server)
// ==========================================
void executeCommand(String action) {
  Serial.print("[CMD] ");
  Serial.println(action);
  if      (action == "brake_on")  doBrakeOn();
  else if (action == "brake_off") doBrakeOff();
  else if (action == "mode")      doSwMode();
  else if (action == "headlight") doHeadLight();
  else if (action == "sidelight") doSideLight();
  else if (action == "walk")      doSwWalk();
  else if (action == "metric")    doMetric();
  else if (action == "cruise")    doCruise();
  else if (action == "alarm")     doAlarm();
  else if (action == "alarmoff")  doAlarmOff();
  else if (action == "zerostart") doZeroStart();
  else if (action == "power")     doSwPower();
}

// ==========================================
// URL BUILDER + HTTP HELPER
// ==========================================
String buildURL(String path) {
  if (serverURL.length() > 0)
    return serverURL + path;
  return "http://" + serverIP + ":" + String(serverPort) + path;
}

bool isCloud() { return serverURL.startsWith("https://"); }

// Begin an HTTPClient against the right scheme
void httpBegin(HTTPClient& http, WiFiClientSecure& secure, String url) {
  if (isCloud()) {
    secure.setInsecure();  // skip cert validation — Railway uses valid certs but avoids storing them in flash
    http.begin(secure, url);
  } else {
    http.begin(url);
  }
}

// ==========================================
// PUSH TELEMETRY TO SERVER
// ==========================================
unsigned long lastPush = 0;

void pushTelemetry() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[PUSH] WiFi not connected");
    return;
  }
  if (millis() - lastPush < 1000) return;
  lastPush = millis();

  String url = buildURL("/telemetry");
  Serial.print("[PUSH] URL: ");
  Serial.println(url);

  Serial.print("[PUSH] Scooter valid: ");
  Serial.println(scooter.valid);
  Serial.print("[PUSH] Battery: ");
  Serial.println(scooter.battery);
  Serial.print("[PUSH] Voltage: ");
  Serial.println(scooter.voltage);

  WiFiClientSecure secure;
  HTTPClient http;
  httpBegin(http, secure, url);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<256> doc;
  doc["id"]      = SCOOTER_ID;
  doc["battery"] = scooter.battery;
  doc["voltage"] = scooter.voltage;
  doc["speed"]   = scooter.speedMph;
  doc["moving"]  = scooter.isMoving;
  doc["mode"]    = scooter.mode;
  doc["brake"]   = scooter.brakeActive;
  doc["light"]   = scooter.lightOn;
  doc["diag"]    = scooter.diagMode;

  String body;
  serializeJson(doc, body);

  Serial.print("[PUSH] Body: ");
  Serial.println(body);

  int code = http.POST(body);
  http.end();

  if (code != 200) {
    Serial.print("[PUSH] Failed: ");
    Serial.println(code);
  } else {
    Serial.println("[PUSH] Success");
  }
}

// ==========================================
// POLL COMMANDS FROM SERVER
// ==========================================
unsigned long lastPoll = 0;

void pollCommands() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastPoll < 1000) return;
  lastPoll = millis();

  WiFiClientSecure secure;
  HTTPClient http;
  httpBegin(http, secure, buildURL("/commands/" + String(SCOOTER_ID)));

  int code = http.GET();
  if (code == 200) {
    String payload = http.getString();
    StaticJsonDocument<256> doc;
    deserializeJson(doc, payload);
    JsonArray cmds = doc["commands"];
    for (String cmd : cmds) {
      executeCommand(cmd);
    }
  }
  http.end();
}

// ==========================================
// RECONNECT WIFI IF DROPPED
// ==========================================
unsigned long lastWifiCheck = 0;

void maintainWifi() {
  if (millis() - lastWifiCheck < 10000) return;
  lastWifiCheck = millis();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi dropped — reconnecting...");
    WiFi.reconnect();
  }
}

// ==========================================
// PACKET BUFFER
// ==========================================
byte packetBuf[14];
int  bufIndex  = 0;
unsigned long lastByte = 0;

// ==========================================
// SETUP
// ==========================================
void setup() {
  Serial.begin(115200);
  safeDelay(1500);

  pinMode(BRAKE_PIN, OUTPUT);
  pinMode(SW_PIN,    OUTPUT);
  pinMode(RESET_PIN, INPUT_PULLUP);

  digitalWrite(BRAKE_PIN, BRAKE_OFF);
  digitalWrite(SW_PIN,    LOW);

  ScooterSerial.begin(9600, SERIAL_8N1, RX_PIN, -1);

  // Load server IP from flash
  loadServerConfig();

  // WiFiManager — auto connects or starts hotspot
  WiFiManager wm;
  wm.setConfigPortalTimeout(180); // hotspot times out after 3 minutes

  // Custom fields on setup page — cloud URL takes priority over IP:port
  WiFiManagerParameter serverURLParam("serverurl", "Cloud URL (e.g. https://xxx.up.railway.app)", serverURL.c_str(), 80);
  WiFiManagerParameter serverIPParam("serverip", "Local Server IP (ignored if Cloud URL set)", serverIP.c_str(), 40);
  WiFiManagerParameter serverPortParam("serverport", "Local Server Port", String(serverPort).c_str(), 6);
  wm.addParameter(&serverURLParam);
  wm.addParameter(&serverIPParam);
  wm.addParameter(&serverPortParam);

  // Hotspot name includes scooter ID
  String apName = "Scooter-" + String(SCOOTER_ID);

  Serial.print("Connecting to WiFi via WiFiManager...");
  bool connected = wm.autoConnect(apName.c_str(), "scooter123");

  if (!connected) {
    Serial.println("Failed to connect. Restarting...");
    delay(3000);
    ESP.restart();
  }

  // Save server config if changed on setup page
  String newURL  = String(serverURLParam.getValue());
  String newIP   = String(serverIPParam.getValue());
  int    newPort = String(serverPortParam.getValue()).toInt();
  newURL.trim();
  if (newURL != serverURL || newIP != serverIP || (newPort > 0 && newPort != serverPort)) {
    saveServerConfig(newURL, newIP, newPort > 0 ? newPort : 3000);
  }

  Serial.println();
  Serial.print("WiFi connected. IP: ");
  Serial.println(WiFi.localIP());

  Serial.println("\n========================================");
  Serial.println("  ScooterFleet C6 v2 with WiFiManager");
  Serial.println("========================================");
  printHelp();
  printStatus();
  Serial.println("\nReady. Type a command and press Enter.\n");
}

// ==========================================
// MAIN LOOP
// ==========================================
void loop() {
  vTaskDelay(1);

  static String cmdBuffer = "";

  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      cmdBuffer.trim();
      if (cmdBuffer.length() > 0) {
        Serial.print("\n> ");
        Serial.println(cmdBuffer);

        if      (cmdBuffer == "brake_on")  doBrakeOn();
        else if (cmdBuffer == "brake_off") doBrakeOff();
        else if (cmdBuffer == "mode")      doSwMode();
        else if (cmdBuffer == "headlight") doHeadLight();
        else if (cmdBuffer == "sidelight") doSideLight();
        else if (cmdBuffer == "walk")      doSwWalk();
        else if (cmdBuffer == "metric")    doMetric();
        else if (cmdBuffer == "cruise")    doCruise();
        else if (cmdBuffer == "alarm")     doAlarm();
        else if (cmdBuffer == "alarmoff") doAlarmOff();
        else if (cmdBuffer == "zerostart") doZeroStart();
        else if (cmdBuffer == "power")     doSwPower();
        else if (cmdBuffer == "status")    printStatus();
        else if (cmdBuffer == "help")      printHelp();
        else {
          Serial.print("  Unknown: ");
          Serial.println(cmdBuffer);
          Serial.println("  Type 'help' for commands.");
        }
      }
      cmdBuffer = "";
    } else {
      cmdBuffer += c;
    }
  }

  processUART();
  pushTelemetry();
  pollCommands();
  maintainWifi();

  static unsigned long resetStart = 0;
  static bool resetArmed = false;

  if (digitalRead(RESET_PIN) == LOW) {
    if (!resetArmed) {
      resetArmed = true;
      resetStart = millis();
      Serial.println("[RESET] D0 held — hold 3s to wipe WiFi...");
    } else if (millis() - resetStart >= 3000) {
      Serial.println("[RESET] 3s confirmed.");
      WiFiManager wm;
      wm.resetSettings();
      Serial.println("WiFi credentials cleared. Restarting...");
      resetArmed = false;
      safeDelay(2000);
      ESP.restart();
    }
  } else {
    if (resetArmed) Serial.println("[RESET] released early — no action.");
    resetArmed = false;
  }
}

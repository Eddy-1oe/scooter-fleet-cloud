#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include <HardwareSerial.h>
#include <SoftwareSerial.h>
#include <TinyGPS++.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <Preferences.h>

// ==========================================
// PIN DEFINITIONS — ESP32 WROOM
// ==========================================
#define RX_PIN          16
#define CONTROLLER_BAUD 9600
#define SW_PIN          15
#define OPTO_PIN        26
#define RESET_PIN       0     // GPIO0 — reset button to GND

// GPS (NEO-7M) via SoftwareSerial
// GPS TX → ESP32 D14 (our RX), GPS RX → ESP32 D13 (our TX)
#define GPS_RX_PIN      14
#define GPS_TX_PIN      13
#define GPS_BAUD        9600

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

HardwareSerial ctrlSerial(1);
SoftwareSerial  gpsSerial(GPS_RX_PIN, GPS_TX_PIN);
TinyGPSPlus     gps;
float smoothedSpeed = 0;

// ==========================================
// SCOOTER DATA STRUCTURE
// ==========================================
struct GpsData {
  bool    valid;
  double  latitude;
  double  longitude;
  float   altitudeM;
  float   speedKph;
  float   headingDeg;
  uint8_t satellites;
  float   hdop;
  char    timestamp[21];  // "YYYY-MM-DDTHH:MM:SSZ\0"
};

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
  GpsData gps;
};

ScooterData scooter;

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
// CHECK RESET BUTTON
// Hold GPIO0 LOW for 3 seconds on boot to clear WiFi credentials
// ==========================================
void checkResetButton() {
  pinMode(RESET_PIN, INPUT_PULLUP);
  Serial.println("Hold reset button to clear WiFi credentials...");
  delay(100);

  int held = 0;
  while (digitalRead(RESET_PIN) == LOW) {
    delay(100);
    held += 100;
    Serial.print(".");
    if (held >= 3000) {
      Serial.println();
      Serial.println("Clearing WiFi credentials...");
      WiFiManager wm;
      wm.resetSettings();
      Serial.println("Cleared. Restarting...");
      delay(500);
      ESP.restart();
    }
  }
  Serial.println();
}

// ==========================================
// SPEED CALCULATION
// ==========================================
float calculateSpeed(byte b3, byte modeByte, byte diagByte) {
  float maxMph = 16.0;
  if (diagByte == 0x06)      maxMph = 4.0;
  else if (modeByte == 0x00) maxMph = 9.0;
  else if (modeByte == 0x10) maxMph = 12.0;
  else if (modeByte == 0x20) maxMph = 16.0;

  float x = (float)b3 / 16.0;
  float curve = pow(x, 0.55);
  float mph = constrain(curve * maxMph, 0, maxMph);
  mph = round(mph);
  smoothedSpeed = (smoothedSpeed * 0.3) + (mph * 0.7);
  return smoothedSpeed;
}

// ==========================================
// PACKET PARSER
// ==========================================
float parseVoltage(byte raw) { return (raw * 0.1) + 20.0; }

float parseBattery(byte raw) {
  float v = parseVoltage(raw);
  return constrain(((v - 32.0) / 10.0) * 100.0, 0, 100);
}

String parseMode(byte b8, byte b10) {
  if (b10 == 0x06) return "DIAG";
  switch (b8) {
    case 0x00: return "ECO";
    case 0x10: return "D";
    case 0x20: return "S";
    default:   return "UNKNOWN";
  }
}

bool verifyChecksum(byte* pkt) {
  byte sum = 0;
  for (int i = 1; i <= 12; i++) sum += pkt[i];
  return (sum == pkt[13]);
}

void parsePacket(byte* pkt) {
  scooter.battery     = parseBattery(pkt[1]);
  scooter.voltage     = parseVoltage(pkt[1]);
  scooter.speedMph    = calculateSpeed(pkt[3], pkt[8], pkt[10]);
  scooter.isMoving    = (pkt[3] > 0);
  scooter.lightOn     = (pkt[5] & 0x40) != 0;
  scooter.brakeActive = (pkt[6] == 0xFF);
  scooter.mode        = parseMode(pkt[8], pkt[10]);
  scooter.diagMode    = (pkt[10] == 0x06);
  scooter.valid       = true;
}

// ==========================================
// SW CONTROL
// ==========================================
void sw_pulse(int duration) {
  pinMode(SW_PIN, OUTPUT);
  digitalWrite(SW_PIN, HIGH);
  delay(duration);
  digitalWrite(SW_PIN, LOW);
  pinMode(SW_PIN, INPUT);
}

void sw_powerToggle() {
  pinMode(SW_PIN, OUTPUT);
  digitalWrite(SW_PIN, HIGH);
  delay(3000);
  digitalWrite(SW_PIN, LOW);
  pinMode(SW_PIN, INPUT);
}

void sw_cycleMode()   { sw_pulse(100); }
void sw_toggleLight() { sw_pulse(100); delay(100); sw_pulse(100); }
void sw_walkMode()    { sw_pulse(500); delay(100); sw_pulse(100); }

// ==========================================
// BRAKE CONTROL
// ==========================================
void brakeOn()  { digitalWrite(OPTO_PIN, HIGH); }
void brakeOff() { digitalWrite(OPTO_PIN, LOW);  }

// ==========================================
// EXECUTE COMMAND
// ==========================================
void executeCommand(String action) {
  Serial.print("[CMD] ");
  Serial.println(action);
  if      (action == "power")    sw_powerToggle();
  else if (action == "mode")     sw_cycleMode();
  else if (action == "light")    sw_toggleLight();
  else if (action == "walk")     sw_walkMode();
  else if (action == "brakeOn")  brakeOn();
  else if (action == "brakeOff") brakeOff();
}

// ==========================================
// GPS READING
// ==========================================
void readGPS() {
  while (gpsSerial.available()) {
    char c = gpsSerial.read();
    gps.encode(c);
  }

  if (gps.location.isValid()) {
    scooter.gps.valid     = true;
    scooter.gps.latitude  = gps.location.lat();
    scooter.gps.longitude = gps.location.lng();
  }
  if (gps.altitude.isValid())
    scooter.gps.altitudeM  = gps.altitude.meters();
  if (gps.speed.isValid())
    scooter.gps.speedKph   = gps.speed.kmph();
  if (gps.course.isValid())
    scooter.gps.headingDeg = gps.course.deg();
  if (gps.satellites.isValid())
    scooter.gps.satellites = gps.satellites.value();
  if (gps.hdop.isValid())
    scooter.gps.hdop       = gps.hdop.hdop();
  if (gps.date.isValid() && gps.time.isValid()) {
    snprintf(scooter.gps.timestamp, sizeof(scooter.gps.timestamp),
             "%04u-%02u-%02uT%02u:%02u:%02uZ",
             gps.date.year(), gps.date.month(),  gps.date.day(),
             gps.time.hour(), gps.time.minute(), gps.time.second());
  }

  if (millis() > 10000 && gps.charsProcessed() < 10) {
    Serial.println("[GPS] No data — check wiring: TX->D14, RX->D13");
  }
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
  if (WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastPush < 1000) return;
  lastPush = millis();

  WiFiClientSecure secure;
  HTTPClient http;
  httpBegin(http, secure, buildURL("/telemetry"));
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<512> doc;
  doc["id"]      = SCOOTER_ID;
  doc["battery"] = scooter.battery;
  doc["voltage"] = scooter.voltage;
  doc["speed"]   = scooter.speedMph;
  doc["moving"]  = scooter.isMoving;
  doc["mode"]    = scooter.mode;
  doc["brake"]   = scooter.brakeActive;
  doc["light"]   = scooter.lightOn;
  doc["diag"]    = scooter.diagMode;

  JsonObject g = doc.createNestedObject("gps");
  g["valid"] = scooter.gps.valid;
  if (scooter.gps.valid) {
    g["lat"]        = serialized(String(scooter.gps.latitude,  6));
    g["lng"]        = serialized(String(scooter.gps.longitude, 6));
    g["alt"]        = scooter.gps.altitudeM;
    g["speed_kph"]  = scooter.gps.speedKph;
    g["heading"]    = scooter.gps.headingDeg;
    g["satellites"] = scooter.gps.satellites;
    g["hdop"]       = scooter.gps.hdop;
    if (scooter.gps.timestamp[0] != '\0')
      g["utc"] = scooter.gps.timestamp;
  }

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  http.end();

  if (code != 200) {
    Serial.print("Push failed: ");
    Serial.println(code);
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
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);  // GPS current spike triggers brownout on weak USB
  Serial.begin(115200);
  delay(1500);

  pinMode(OPTO_PIN, OUTPUT);
  digitalWrite(OPTO_PIN, LOW);
  pinMode(SW_PIN, INPUT);

  // Check if reset button held
  checkResetButton();

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
  // Using a password for the setup portal
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

  ctrlSerial.begin(CONTROLLER_BAUD, SERIAL_8N1, RX_PIN, -1);

  gpsSerial.begin(GPS_BAUD);
  memset(&scooter.gps, 0, sizeof(scooter.gps));
  Serial.println("GPS serial started on D14/D13");

  Serial.print("=== Scooter ");
  Serial.print(SCOOTER_ID);
  Serial.println(" ready ===");
}

// ==========================================
// MAIN LOOP
// ==========================================
void loop() {
  // Read display TX
  while (ctrlSerial.available()) {
    byte b = ctrlSerial.read();
    lastByte = millis();

    if (b == 0xA5 && bufIndex == 0) {
      packetBuf[0] = b;
      bufIndex = 1;
    }
    else if (bufIndex > 0 && bufIndex < 14) {
      packetBuf[bufIndex++] = b;
      if (bufIndex == 14) {
        if (verifyChecksum(packetBuf)) {
          parsePacket(packetBuf);
        } else {
          Serial.println("Bad packet");
        }
        bufIndex = 0;
      }
    }
  }

  if (bufIndex > 0 && millis() - lastByte > 500) {
    bufIndex = 0;
    smoothedSpeed = 0;
  }

  readGPS();
  pushTelemetry();
  pollCommands();
  maintainWifi();
}

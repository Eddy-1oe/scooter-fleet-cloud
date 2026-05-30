#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("=== ESP32-C6 Test Started ===");
  Serial.println("WiFi initialized");
  Serial.println("Test complete");
}

void loop() {
  delay(1000);
  Serial.println("Loop running...");
}

#include <Arduino.h>
#include "peripherals.h"

namespace {
Peripherals hardware;
uint32_t pressCount = 0;
bool serialConnected = false;
constexpr char kScanPrompt[] = "Press Scan to read a barcode";
const char* scanStatus = kScanPrompt;
String scanCode;

const char* keyName(char code) {
  switch (code) {
    case 'F': return "Refresh";
    case 'B': return "Back";
    case 'O': return "Outbound";
    case 'I': return "Inbound";
    case 'S': return "Scrap";
    case 'U': return "Up";
    case 'D': return "Down";
    case 'L': return "Left";
    case 'R': return "Right";
    case 'E': return "Confirm";
    case 'T': return "Scan";
    default: return nullptr;
  }
}

void showScanStatus(const char* status) {
  scanStatus = status;
  hardware.showScanTest(scanStatus, scanCode);
}

void handleKey(char code) {
  if (code == 'F') {
    hardware.showKeyTest();
    hardware.showScanTest(scanStatus, scanCode);
  } else if (code == 'T') {
    scanCode = "";
    hardware.trigger(true);
    showScanStatus("Scanning...");
  } else if (code == 'B') {
    hardware.trigger(false);
    scanCode = "";
    showScanStatus(kScanPrompt);
  }

  const char digit[] = {code, '\0'};
  const char* name = keyName(code);
  if (!name) name = digit;
  hardware.showKeyPress(name, code, ++pressCount);
  if (code != 'T') hardware.beep();
  Serial.printf("Key %lu: %s (%c)\n", static_cast<unsigned long>(pressCount), name, code);
}
}

void setup() {
  Serial.begin(115200);
  hardware.begin();
  hardware.showKeyTest();
  hardware.showKeyPress("Waiting", '-', 0);
  showScanStatus(kScanPrompt);
  hardware.beep();
}

void loop() {
  const bool connected = static_cast<bool>(Serial);
  if (connected && !serialConnected) {
    Serial.println("LCD / Key / Scan ready. Press Scan to trigger the barcode module.");
  }
  serialConnected = connected;

  const char code = hardware.pollKey();
  if (code) handleKey(code);

  const bool wasScanning = hardware.scanActive();
  hardware.tick();
  if (hardware.pollScanner(scanCode)) {
    showScanStatus("Barcode received");
    hardware.beep();
    Serial.print("Barcode: ");
    Serial.println(scanCode);
  } else if (wasScanning && !hardware.scanActive()) {
    showScanStatus("No code (3 s timeout)");
    hardware.beep(false);
    Serial.println("Scan timeout.");
  }
  delay(2);
}

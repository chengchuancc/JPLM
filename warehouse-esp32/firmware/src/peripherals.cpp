#include "peripherals.h"
#include "board_pins.h"
#include "settings.h"

void Peripherals::begin() {
  digitalWrite(pins::scannerPower, HIGH);
  pinMode(pins::scannerPower, OUTPUT);
  pinMode(pins::scannerTrigger, INPUT); // release while module is unpowered
  for (auto p : pins::rows) pinMode(p, INPUT_PULLUP);
  for (auto p : pins::cols) pinMode(p, INPUT); // unselected columns are high impedance
  pinMode(pins::scan, INPUT_PULLUP);
  ledcSetup(0, 2300, 8);
  ledcAttachPin(pins::buzzer, 0);
  ledcWrite(0, 0);
  analogReadResolution(12);
  analogSetPinAttenuation(pins::battery, ADC_11db);
  display_.init();
  display_.setTextWrap(true);
  scannerPower(true);
}

void Peripherals::scannerPower(bool on) {
  if (powered_ == on) return;
  if (!on) {
    trigger(false);
    scanner_.end();
    pinMode(pins::uartTx, INPUT);
    pinMode(pins::uartRx, INPUT);
    pinMode(pins::scannerTrigger, INPUT);
    digitalWrite(pins::scannerPower, HIGH);
  } else {
    digitalWrite(pins::scannerPower, LOW);
    delay(500); // module power-on settling; no trigger commands sent implicitly
    scanner_.begin(TERMINAL_SCANNER_BAUD, SERIAL_8N1, pins::uartRx, pins::uartTx);
    digitalWrite(pins::scannerTrigger, HIGH);
    pinMode(pins::scannerTrigger, OUTPUT_OPEN_DRAIN);
  }
  powered_ = on;
  frame_.reset();
}

void Peripherals::trigger(bool active) {
  if (!powered_) return;
  digitalWrite(pins::scannerTrigger, active ? LOW : HIGH);
  triggerActive_ = active;
  triggerUntil_ = millis() + 3000; // bounded scan attempt
}

char Peripherals::pollKey() {
  uint32_t mask = 0;
  for (unsigned c = 0; c < 4; ++c) {
    digitalWrite(pins::cols[c], LOW);
    pinMode(pins::cols[c], OUTPUT);
    delayMicroseconds(10);
    for (unsigned r = 0; r < 5; ++r)
      if (!digitalRead(pins::rows[r])) mask |= 1UL << (r * 4 + c);
    pinMode(pins::cols[c], INPUT);
  }
  if (!digitalRead(pins::scan)) mask |= 1UL << 20;
  const auto now = millis();
  if (mask != candidate_) { candidate_ = mask; changedAt_ = now; }
  if (now - changedAt_ < 30 || stable_ == candidate_) return 0;
  stable_ = candidate_;
  if (!stable_) { keyReleased_ = true; return 0; }
  if (!keyReleased_) return 0;
  keyReleased_ = false; // require all keys up before the next action, including after multi-key input
  if (stable_ == (1UL << 20)) return 'T';
  // Also reject scan + matrix combinations.
  return singleMatrixKey(stable_);
}

bool Peripherals::pollScanner(String& code) {
  if (!powered_) return false;
  bool ready = false;
  while (scanner_.available()) {
    lastByte_ = millis();
    if (frame_.feed(static_cast<char>(scanner_.read()))) { ready = true; break; }
  }
  if (!ready && frame_.pending() && millis() - lastByte_ >= TERMINAL_SCANNER_IDLE_MS)
    ready = frame_.finish();
  if (!ready) return false;
  code = frame_.data();
  frame_.reset();
  trigger(false);
  return true;
}

void Peripherals::beep(bool ok) {
  ledcWriteTone(0, ok ? 2300 : 1200);
  toneUntil_ = millis() + (ok ? 70 : 220);
}
void Peripherals::keyClick() {
  if (toneUntil_) return;
  ledcWriteTone(0, 2300);
  toneUntil_ = millis() + 24;
}
void Peripherals::tick() {
  if (toneUntil_ && static_cast<int32_t>(millis() - toneUntil_) >= 0) {
    ledcWrite(0, 0); toneUntil_ = 0;
  }
  if (triggerActive_ && static_cast<int32_t>(millis() - triggerUntil_) >= 0) trigger(false);
}
float Peripherals::batteryVolts() {
  uint32_t total = 0;
  for (unsigned i = 0; i < 8; ++i) total += analogReadMilliVolts(pins::battery);
  return total / 8000.0f * TERMINAL_BATTERY_SCALE;
}
void Peripherals::showKeyTest() {
  display_.fillScreen(ST77XX_BLACK);
  display_.fillRect(0, 0, 80, 30, ST77XX_RED);
  display_.fillRect(80, 0, 80, 30, ST77XX_GREEN);
  display_.fillRect(160, 0, 80, 30, ST77XX_BLUE);
  display_.setTextColor(ST77XX_WHITE);
  display_.setTextSize(2);
  display_.setCursor(12, 51);
  display_.print("LCD / Key / Scan");
  display_.setTextSize(1);
  display_.setCursor(12, 84);
  display_.print("Press one key at a time");
}

void Peripherals::showKeyPress(const char* name, char code, uint32_t count) {
  display_.fillRect(0, 101, 240, 55, ST77XX_BLACK);
  display_.setTextColor(ST77XX_CYAN);
  display_.setTextSize(3);
  display_.setCursor(12, 107);
  display_.print(name);
  display_.setTextColor(ST77XX_WHITE);
  display_.setTextSize(1);
  display_.setCursor(12, 138);
  display_.printf("Code: %c   Presses: %lu", code, static_cast<unsigned long>(count));
}

void Peripherals::showScanTest(const char* status, const String& code) {
  display_.fillRect(0, 156, 240, 84, ST77XX_BLACK);
  display_.drawFastHLine(12, 160, 216, ST77XX_WHITE);
  display_.setTextColor(ST77XX_YELLOW);
  display_.setTextSize(1);
  display_.setCursor(12, 171);
  display_.print(status);
  display_.setTextColor(ST77XX_WHITE);
  for (unsigned offset = 0, y = 189; offset < code.length() && offset < 144;
       offset += 36, y += 10) {
    display_.setCursor(12, y);
    display_.print(code.substring(offset, offset + 36));
  }
}

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
  digitalWrite(pins::tftBacklight, !TERMINAL_BACKLIGHT_ON);
  pinMode(pins::tftBacklight, OUTPUT);
  SPI.begin(pins::tftClock, -1, pins::tftData, -1);
  display_.init(240, 240, TERMINAL_SPI_MODE);
  display_.setRotation(TERMINAL_ROTATION);
  display_.setTextWrap(true);
  digitalWrite(pins::tftBacklight, TERMINAL_BACKLIGHT_ON);
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
void Peripherals::screen(const String& status, const String& code, const String& mode,
                         const String& qty, const String& message) {
  display_.fillScreen(ST77XX_BLACK);
  display_.setCursor(8, 8);
  display_.setTextColor(ST77XX_CYAN); display_.setTextSize(2);
  display_.println("JPLM Warehouse");
  display_.setTextSize(1); display_.setTextColor(ST77XX_WHITE);
  display_.println(status);
  display_.print("Battery: "); display_.print(batteryVolts(), 2); display_.println(" V");
  display_.println();
  display_.setTextSize(2); display_.println(mode + " Qty:" + qty);
  display_.setTextSize(1);
  display_.println(code.substring(0, 120));
  display_.println(); display_.println(message.substring(0, 200));
  display_.setCursor(8, 210);
  display_.println("Scan -> Qty -> Confirm twice");
  display_.println("Back: cancel  Delete: erase");
}

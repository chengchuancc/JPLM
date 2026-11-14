#pragma once
#include <Arduino.h>
#include <Adafruit_ST7789.h>
#include "board_pins.h"
#include "terminal_logic.h"

class Peripherals {
 public:
  void begin();
  char pollKey(); // single press events after debounce; S is scrap, T is scan
  bool pollScanner(String& code);
  void trigger(bool active);
  void scannerPower(bool on);
  void beep(bool ok = true);
  void tick();
  float batteryVolts();
  void screen(const String& status, const String& code, const String& mode,
              const String& qty, const String& message);
 private:
  Adafruit_ST7789 display_{&SPI, -1, pins::tftDc, pins::tftReset};
  HardwareSerial scanner_{1};
  ScanFrame frame_;
  uint32_t lastByte_ = 0, changedAt_ = 0, toneUntil_ = 0;
  uint32_t candidate_ = 0, stable_ = 0;
  bool powered_ = false, triggerActive_ = false;
  bool keyReleased_ = true;
  uint32_t triggerUntil_ = 0;
};

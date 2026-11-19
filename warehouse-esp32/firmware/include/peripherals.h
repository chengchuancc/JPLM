#pragma once
#include <Arduino.h>
#include "board_pins.h"
#include "hancai_st7789.h"
#include "terminal_logic.h"

class Peripherals {
 public:
  struct ScanStats {
    uint32_t bytes = 0, rejected = 0;
    bool endedOnIdle = false;
  };
  void begin();
  char pollKey(); // single press events after debounce; S is scrap, T is scan
  bool pollScanner(String& code, ScanStats* stats = nullptr);
  void trigger(bool active);
  bool scanActive() const { return triggerActive_; }
  void scannerPower(bool on);
  void beep(bool ok = true);
  void keyClick();
  void tick();
  Adafruit_ST77xx& display() { return display_; }
  float batteryVolts();
  void showKeyTest();
  void showKeyPress(const char* name, char code, uint32_t count);
  void showScanTest(const char* status, const String& code);
 private:
  HancaiSt7789 display_;
  HardwareSerial scanner_{1};
  ScanFrame frame_;
  uint32_t lastByte_ = 0, changedAt_ = 0, toneUntil_ = 0;
  uint32_t candidate_ = 0, stable_ = 0;
  bool powered_ = false, triggerActive_ = false;
  bool keyReleased_ = true;
  uint32_t triggerUntil_ = 0;
};

#pragma once
#include <Adafruit_ST77xx.h>

class HancaiSt7789 : public Adafruit_ST77xx {
 public:
  HancaiSt7789();
  void init();
  void setRotation(uint8_t orientation) override;
};

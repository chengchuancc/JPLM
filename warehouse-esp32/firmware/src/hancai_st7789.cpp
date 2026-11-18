#include "hancai_st7789.h"
#include "board_pins.h"
#include "settings.h"

namespace {
// Register sequence from 瀚彩初始化参数.txt after the first sleep-out and MADCTL.
const uint8_t kInitCommands[] PROGMEM = {
    17,
    ST77XX_COLMOD, 1, 0x05,
    0xB2, 5, 0x1F, 0x1F, 0x00, 0x33, 0x33,
    0xB7, 1, 0x00,
    0xBB, 1, 0x3F,
    0xC0, 1, 0x2C,
    0xC2, 1, 0x01,
    0xC3, 1, 0x0F,
    0xC4, 1, 0x20,
    0xC6, 1, 0x13,
    0xD0, 2, 0xA4, 0xA1,
    0xD6, 1, 0xA1,
    0xE0, 14, 0xF0, 0x06, 0x0D, 0x0B, 0x0A, 0x07, 0x2E,
              0x43, 0x45, 0x38, 0x14, 0x13, 0x25, 0x29,
    0xE1, 14, 0xF0, 0x07, 0x0A, 0x08, 0x07, 0x23, 0x2E,
              0x33, 0x44, 0x3A, 0x16, 0x17, 0x26, 0x2C,
    0xE4, 3, 0x1D, 0x00, 0x00,
    ST77XX_INVON, 0,
    ST77XX_SLPOUT, ST_CMD_DELAY, 120,
    ST77XX_DISPON, 0
};

struct Orientation {
  uint8_t madctl, xOffset, yOffset;
};

// Keep the project's rotation numbering and the 240x240 address offsets
// within ST7789's 240x320 memory. Use the vendor's MADCTL settings.
constexpr Orientation kOrientations[] = {
    {0xC0, 0, 80}, {0xA0, 80, 0}, {0x00, 0, 0}, {0x70, 0, 0}
};
}

HancaiSt7789::HancaiSt7789()
    : Adafruit_ST77xx(240, 240, &SPI, -1, pins::tftDc, -1) {}

void HancaiSt7789::init() {
  digitalWrite(pins::tftBacklight, !TERMINAL_BACKLIGHT_ON);
  pinMode(pins::tftBacklight, OUTPUT);
  SPI.begin(pins::tftClock, -1, pins::tftData, -1);
  spiMode = TERMINAL_SPI_MODE;
  begin();

  digitalWrite(pins::tftReset, HIGH);
  pinMode(pins::tftReset, OUTPUT);
  delay(50);
  digitalWrite(pins::tftReset, LOW);
  delay(50);
  digitalWrite(pins::tftReset, HIGH);
  delay(120);
  digitalWrite(pins::tftBacklight, TERMINAL_BACKLIGHT_ON);

  sendCommand(ST77XX_SLPOUT);
  delay(120);
  setRotation(TERMINAL_ROTATION);
  displayInit(kInitCommands);
}

void HancaiSt7789::setRotation(uint8_t orientation) {
  Adafruit_GFX::setRotation(orientation);
  const auto& config = kOrientations[rotation];
  _xstart = config.xOffset;
  _ystart = config.yOffset;
  sendCommand(ST77XX_MADCTL, &config.madctl, 1);
}

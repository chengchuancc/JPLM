#pragma once
#include <Adafruit_ST77xx.h>
#include "terminal_font.h"

namespace ui {
constexpr uint16_t background = 0x0000, panel = 0x10A2, raised = 0x2124, line = 0x31A6;
constexpr uint16_t text = 0xF7BE, muted = 0xA534;
constexpr uint16_t inbound = 0xFD40, outbound = 0x3D7F, danger = 0xF9C8;
constexpr uint16_t accent = 0x57A0, warning = 0xFEC0;
constexpr int thumbnailSize = 120;
constexpr uint32_t keyMotionMs = 115, imageMotionMs = 180;
enum class Icon {
  Scan, History, Inbound, Outbound, Trash, Back, Confirm, Erase, Person, Wifi,
  Left, Right, Refresh, Document, Warehouse, Photo, Box, Key, Alert, Link
};
inline uint16_t movementColor(Icon symbol) {
  if (symbol == Icon::Inbound) return inbound;
  if (symbol == Icon::Outbound) return outbound;
  if (symbol == Icon::Trash || symbol == Icon::Alert) return danger;
  return text;
}
}

class TerminalDisplay {
 public:
  explicit TerminalDisplay(Adafruit_ST77xx& screen) : screen_(screen) {}
  void begin();
  void motion(char pressedKey, uint32_t keyAge);
  void frame(ui::Icon symbol, const String& title, const String& connection, int batteryPercent);
  void signal(int rssi);
  void text(int y, const String& value, uint16_t color = ui::text, int x = 10, int width = 220);
  void multiline(int y, int step, unsigned lines, const String& value, uint16_t color, int x, int width);
  void outline(int x, int y, int width, int height);
  void divider(int y, int x = 10, int width = 220);
  void icon(ui::Icon symbol, int x, int y, int size, uint16_t color = ui::accent);
  void scanLine(int x, int y, int width, uint32_t now);
  void button(int x, int y, int width, int height, ui::Icon symbol, const char* label,
              char key, uint16_t fill);
  void row(int y, ui::Icon symbol, const String& label, bool selected,
           const String& operation = "", const String& quantity = "");
  void number(int x, int y, int width, const String& value, uint16_t color = ui::text);
  void loading(uint32_t now);
  void setThumbnail(const uint16_t* pixels);
  void thumbnail(int x, int y, const uint16_t* source, uint32_t age);
  void present();
 private:
  class Canvas : public GFXcanvas16 {
   public:
    Canvas() : GFXcanvas16(240, 240, false) {}
    bool allocate();
  };
  unsigned fit(const ui::BitmapFont& font, const String& value, int width);
  void paint(const ui::BitmapFont& font, int x, int baseline, int width,
             const String& value, uint16_t color, bool enlarged = false);
  void battery(int percent);
  Adafruit_ST77xx& screen_;
  Canvas canvas_;
  Adafruit_GFX* target_ = nullptr;
  uint16_t* front_ = nullptr;
  uint16_t* photo_ = nullptr;
  bool presented_ = false;
  int pressLevel_ = 0;
  char pressedKey_ = 0;
  ui::BitmapFont body_{ui::FontFace::Body};
  ui::BitmapFont medium_{ui::FontFace::Medium};
  ui::BitmapFont large_{ui::FontFace::Large};
};

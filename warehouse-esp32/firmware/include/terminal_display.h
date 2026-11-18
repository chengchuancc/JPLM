#pragma once
#include <Adafruit_ST77xx.h>
#include "terminal_font.h"

namespace ui {
constexpr uint16_t background = 0x0000, panel = 0x10A4, raised = 0x21AA;
constexpr uint16_t text = 0xF7BF, muted = 0x9D58, accent = 0x75BF, ink = 0x0083;
constexpr uint16_t selection = 0x19CB, warning = 0xFE0B, danger = 0x6144;
enum class Icon {
  Scan, History, Inbound, Outbound, Trash, Back, Confirm, Erase, Person, Wifi,
  Left, Right, Refresh, Document, Warehouse
};
}

class TerminalDisplay {
 public:
  explicit TerminalDisplay(Adafruit_ST77xx& screen) : screen_(screen) {}
  void begin();
  void motion(uint32_t pageAge, char pressedKey, uint32_t keyAge);
  void frame(ui::Icon symbol, const String& title, const String& connection, int batteryPercent);
  void signal(int rssi);
  void text(int y, const String& value, uint16_t color = ui::text, int x = 10, int width = 220);
  void multiline(int y, int step, unsigned lines, const String& value, uint16_t color, int x, int width);
  void card(int x, int y, int width, int height, uint16_t fill = ui::panel);
  void button(int x, int y, int width, int height, ui::Icon symbol, const char* label,
              char key, uint16_t fill, const char* hint = "");
  void row(int y, const String& label, bool selected, const String& detail = "");
  void number(int x, int y, int width, const String& value, uint16_t color = ui::text);
  void loading(uint32_t now);
  void footer(const String& message, const String& buttons = "");
  void thumbnail(uint16_t* pixels);
  void present();
 private:
  class Canvas : public GFXcanvas16 {
   public:
    Canvas() : GFXcanvas16(240, 240, false) {}
    bool allocate();
  };
  unsigned fit(const ui::BitmapFont& font, const String& value, int width);
  void paint(const ui::BitmapFont& font, int x, int baseline, int width,
             const String& value, uint16_t color);
  void battery(int percent);
  void icon(ui::Icon symbol, int x, int y, int size, uint16_t color);
  Adafruit_ST77xx& screen_;
  Canvas canvas_;
  Adafruit_GFX* target_ = nullptr;
  uint16_t* front_ = nullptr;
  bool presented_ = false;
  int reveal_ = 0, pressLevel_ = 0;
  char pressedKey_ = 0;
  ui::BitmapFont body_{ui::FontFace::Body};
  ui::BitmapFont medium_{ui::FontFace::Medium};
  ui::BitmapFont large_{ui::FontFace::Large};
};

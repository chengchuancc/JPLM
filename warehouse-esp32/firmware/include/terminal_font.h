#pragma once
#include <Arduino.h>

namespace ui {
enum class FontFace { Body, Medium, Large };

struct Glyph {
  uint32_t codepoint, pixels;
  uint8_t width, height, advance;
  int8_t x, y;
  uint8_t reserved[3];
};

class BitmapFont {
 public:
  explicit BitmapFont(FontFace face);
  Glyph glyph(uint32_t codepoint) const;
  Glyph next(const String& text, unsigned& position) const;
  unsigned width(const String& text) const;
  const uint8_t* bitmap(const Glyph& letter) const;
 private:
  const uint8_t* table_;
  uint32_t count_;
};
}

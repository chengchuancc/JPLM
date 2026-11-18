#include "terminal_font.h"

extern const uint8_t terminalFontData[] asm("_binary_fonts_terminal_font_dat_start");

namespace ui {
namespace {
static_assert(sizeof(Glyph) == 16, "Glyph table must match fonts/build_font.py");

uint32_t read32(const uint8_t* source) {
  uint32_t value;
  memcpy(&value, source, sizeof(value));
  return value;
}

uint32_t decode(const String& text, unsigned& position) {
  const uint8_t first = text[position++];
  if (first < 0x80) return first;
  if (first < 0xC2 || first > 0xF4) return 0xFFFD;
  const unsigned following = first < 0xE0 ? 1 : first < 0xF0 ? 2 : 3;
  uint32_t code = first & (0x7F >> (following + 1));
  for (unsigned i = 0; i < following; ++i) {
    if (position == text.length()) return 0xFFFD;
    const uint8_t byte = text[position];
    if ((byte & 0xC0) != 0x80) return 0xFFFD;
    ++position;
    code = (code << 6) | (byte & 0x3F);
  }
  constexpr uint32_t minimum[] = {0, 0x80, 0x800, 0x10000};
  if (code < minimum[following] || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return 0xFFFD;
  return code;
}
}

BitmapFont::BitmapFont(FontFace face) {
  const uint8_t* header = terminalFontData + static_cast<unsigned>(face) * 8;
  count_ = read32(header);
  table_ = terminalFontData + read32(header + 4);
}

Glyph BitmapFont::glyph(uint32_t codepoint) const {
  uint32_t low = 0, high = count_;
  while (low < high) {
    const uint32_t middle = low + (high - low) / 2;
    const uint8_t* record = table_ + middle * sizeof(Glyph);
    const uint32_t code = read32(record);
    if (code == codepoint) {
      Glyph letter;
      memcpy(&letter, record, sizeof(letter));
      return letter;
    }
    if (code < codepoint) low = middle + 1;
    else high = middle;
  }
  return codepoint == '?' ? Glyph{} : glyph('?');
}

Glyph BitmapFont::next(const String& text, unsigned& position) const {
  return glyph(decode(text, position));
}

unsigned BitmapFont::width(const String& text) const {
  unsigned result = 0;
  for (unsigned i = 0; i < text.length();) result += next(text, i).advance;
  return result;
}

const uint8_t* BitmapFont::bitmap(const Glyph& letter) const {
  return terminalFontData + letter.pixels;
}
}

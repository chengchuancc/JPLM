#include "terminal_display.h"
#include <esp32-hal-psram.h>

namespace {
constexpr int kSize = 240;
constexpr int kBand = 8;
constexpr size_t kFrameBytes = kSize * kSize * sizeof(uint16_t);

uint16_t blend(uint16_t a, uint16_t b, int level) {
  const int inverse = 32 - level;
  const int r = (((a >> 11) * inverse) + ((b >> 11) * level)) / 32;
  const int g = ((((a >> 5) & 63) * inverse) + (((b >> 5) & 63) * level)) / 32;
  const int blue = (((a & 31) * inverse) + ((b & 31) * level)) / 32;
  return (r << 11) | (g << 5) | blue;
}
}

bool TerminalDisplay::Canvas::allocate() {
  buffer = static_cast<uint16_t*>(ps_malloc(kFrameBytes));
  buffer_owned = buffer != nullptr;
  return buffer != nullptr;
}

void TerminalDisplay::begin() {
  target_ = &screen_;
  if (canvas_.allocate()) {
    target_ = &canvas_;
    front_ = static_cast<uint16_t*>(ps_malloc(kFrameBytes));
  }
}

void TerminalDisplay::motion(uint32_t pageAge, char key, uint32_t keyAge) {
  const int remaining = pageAge >= 140 ? 0 : 140 - pageAge;
  reveal_ = remaining * remaining / 2450;
  pressedKey_ = key;
  pressLevel_ = keyAge >= 100 ? 0 : (100 - keyAge) * 14 / 100;
}

void TerminalDisplay::frame(ui::Icon symbol, const String& title, const String& connection, int percent) {
  target_->fillScreen(ui::background);
  card(0, 0, 240, 45);
  icon(symbol, 10, 7, 17, ui::accent);
  text(23, title, ui::text, 33, 72);
  icon(ui::Icon::Wifi, 11, 29, 12, ui::muted);
  text(40, connection, ui::muted, 28, 202);
  battery(percent);
}

void TerminalDisplay::battery(int percent) {
  const uint16_t color = percent < 0 ? ui::muted : percent <= 15 ? ui::warning : ui::accent;
  target_->drawRect(173, 12, 18, 10, color);
  target_->fillRect(191, 15, 2, 4, color);
  if (percent > 0) target_->fillRect(175, 14, max(1, percent * 14 / 100), 6, color);
  const String value = percent < 0 ? "--%" : String(percent) + "%";
  text(22, value, color, 197, 43);
}

void TerminalDisplay::signal(int rssi) {
  const int bars = rssi == 0 ? 0 : rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -75 ? 2 : 1;
  const uint16_t color = bars >= 3 ? ui::accent : bars ? ui::warning : ui::muted;
  for (int i = 0; i < 4; ++i) {
    const int height = 3 + i * 3;
    target_->fillRect(108 + i * 4, 24 - height, 3, height, i < bars ? color : ui::raised);
  }
  text(23, rssi ? String(rssi) : String("--"), color, 128, 41);
}

unsigned TerminalDisplay::fit(const ui::BitmapFont& font, const String& value, int width) {
  if (width <= 0) return 0;
  unsigned end = 0;
  unsigned pixels = 0;
  for (unsigned i = 0; i < value.length();) {
    pixels += font.next(value, i).advance;
    if (pixels > static_cast<unsigned>(width)) break;
    end = i;
  }
  return end;
}

void TerminalDisplay::paint(const ui::BitmapFont& font, int x, int baseline, int width,
                            const String& value, uint16_t color) {
  if (width <= 0 || value.isEmpty()) return;
  const String dots("...");
  String content = value;
  if (fit(font, value, width) < value.length()) {
    content = value.substring(0, fit(font, value, width - static_cast<int>(font.width(dots)))) + dots;
  }
  uint16_t* frame = canvas_.getBuffer();
  int cursor = x;
  const int clipRight = min(kSize, x + width);
  for (unsigned index = 0; index < content.length();) {
    const auto letter = font.next(content, index);
    const auto* coverage = font.bitmap(letter);
    for (int r = 0; r < letter.height; ++r) {
      const int py = baseline + letter.y + r;
      if (py < 0 || py >= kSize) continue;
      for (int col = 0; col < letter.width; ++col) {
        const int px = cursor + letter.x + col;
        if (px < x || px < 0 || px >= clipRight) continue;
        const unsigned position = r * letter.width + col;
        const int coverageByte = coverage[position / 2];
        const int alpha = position % 2 ? coverageByte & 15 : coverageByte >> 4;
        if (!alpha) continue;
        if (frame) {
          uint16_t& pixel = frame[py * kSize + px];
          pixel = alpha == 15 ? color : blend(pixel, color, (alpha * 32 + 7) / 15);
        } else if (alpha >= 8) {
          target_->drawPixel(px, py, color);
        }
      }
    }
    cursor += letter.advance;
  }
}

void TerminalDisplay::text(int y, const String& value, uint16_t color, int x, int width) {
  paint(body_, x, y, width, value, color);
}

void TerminalDisplay::multiline(int y, int step, unsigned lines, const String& value,
                                uint16_t color, int x, int width) {
  String remaining = value;
  while (lines > 1 && !remaining.isEmpty()) {
    const unsigned split = fit(body_, remaining, width);
    if (split == remaining.length() || !split) break;
    text(y, remaining.substring(0, split), color, x, width);
    remaining.remove(0, split);
    y += step;
    --lines;
  }
  text(y, remaining, color, x, width);
}

void TerminalDisplay::card(int x, int y, int width, int height, uint16_t fill) {
  target_->fillRoundRect(x, y, width, height, 3, fill);
}

void TerminalDisplay::icon(ui::Icon symbol, int x, int y, int size, uint16_t color) {
  auto line = [&](int x0, int y0, int x1, int y1) {
    target_->drawLine(x + x0 * size / 20, y + y0 * size / 20,
                      x + x1 * size / 20, y + y1 * size / 20, color);
  };
  auto box = [&](int x0, int y0, int w, int h) {
    target_->drawRect(x + x0 * size / 20, y + y0 * size / 20,
                      w * size / 20, h * size / 20, color);
  };
  using ui::Icon;
  switch (symbol) {
    case Icon::Scan:
      line(1, 6, 1, 2); line(1, 2, 6, 2); line(14, 2, 19, 2); line(19, 2, 19, 6);
      line(1, 14, 1, 18); line(1, 18, 6, 18); line(14, 18, 19, 18); line(19, 18, 19, 14);
      for (int i : {5, 8, 12, 15}) line(i, 7, i, 13);
      break;
    case Icon::History:
      target_->drawCircle(x + size / 2, y + size / 2, size * 7 / 16, color);
      line(10, 5, 10, 10); line(10, 10, 14, 11);
      break;
    case Icon::Warehouse:
      line(1, 7, 10, 2); line(10, 2, 19, 7); line(2, 7, 2, 18); line(18, 7, 18, 18);
      line(2, 18, 18, 18); box(6, 10, 9, 9);
      break;
    case Icon::Inbound:
    case Icon::Outbound:
      line(2, 12, 2, 18); line(2, 18, 18, 18); line(18, 18, 18, 12);
      line(10, 2, 10, 13);
      if (symbol == Icon::Inbound) { line(5, 8, 10, 13); line(10, 13, 15, 8); }
      else { line(5, 7, 10, 2); line(10, 2, 15, 7); }
      break;
    case Icon::Trash:
      line(2, 5, 18, 5); line(7, 2, 13, 2); line(5, 6, 6, 18); line(14, 18, 15, 6);
      line(6, 18, 14, 18); line(9, 8, 9, 15); line(12, 8, 12, 15);
      break;
    case Icon::Back:
      line(3, 8, 16, 8); line(16, 8, 17, 15); line(3, 8, 8, 3); line(3, 8, 8, 13);
      break;
    case Icon::Confirm:
      line(3, 10, 8, 15); line(8, 15, 17, 5);
      break;
    case Icon::Erase:
      line(2, 10, 7, 5); line(2, 10, 7, 15); line(7, 5, 18, 5); line(7, 15, 18, 15);
      line(18, 5, 18, 15); line(10, 8, 14, 12); line(10, 12, 14, 8);
      break;
    case Icon::Person:
      target_->drawCircle(x + size / 2, y + size / 3, size / 5, color);
      line(3, 17, 5, 14); line(5, 14, 15, 14); line(15, 14, 17, 17);
      break;
    case Icon::Wifi:
      line(1, 7, 6, 4); line(6, 4, 14, 4); line(14, 4, 19, 7);
      line(4, 11, 8, 8); line(8, 8, 12, 8); line(12, 8, 16, 11);
      line(8, 14, 10, 12); line(10, 12, 12, 14); line(10, 17, 10, 17);
      break;
    case Icon::Left:
      line(13, 4, 6, 10); line(6, 10, 13, 16);
      break;
    case Icon::Right:
      line(7, 4, 14, 10); line(14, 10, 7, 16);
      break;
    case Icon::Refresh:
      line(4, 7, 7, 3); line(7, 3, 14, 3); line(14, 3, 17, 7);
      line(17, 7, 13, 7); line(17, 7, 17, 3);
      line(16, 13, 13, 17); line(13, 17, 6, 17); line(6, 17, 3, 13);
      break;
    case Icon::Document:
      box(4, 2, 13, 17);
      line(7, 7, 13, 7); line(7, 10, 13, 10); line(7, 13, 11, 13);
      break;
  }
}

void TerminalDisplay::button(int x, int y, int width, int height,
                             ui::Icon symbol, const char* label, char key,
                             uint16_t fill, const char* hint) {
  const int press = key == pressedKey_ ? pressLevel_ : 0;
  const bool primary = fill == ui::accent;
  card(x, y, width, height, blend(fill, primary ? ui::ink : ui::accent, press));
  const uint16_t foreground = primary ? ui::ink : ui::text;
  const bool large = height >= 43;
  const int offset = large ? min(reveal_, 5) + (press ? 1 : 0) : 0;
  if (large) {
    icon(symbol, x + 9, y + 5 + offset, height >= 55 ? 23 : 20, primary ? ui::ink : ui::accent);
    text(y + height - 7, label, foreground, x + 9, width - 15);
    if (*hint) text(y + 19, hint, primary ? ui::ink : ui::muted, x + width - 52, 45);
  } else {
    icon(symbol, x + 7, y + (height - 14) / 2, 14, foreground);
    text(y + height / 2 + 5, label, foreground, x + 24, width - 29);
  }
}

void TerminalDisplay::row(int y, const String& label, bool selected, const String& detail) {
  card(10, y, 220, 20, selected ? ui::selection : ui::panel);
  if (selected) {
    target_->fillRect(10, y + 3, 2, 14, ui::accent);
    icon(ui::Icon::Right, 214, y + 5, 10, ui::accent);
  }
  const bool hasDetail = !detail.isEmpty();
  text(y + 15, label, ui::text, 17, hasDetail ? 134 : 200);
  if (hasDetail) text(y + 15, detail, selected ? ui::text : ui::muted, 153, 62);
}

void TerminalDisplay::number(int x, int y, int width, const String& value, uint16_t color) {
  const ui::BitmapFont& font = large_.width(value) <= static_cast<unsigned>(width) ? large_
                               : medium_.width(value) <= static_cast<unsigned>(width) ? medium_ : body_;
  paint(font, x, y - font.glyph('0').y, width, value, color);
}

void TerminalDisplay::loading(uint32_t now) {
  const unsigned phase = (now / 10) % 186;
  target_->fillRect(10, 45, 220, 2, ui::raised);
  target_->fillRect(10 + phase, 45, 34, 2, ui::accent);
}

void TerminalDisplay::footer(const String& message, const String& buttons) {
  const unsigned split = fit(body_, message, 220);
  if (split == message.length()) {
    text(201, message, ui::warning);
  } else {
    text(198, message.substring(0, split), ui::warning);
    text(214, message.substring(split), ui::warning);
  }
  text(233, buttons, ui::muted);
}

void TerminalDisplay::thumbnail(uint16_t* pixels) {
  card(145, 48, 84, 84, ui::raised);
  if (target_ == &canvas_) {
    uint16_t* dest = canvas_.getBuffer() + 50 * kSize + 147;
    for (int y = 0; y < 80; ++y) memcpy(dest + y * kSize, pixels + y * 80, 160);
  } else {
    screen_.startWrite();
    screen_.setAddrWindow(147, 50, 80, 80);
    screen_.writePixels(pixels, 80 * 80);
    screen_.endWrite();
  }
}

void TerminalDisplay::present() {
  uint16_t* back = canvas_.getBuffer();
  if (!back) return;
  if (!presented_ || !front_) {
    screen_.startWrite();
    screen_.setAddrWindow(0, 0, kSize, kSize);
    screen_.writePixels(back, kSize * kSize);
    screen_.endWrite();
    if (front_) memcpy(front_, back, kFrameBytes);
    presented_ = true;
    return;
  }
  for (int y = 0; y < kSize; y += kBand) {
    const size_t offset = y * kSize;
    constexpr size_t bytes = kBand * kSize * sizeof(uint16_t);
    if (memcmp(front_ + offset, back + offset, bytes) == 0) continue;
    int left = kSize, right = -1, first = kBand, last = -1;
    for (int row = 0; row < kBand; ++row) {
      const size_t line = offset + row * kSize;
      for (int x = 0; x < kSize; ++x) {
        if (front_[line + x] == back[line + x]) continue;
        left = min(left, x);
        right = max(right, x);
        first = min(first, row);
        last = row;
      }
    }
    screen_.startWrite();
    screen_.setAddrWindow(left, y + first, right - left + 1, last - first + 1);
    for (int row = first; row <= last; ++row) {
      screen_.writePixels(back + offset + row * kSize + left, right - left + 1);
    }
    screen_.endWrite();
    memcpy(front_ + offset, back + offset, bytes);
  }
}

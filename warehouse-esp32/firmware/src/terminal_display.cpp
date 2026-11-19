#include "terminal_display.h"
#include <esp32-hal-psram.h>

namespace {
constexpr int kSize = 240;
constexpr int kBand = 8;
constexpr size_t kFrameBytes = kSize * kSize * sizeof(uint16_t);
constexpr int kPhotoSource = 80;

uint16_t blend(uint16_t a, uint16_t b, int level) {
  const int inverse = 32 - level;
  const int r = (((a >> 11) * inverse) + ((b >> 11) * level)) / 32;
  const int g = ((((a >> 5) & 63) * inverse) + (((b >> 5) & 63) * level)) / 32;
  const int blue = (((a & 31) * inverse) + ((b & 31) * level)) / 32;
  return (r << 11) | (g << 5) | blue;
}

void scalePhotoRow(const uint16_t* pixels, int y, uint16_t* row) {
  const int sourceY = y * 2 / 3;
  const int bottom = min(sourceY + 1, kPhotoSource - 1);
  const int wy = (y * 2 % 3) * 32 / 3;
  for (int x = 0; x < ui::thumbnailSize; ++x) {
    const int left = x * 2 / 3;
    const int right = min(left + 1, kPhotoSource - 1);
    const int wx = (x * 2 % 3) * 32 / 3;
    const uint16_t top = blend(pixels[sourceY * kPhotoSource + left], pixels[sourceY * kPhotoSource + right], wx);
    const uint16_t lower = blend(pixels[bottom * kPhotoSource + left], pixels[bottom * kPhotoSource + right], wx);
    row[x] = blend(top, lower, wy);
  }
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
  photo_ = static_cast<uint16_t*>(ps_malloc(ui::thumbnailSize * ui::thumbnailSize * sizeof(uint16_t)));
}

void TerminalDisplay::motion(char key, uint32_t keyAge) {
  pressedKey_ = key;
  pressLevel_ = keyAge >= ui::keyMotionMs ? 0 : (ui::keyMotionMs - keyAge) * 13 / ui::keyMotionMs;
}

void TerminalDisplay::frame(ui::Icon symbol, const String& title, const String& connection, int percent) {
  target_->fillScreen(ui::background);
  icon(symbol, 10, 5, 18, ui::movementColor(symbol));
  text(22, title, ui::text, 36, 129);
  text(36, connection, ui::muted, 11, 176);
  divider(39);
  battery(percent);
}

void TerminalDisplay::battery(int percent) {
  const uint16_t color = percent <= 15 && percent >= 0 ? ui::warning : ui::muted;
  target_->drawRect(173, 12, 18, 10, color);
  target_->fillRect(191, 15, 2, 4, color);
  if (percent > 0) target_->fillRect(175, 14, max(1, percent * 14 / 100), 6, color);
  const String value = percent < 0 ? "--%" : String(percent) + "%";
  text(22, value, color, 197, 43);
}

void TerminalDisplay::signal(int rssi) {
  const int bars = rssi == 0 ? 0 : rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -75 ? 2 : 1;
  const uint16_t color = bars >= 3 ? ui::muted : bars ? ui::warning : ui::muted;
  for (int i = 0; i < 4; ++i) {
    const int height = 3 + i * 2;
    target_->fillRect(191 + i * 3, 35 - height, 2, height, i < bars ? color : ui::raised);
  }
  text(36, rssi ? String(rssi) : String("--"), color, 205, 35);
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
                            const String& value, uint16_t color, bool enlarged) {
  if (width <= 0 || value.isEmpty()) return;
  const auto scale = [enlarged](int value) { return enlarged ? value * 5 / 4 : value; };
  const int fontWidth = enlarged ? width * 4 / 5 : width;
  const String dots("...");
  String content = value;
  if (fit(font, value, fontWidth) < value.length()) {
    content = value.substring(0, fit(font, value, fontWidth - static_cast<int>(font.width(dots)))) + dots;
  }
  uint16_t* frame = canvas_.getBuffer();
  int advance = 0;
  const int clipRight = min(kSize, x + width);
  for (unsigned index = 0; index < content.length();) {
    const auto letter = font.next(content, index);
    const auto* coverage = font.bitmap(letter);
    const auto sample = [&](int cx, int cy) {
      const unsigned position = cy * letter.width + cx;
      const int coverageByte = coverage[position / 2];
      return position % 2 ? coverageByte & 15 : coverageByte >> 4;
    };
    const int origin = x + scale(advance + letter.x);
    for (int r = 0; r < scale(letter.height); ++r) {
      const int py = baseline + scale(letter.y) + r;
      if (py < 0 || py >= kSize) continue;
      for (int col = 0; col < scale(letter.width); ++col) {
        const int px = origin + col;
        if (px < x || px < 0 || px >= clipRight) continue;
        int alpha;
        if (enlarged) {
          const int sx = col * 4 / 5, sy = r * 4 / 5;
          const int dx = col * 4 % 5, dy = r * 4 % 5;
          const int right = min(sx + 1, letter.width - 1), bottom = min(sy + 1, letter.height - 1);
          const int topAlpha = sample(sx, sy) * (5 - dx) + sample(right, sy) * dx;
          const int bottomAlpha = sample(sx, bottom) * (5 - dx) + sample(right, bottom) * dx;
          alpha = (topAlpha * (5 - dy) + bottomAlpha * dy + 12) / 25;
        } else {
          alpha = sample(col, r);
        }
        if (!alpha) continue;
        if (frame) {
          uint16_t& pixel = frame[py * kSize + px];
          pixel = alpha == 15 ? color : blend(pixel, color, (alpha * 32 + 7) / 15);
        } else if (alpha >= 8) {
          target_->drawPixel(px, py, color);
        }
      }
    }
    advance += letter.advance;
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

void TerminalDisplay::outline(int x, int y, int width, int height) {
  target_->drawRect(x, y, width, height, ui::line);
}

void TerminalDisplay::divider(int y, int x, int width) {
  target_->drawFastHLine(x, y, width, ui::line);
}

void TerminalDisplay::scanLine(int x, int y, int width, uint32_t now) {
  const unsigned step = (now / 20) % 30;
  const int offset = step > 15 ? 30 - step : step;
  target_->drawFastHLine(x, y + offset, width, ui::accent);
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
    case Icon::Photo:
      box(2, 3, 17, 15);
      target_->drawCircle(x + size * 13 / 20, y + size * 7 / 20, max(1, size / 12), color);
      line(3, 15, 8, 9); line(8, 9, 12, 14); line(12, 14, 15, 11); line(15, 11, 18, 15);
      break;
    case Icon::Box:
      line(2, 6, 10, 2); line(10, 2, 18, 6); line(18, 6, 18, 15); line(18, 15, 10, 19);
      line(10, 19, 2, 15); line(2, 15, 2, 6); line(2, 6, 10, 10); line(10, 10, 18, 6);
      line(10, 10, 10, 19);
      break;
    case Icon::Key:
      target_->drawCircle(x + size * 6 / 20, y + size * 7 / 20, max(2, size / 4), color);
      line(9, 10, 17, 18); line(13, 14, 16, 11); line(16, 17, 19, 14);
      break;
    case Icon::Alert:
      line(10, 2, 2, 17); line(2, 17, 18, 17); line(18, 17, 10, 2);
      line(10, 7, 10, 11); line(10, 14, 10, 14);
      break;
    case Icon::Link:
      line(2, 12, 2, 15); line(2, 15, 5, 18); line(5, 18, 9, 18); line(9, 18, 13, 14);
      line(7, 6, 11, 2); line(11, 2, 15, 2); line(15, 2, 18, 5); line(18, 5, 18, 9);
      line(6, 14, 14, 6);
      break;
  }
}

void TerminalDisplay::button(int x, int y, int width, int height,
                             ui::Icon symbol, const char* label, char key,
                             uint16_t fill) {
  const bool inactive = fill == ui::background;
  const int press = !inactive && key == pressedKey_ ? pressLevel_ : 0;
  const bool solid = fill == ui::accent || fill == ui::inbound || fill == ui::outbound || fill == ui::danger;
  if (solid) target_->fillRect(x, y, width, height, blend(fill, ui::background, press / 2));
  else if (press) target_->fillRect(x, y, width, height, ui::raised);
  else if (fill == ui::raised) outline(x, y, width, height);
  else if (!inactive) divider(y, x, width);
  const uint16_t foreground = solid ? ui::background : inactive ? ui::muted : ui::text;
  const uint16_t iconColor = !solid && !inactive && symbol == ui::Icon::Trash ? ui::danger : foreground;
  const bool compact = width <= 68;
  const int size = compact ? 12 : 16;
  const int inset = compact ? 18 : 29;
  icon(symbol, x + (compact ? 4 : 8), y + (height - size) / 2 + (press ? 1 : 0), size, iconColor);
  text(y + height / 2 + 5, label, foreground, x + inset, width - inset - 2);
}

void TerminalDisplay::row(int y, ui::Icon symbol, const String& label, bool selected,
                          const String& operation, const String& quantity) {
  const bool names = symbol == ui::Icon::Person;
  const int height = names ? 25 : 20;
  const int pulse = selected && (pressedKey_ == 'U' || pressedKey_ == 'D') ? pressLevel_ : 0;
  divider(y + height, 10, 220);
  if (selected) {
    target_->fillRect(10, y, 3 + pulse / 5, height, ui::accent);
    if (names) icon(ui::Icon::Right, 213, y + (height - 10) / 2, 10, ui::accent);
  }
  if (names) {
    paint(body_, 22, y + 19, 182, label, selected ? ui::accent : ui::text, true);
    return;
  }
  const uint16_t color = ui::movementColor(symbol);
  icon(symbol, 19, y + 4, 13, color);
  const int quantityWidth = min(65, static_cast<int>(body_.width(quantity)));
  const int operationWidth = min(38, static_cast<int>(body_.width(operation)));
  const int quantityX = 222 - quantityWidth;
  const int operationX = quantityX - operationWidth - 6;
  text(y + 15, label, ui::text, 38, operationX - 45);
  text(y + 15, operation, color, operationX, operationWidth);
  text(y + 15, quantity, ui::text, quantityX, quantityWidth);
}

void TerminalDisplay::number(int x, int y, int width, const String& value, uint16_t color) {
  bool ascii = true;
  for (unsigned i = 0; i < value.length(); ++i) {
    if (static_cast<uint8_t>(value[i]) >= 128) { ascii = false; break; }
  }
  const ui::BitmapFont& font = ascii && large_.width(value) <= static_cast<unsigned>(width) ? large_
                               : ascii && medium_.width(value) <= static_cast<unsigned>(width) ? medium_ : body_;
  paint(font, x, y - font.glyph('0').y, width, value, color);
}

void TerminalDisplay::loading(uint32_t now) {
  const unsigned phase = (now / 10) % 186;
  target_->drawFastHLine(10, 39, 220, ui::line);
  target_->drawFastHLine(10 + phase, 39, 34, ui::accent);
}

void TerminalDisplay::setThumbnail(const uint16_t* pixels) {
  if (!photo_) return;
  for (int y = 0; y < ui::thumbnailSize; ++y) scalePhotoRow(pixels, y, photo_ + y * ui::thumbnailSize);
}

void TerminalDisplay::thumbnail(int x, int y, const uint16_t* source, uint32_t age) {
  constexpr int size = ui::thumbnailSize;
  const int remaining = age >= ui::imageMotionMs ? 0 : ui::imageMotionMs - age;
  const int visible = size - size * remaining * remaining / (ui::imageMotionMs * ui::imageMotionMs);
  if (!visible) return;
  uint16_t scratch[size];
  uint16_t* dest = canvas_.getBuffer();
  if (!dest) {
    screen_.startWrite();
    screen_.setAddrWindow(x, y, size, visible);
  }
  for (int row = 0; row < visible; ++row) {
    uint16_t* pixels = photo_ ? photo_ + row * size : scratch;
    if (!photo_) scalePhotoRow(source, row, scratch);
    if (dest) memcpy(dest + (y + row) * kSize + x, pixels, size * sizeof(uint16_t));
    else screen_.writePixels(pixels, size);
  }
  if (!dest) screen_.endWrite();
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

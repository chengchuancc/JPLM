#pragma once
#include <stddef.h>
#include <stdint.h>

// Hardware-independent input handling, also exercised by native tests.
class ScanFrame {
 public:
  static constexpr size_t capacity = 512;
  // A false result means incomplete or rejected. Overflow discards the ENTIRE frame.
  bool feed(char c) {
    if (c == '\r' || c == '\n') return finish();
    if (static_cast<uint8_t>(c) < 32) { invalid_ = true; return false; }
    if (length_ == capacity) invalid_ = true;
    else data_[length_++] = c;
    return false;
  }
  bool finish() {
    if (invalid_ || !length_) { reset(); return false; }
    data_[length_] = 0;
    return true;
  }
  const char* data() const { return data_; }
  bool pending() const { return length_ || invalid_; }
  void reset() { length_ = 0; invalid_ = false; data_[0] = 0; }
 private:
  char data_[capacity + 1] = {};
  size_t length_ = 0;
  bool invalid_ = false;
};

inline char singleMatrixKey(uint32_t mask) {
  // Reject multi-key states (no isolation diodes on the board).
  if (!mask || (mask & (mask - 1))) return 0;
  constexpr char keys[] = {'B','O','I','S', 'U','1','2','3', 'D','4','5','6',
                           'L','7','8','9', 'R','X','0','E'};
  for (unsigned i = 0; i < 20; ++i) if (mask == (1UL << i)) return keys[i];
  return 0;
}

// A quantity is integer-only in this first version; server supports finer precision.
inline bool validQuantity(const char* s) {
  if (!s || !*s) return false;
  uint32_t value = 0;
  for (unsigned i = 0; s[i]; ++i) {
    if (i >= 6 || s[i] < '0' || s[i] > '9') return false;
    value = value * 10 + s[i] - '0';
  }
  return value > 0;
}

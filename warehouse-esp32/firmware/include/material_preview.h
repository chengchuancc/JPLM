#pragma once
#include <Arduino.h>

class MaterialPreviewCache {
 public:
  struct Preview {
    String query, code, name, unit;
    uint32_t savedAt = 0;
  };

  Preview* find(const String& query) {
    for (auto& entry : entries_) {
      if (!entry.code.isEmpty() && millis() - entry.savedAt < 5 * 60 * 1000UL
          && (query == entry.query || query.equalsIgnoreCase(entry.code))) return &entry;
    }
    return nullptr;
  }

  void remember(const String& query, const String& code, const String& name, const String& unit) {
    auto* entry = find(query);
    if (!entry) {
      entry = &entries_[next_];
      next_ = (next_ + 1) % kSize;
    }
    entry->query = query;
    entry->code = code;
    entry->name = name;
    entry->unit = unit;
    entry->savedAt = millis();
  }

  void forget(const String& query) {
    for (auto& entry : entries_) {
      if (query == entry.query || query.equalsIgnoreCase(entry.code)) entry = {};
    }
  }

  void clear() {
    for (auto& entry : entries_) entry = {};
    next_ = 0;
  }

 private:
  static constexpr unsigned kSize = 16;
  Preview entries_[kSize];
  unsigned next_ = 0;
};

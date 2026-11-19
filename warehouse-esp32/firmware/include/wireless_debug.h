#pragma once

#include <Arduino.h>
#include <IPAddress.h>

class WirelessDebug {
 public:
  static constexpr uint16_t port = 2323;

  bool enable();
  void disable();
  bool enabled() const { return workspace_ != nullptr; }
  bool attached() const { return attached_; }
  const char* code() const { return code_; }

  // Returns true once a reader authenticates and is ready for a status snapshot.
  bool tick(IPAddress ip, IPAddress subnet);
  void record(const char* line);

 private:
  void closeClient();
  void closeListener();
  void bindTo(IPAddress ip);
  bool request();
  void response(const char* status, const char* type, const char* body,
                size_t length, uint32_t nextOffset = 0);
  void flush();

  struct Workspace;
  Workspace* workspace_ = nullptr;
  IPAddress address_;
  int server_ = -1, client_ = -1;
  char code_[9] = {};
  uint32_t createdAt_ = 0, nextPoll_ = 0, nextBind_ = 0, acceptedAt_ = 0;
  uint32_t written_ = 0, lastReaderAt_ = 0, retryAt_ = 0;
  unsigned failures_ = 0;
  bool attached_ = false, coolingDown_ = false;
};

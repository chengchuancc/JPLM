#pragma once
#include <Preferences.h>
#include <WebServer.h>

class Provisioning {
 public:
  void begin();
  void open();
  void close();
  bool tick();
  bool active() const { return active_; }
  const String& key() const { return key_; }
  const String& network() const { return apName_; }
  const String& password() const { return apPassword_; }
  const char* message() const { return message_; }
 private:
  void configure();
  bool onAccessPoint();
  Preferences store_;
  WebServer web_{80};
  String ssid_, pass_, key_;
  String candidateSsid_, candidatePass_;
  String apName_, apPassword_;
  const char* message_ = "";
  uint32_t deadline_ = 0, closeAt_ = 0;
  bool active_ = false, trying_ = false, available_ = false;
};

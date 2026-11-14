#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

class PlmClient {
 public:
  bool login();
  bool lookup(const String& code, JsonDocument& result);
  bool submit(const String& exactPayload, JsonDocument& result);
  bool authenticated() const { return !cookie_.isEmpty(); }
  const String& error() const { return error_; }
  const String& userId() const { return userId_; }
  int status() const { return status_; }
 private:
  bool request(const char* method, const String& path, const String& payload, JsonDocument& result);
  String cookie_, error_, userId_;
  int status_ = 0;
};

#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

class PlmClient {
 public:
  bool operators(const String& key, unsigned offset, JsonDocument& result);
  bool select(const String& key, const String& user, JsonDocument& result);
  void logout() { token_ = ""; userId_ = ""; }
  void useSession(const String& token) { token_ = token; }
  bool probe(bool fresh = false);
  bool prepare();
  bool keepAlive();
  bool lookup(const String& code, JsonDocument& result);
  bool submit(const String& exactPayload, JsonDocument& result);
  bool history(unsigned offset, JsonDocument& result);
  bool removeMovement(const String& id, const String& payload, JsonDocument& result);
  bool thumbnail(const String& id, uint16_t* pixels);
  bool authenticated() const { return !token_.isEmpty(); }
  bool viaEdge() const { return edge_; }
  const String& error() const { return error_; }
  const String& userId() const { return userId_; }
  int status() const { return status_; }
  bool rejected() const { return rejected_; }
  bool reusedConnection() const { return reusedConnection_; }
  uint32_t connectMs() const { return connectMs_; }
  uint32_t headersMs() const { return headersMs_; }
  uint32_t bodyMs() const { return bodyMs_; }
 private:
  class Request : public HTTPClient {
   public:
    using HTTPClient::connect;
  };
  WiFiClient* prepareRequest(const String& path, bool binary);
  bool connect();
  void resetTiming();
  bool request(const char* method, const String& path, const String& payload, JsonDocument& result,
               const String& deviceKey = "", uint16_t* pixels = nullptr);
  String token_, error_, userId_;
  WiFiClient plain_;
  WiFiClientSecure secure_;
  Request http_;
  uint32_t lastRequestAt_ = 0;
  uint32_t connectMs_ = 0, headersMs_ = 0, bodyMs_ = 0;
  int status_ = 0;
  bool edge_ = false;
  bool rejected_ = false;
  bool reusedConnection_ = false;
};

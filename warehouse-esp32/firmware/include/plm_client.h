#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

class PlmClient {
 public:
  struct Transfer {
    unsigned received = 0;
    int expected = -1, retryHttp = 0, tlsError = 0;
    const char* phase = "none";
    const char* cache = "-";
  };
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
  bool checkFirmware(const String& key, const String& failed, JsonDocument& result);
  bool installFirmware(const String& key, const String& sha256, unsigned size);
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
  const Transfer& transfer() const { return transfer_; }
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
  Transfer transfer_;
  uint32_t lastRequestAt_ = 0;
  uint32_t connectMs_ = 0, headersMs_ = 0, bodyMs_ = 0;
  int status_ = 0;
  bool edge_ = false;
  bool rejected_ = false;
  bool reusedConnection_ = false;
};

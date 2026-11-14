#include "plm_client.h"
#include "settings.h"
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>

namespace {
String urlEncode(const String& value) {
  String out;
  for (size_t i = 0; i < value.length(); ++i) {
    const uint8_t c = static_cast<uint8_t>(value[i]);
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') out += char(c);
    else { char hex[4]; snprintf(hex, sizeof(hex), "%%%02X", c); out += hex; }
  }
  return out;
}
}

bool PlmClient::request(const char* method, const String& path, const String& payload,
                        JsonDocument& result) {
  error_ = ""; status_ = 0; result.clear();
  if (WiFi.status() != WL_CONNECTED) { error_ = "WiFi disconnected"; return false; }
  String base = TERMINAL_API_URL;
  if (!base.endsWith("/")) base += '/';
  const bool tls = base.startsWith("https://");
  if (!tls && (!TERMINAL_ALLOW_HTTP || !base.startsWith("http://"))) {
    error_ = "HTTPS required (LAN HTTP requires explicit opt-in)"; return false;
  }
  WiFiClient plain;
  WiFiClientSecure secure;
  if (tls) {
    if (!strstr(TERMINAL_ROOT_CA, "-----BEGIN CERTIFICATE-----")) {
      error_ = "Configure server root CA in local_config.h"; return false;
    }
    if (time(nullptr) < 1700000000) { error_ = "Waiting for NTP time before TLS"; return false; }
    secure.setCACert(TERMINAL_ROOT_CA);
    secure.setHandshakeTimeout(10);
  }
  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(8000);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  if (!http.begin(tls ? static_cast<WiFiClient&>(secure) : plain, base + "api/" + path)) {
    error_ = "Invalid API URL"; return false;
  }
  const char* headers[] = {"Set-Cookie"};
  http.collectHeaders(headers, 1);
  http.addHeader("Accept", "application/json");
  if (!cookie_.isEmpty()) http.addHeader("Cookie", cookie_);
  if (!payload.isEmpty()) http.addHeader("Content-Type", "application/json; charset=utf-8");
  status_ = http.sendRequest(method, payload);
  if (status_ <= 0) {
    error_ = "Transport error: " + HTTPClient::errorToString(status_);
    http.end(); return false;
  }
  // Small endpoints only. Bound both known and chunked bodies before parsing.
  if (http.getSize() > 8192) { error_ = "API response too large"; http.end(); return false; }
  // HTTPClient handles chunk decoding in writeToStream; a capped sink prevents allocation spikes.
  class Sink : public Stream {
   public:
    String data;
    bool overflow = false;
    size_t write(uint8_t c) override {
      if (data.length() >= 8192) { overflow = true; return 0; }
      data += static_cast<char>(c); return 1;
    }
    int available() override { return 0; }
    int read() override { return -1; }
    int peek() override { return -1; }
    void flush() override {}
  } sink;
  const int received = http.writeToStream(&sink);
  const String setCookie = http.header("Set-Cookie");
  http.end();
  if (status_ == 401) { cookie_ = ""; userId_ = ""; }
  if (received < 0 || sink.overflow) { error_ = "Incomplete or oversized API response"; return false; }
  if (deserializeJson(result, sink.data)) { error_ = "Invalid API JSON"; return false; }
  if (status_ < 200 || status_ >= 300) {
    error_ = result["error"] | "API request rejected"; return false;
  }
  if (setCookie.startsWith("plm_session=") || setCookie.startsWith("plm_session_")) {
    const int end = setCookie.indexOf(';');
    cookie_ = end < 0 ? setCookie : setCookie.substring(0, end);
  }
  return true;
}

bool PlmClient::login() {
  cookie_ = ""; userId_ = "";
  if (!strlen(TERMINAL_EMAIL) || !strlen(TERMINAL_PASSWORD)) {
    error_ = "Configure terminal account in local_config.h"; return false;
  }
  JsonDocument data, reply;
  data["email"] = TERMINAL_EMAIL; data["password"] = TERMINAL_PASSWORD;
  String body; serializeJson(data, body);
  if (!request("POST", "auth/login", body, reply)) return false;
  if (cookie_.isEmpty()) { error_ = "Login returned no session cookie"; return false; }
  if (!request("GET", "auth/status", "", reply)) { cookie_ = ""; return false; }
  if (!reply["authenticated"].as<bool>() || reply["user"]["must_change"].as<bool>()) {
    cookie_ = ""; error_ = "Account requires password change in JPLM web UI"; return false;
  }
  userId_ = reply["user"]["id"].as<String>();
  if (userId_.isEmpty()) { cookie_ = ""; error_ = "Missing user identity"; return false; }
  return true;
}
bool PlmClient::lookup(const String& code, JsonDocument& result) {
  return request("GET", "warehouse/material?q=" + urlEncode(code), "", result);
}
bool PlmClient::submit(const String& exactPayload, JsonDocument& result) {
  if (!request("POST", "warehouse/movements", exactPayload, result)) return false;
  if (result["id"].as<String>().length() != 24 || !result["stock"].is<double>()) {
    error_ = "Incomplete submit result; retain request for retry"; return false;
  }
  return true;
}

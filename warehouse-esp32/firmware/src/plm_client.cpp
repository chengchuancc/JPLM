#include "plm_client.h"
#include "firmware_version.h"
#include "settings.h"
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <sdkconfig.h>
#include <time.h>

namespace {
constexpr size_t kMaxJsonBytes = 24576;
constexpr uint32_t kConnectionIdleMs = 45000;
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

void deviceInfo(JsonDocument& data) {
  data["ip"] = WiFi.localIP().toString();
  data["mac"] = WiFi.macAddress();
  data["firmware"] = String("scanner/") + firmwareVersion;
}

class ImageSink : public Stream {
 public:
  static constexpr size_t length = 80 * 80 * sizeof(uint16_t);
  explicit ImageSink(uint16_t* pixels) : bytes_(reinterpret_cast<uint8_t*>(pixels)) {}
  size_t write(uint8_t c) override {
    if (count >= length) return 0;
    bytes_[count++] = c;
    return 1;
  }
  size_t write(const uint8_t* data, size_t size) override {
    if (size > length - count) return 0;
    memcpy(bytes_ + count, data, size);
    count += size;
    return size;
  }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
  size_t count = 0;
 private:
  uint8_t* bytes_;
};
}

void PlmClient::resetTiming() {
  error_ = "";
  status_ = 0;
  rejected_ = reusedConnection_ = false;
  connectMs_ = headersMs_ = bodyMs_ = 0;
  transfer_ = {};
}

WiFiClient* PlmClient::prepareRequest(const String& path, bool binary) {
  transfer_.phase = "setup";
  if (WiFi.status() != WL_CONNECTED) { error_ = "Wi-Fi 已断开"; return nullptr; }
  String base = TERMINAL_API_URL;
  if (!base.endsWith("/")) base += '/';
  const bool tls = base.startsWith("https://");
  if (!tls && (!TERMINAL_ALLOW_HTTP || !base.startsWith("http://"))) {
    error_ = "HTTPS required (LAN HTTP requires explicit opt-in)"; return nullptr;
  }
  WiFiClient& transport = tls ? static_cast<WiFiClient&>(secure_) : plain_;
  if (millis() - lastRequestAt_ > kConnectionIdleMs) transport.stop();
  reusedConnection_ = transport.connected();
  if (tls) {
    if (!strstr(TERMINAL_ROOT_CA, "-----BEGIN CERTIFICATE-----")) {
      error_ = "Configure server root CA in local_config.h"; return nullptr;
    }
#ifdef CONFIG_MBEDTLS_HAVE_TIME_DATE
    if (time(nullptr) < 1700000000) { error_ = "等待网络时间同步"; return nullptr; }
#endif
    secure_.setCACert(TERMINAL_ROOT_CA);
    secure_.setHandshakeTimeout(4);
  }
  http_.setReuse(true);
  http_.setConnectTimeout(3500);
  http_.setTimeout(4500);
  http_.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  if (!http_.begin(transport, base + (binary ? "" : "api/") + path)) {
    error_ = "Invalid API URL"; return nullptr;
  }
  return &transport;
}

bool PlmClient::connect() {
  transfer_.phase = "connect";
  const uint32_t started = millis();
  const bool ok = http_.connect();
  lastRequestAt_ = millis();
  connectMs_ = lastRequestAt_ - started;
  if (!ok) {
    status_ = HTTPC_ERROR_CONNECTION_REFUSED;
    if (String(TERMINAL_API_URL).startsWith("https://")) {
      char message[64];
      transfer_.tlsError = secure_.lastError(message, sizeof(message));
    }
    error_ = "PLM 连接未建立";
    http_.end();
  }
  return ok;
}

bool PlmClient::prepare() {
  resetTiming();
  if (!prepareRequest("health", false)) return false;
  return reusedConnection_ || connect();
}

bool PlmClient::keepAlive() {
  resetTiming();
  if (millis() - lastRequestAt_ >= kConnectionIdleMs || !http_.connected()) return false;
  return probe();
}

bool PlmClient::request(const char* method, const String& path, const String& payload,
                        JsonDocument& result, const String& deviceKey, uint16_t* pixels) {
  resetTiming();
  result.clear();
  WiFiClient* transport = prepareRequest(path, pixels != nullptr);
  if (!transport || !connect()) return false;
  HTTPClient& http = http_;
  const char* headers[] = {"X-JPLM-Edge", "Content-Type", "Date", "X-JPLM-Cache"};
  http.collectHeaders(headers, pixels ? 4 : 3);
  http.addHeader("Accept", pixels ? "application/octet-stream" : "application/json");
  if (!deviceKey.isEmpty()) http.addHeader("X-Scanner-Key", deviceKey);
  else if (path != "health" && !token_.isEmpty()) http.addHeader("Authorization", "Bearer " + token_);
  if (!payload.isEmpty()) http.addHeader("Content-Type", "application/json; charset=utf-8");
  const uint32_t sentAt = millis();
  transfer_.phase = "http";
  status_ = http.sendRequest(method, payload);
  headersMs_ = millis() - sentAt;
  if (status_ <= 0) {
    error_ = "连接 PLM 失败 " + String(status_);
    transport->stop();
    http.end(); return false;
  }
  const uint32_t bodyAt = millis();
  transfer_.phase = "body";
  transfer_.expected = http.getSize();
  if (pixels) {
    const String cache = http.header("X-JPLM-Cache");
    for (const char* state : {"HIT", "MISS", "BYPASS", "EXPIRED", "REVALIDATED", "STALE", "UPDATING"}) {
      if (cache == state) { transfer_.cache = state; break; }
    }
  }
  if (status_ == 401 && deviceKey.isEmpty() && path != "health") logout();
  if (pixels && status_ == 200) {
    ImageSink sink(pixels);
    const bool correctSize = transfer_.expected == static_cast<int>(ImageSink::length);
    const bool correctType = http.header("Content-Type") == "application/octet-stream";
    const bool valid = correctSize && correctType;
    const int received = valid ? http.writeToStream(&sink) : -1;
    transfer_.received = sink.count;
    if (!valid) transfer_.phase = correctSize ? "image-type" : "image-length";
    bodyMs_ = millis() - bodyAt;
    if (received < 0 || sink.count != ImageSink::length) transport->stop();
    http.end();
    if (received < 0 || sink.count != ImageSink::length) {
      error_ = "物料图片不完整";
      return false;
    }
    return true;
  }
  // Small endpoints only. Bound both known and chunked bodies before parsing.
  if (http.getSize() > static_cast<int>(kMaxJsonBytes)) {
    transfer_.phase = "length-limit";
    error_ = "PLM 返回数据过长";
    transport->stop();
    http.end();
    return false;
  }
  // HTTPClient handles chunk decoding in writeToStream; a capped sink prevents allocation spikes.
  class Sink : public Stream {
   public:
    String data;
    bool overflow = false;
    size_t write(uint8_t c) override {
      if (data.length() >= kMaxJsonBytes || !data.concat(static_cast<char>(c))) { overflow = true; return 0; }
      return 1;
    }
    size_t write(const uint8_t* bytes, size_t length) override {
      if (length > kMaxJsonBytes - data.length()
          || !data.concat(reinterpret_cast<const char*>(bytes), length)) {
        overflow = true;
        return 0;
      }
      return length;
    }
    int available() override { return 0; }
    int read() override { return -1; }
    int peek() override { return -1; }
    void flush() override {}
  } sink;
  const int received = http.writeToStream(&sink);
  transfer_.received = sink.data.length();
  bodyMs_ = millis() - bodyAt;
  if (path == "health") edge_ = http.header("X-JPLM-Edge") == "up";
  const String date = path == "scanner/operators" && transport == &secure_ && time(nullptr) < 1700000000
                      ? http.header("Date") : String();
  if (received < 0 || sink.overflow) transport->stop();
  http.end();
  if (received < 0 || sink.overflow) { error_ = "PLM 返回数据不完整"; return false; }
  if (deserializeJson(result, sink.data)) {
    transfer_.phase = "json";
    error_ = status_ == 404 ? "服务器缺少扫码枪接口"
                          : status_ >= 500 ? "PLM 服务异常 " + String(status_)
                                           : "PLM 返回格式异常";
    return false;
  }
  if (status_ < 200 || status_ >= 300) {
    transfer_.phase = "server";
    rejected_ = result["error"].is<const char*>()
        && (status_ == 400 || status_ == 403 || status_ == 404 || status_ == 409 || status_ == 422);
    error_ = result["error"] | "PLM 请求失败";
    if (status_ == 401 || status_ == 403) transfer_.phase = "authorization";
    else if (pixels) {
      if (error_ == "扫码枪缩略图服务未开启") transfer_.phase = "image-service-disabled";
      else if (error_ == "未找到物料图片") transfer_.phase = "image-file-missing";
      else if (error_ == "未找到可显示的物料图片") transfer_.phase = "image-not-eligible";
      else if (error_ == "无法生成物料缩略图") transfer_.phase = "image-decode";
    }
    return false;
  }
  if (result["server_time"].isNull() && !date.isEmpty()) {
    // Legacy PLM servers still supply the time in the HTTPS response's Date header.
    tm utc{};
    const char* end = strptime(date.c_str(), "%a, %d %b %Y %H:%M:%S GMT", &utc);
    if (end && !*end) result["server_time"] = static_cast<long>(mktime(&utc));
  }
  return true;
}

bool PlmClient::probe(bool fresh) {
  if (fresh) {
    plain_.stop();
    secure_.stop();
  }
  edge_ = false;
  JsonDocument reply;
  return request("GET", "health", "", reply) && reply["ok"].as<bool>();
}

bool PlmClient::operators(const String& key, unsigned offset, JsonDocument& result) {
  JsonDocument data;
  deviceInfo(data);
  data["register"] = true;
  data["offset"] = offset;
  String body; serializeJson(data, body);
  if (!request("POST", "scanner/operators", body, result, key)) return false;
  if (result["users"].is<JsonArray>() && result["has_more"].is<bool>()) return true;
  transfer_.phase = "schema";
  error_ = "设备用户列表格式无效";
  return false;
}

bool PlmClient::select(const String& key, const String& user, JsonDocument& result) {
  logout();
  JsonDocument data;
  deviceInfo(data);
  data["user_id"] = user;
  String body; serializeJson(data, body);
  if (!request("POST", "scanner/session", body, result, key)) return false;
  String token = result["token"].as<String>();
  if (token.length() != 64 || result["user"]["id"].as<String>() != user) {
    transfer_.phase = "schema";
    error_ = "登录返回的身份无效";
    return false;
  }
  token_ = token;
  userId_ = user;
  return true;
}
bool PlmClient::lookup(const String& code, JsonDocument& result) {
  const String path = "warehouse/material?q=" + urlEncode(code);
  if (request("GET", path, "", result)) return true;
  // An idle peer can close a reused connection just before the request is sent.
  if (!reusedConnection_ || status_ >= 0) return false;
  const int firstStatus = status_;
  const bool ok = request("GET", path, "", result);
  transfer_.retryHttp = firstStatus;
  return ok;
}
bool PlmClient::submit(const String& exactPayload, JsonDocument& result) {
  if (!request("POST", "warehouse/movements", exactPayload, result)) return false;
  if (result["id"].as<String>().length() != 24 || !result["stock"].is<double>()) {
    transfer_.phase = "schema";
    error_ = "Incomplete submit result; retain request for retry"; return false;
  }
  return true;
}

bool PlmClient::history(unsigned offset, JsonDocument& result) {
  if (!request("GET", "warehouse/movements?limit=6&offset=" + String(offset), "", result)) return false;
  if (result.is<JsonArray>()) return true;
  transfer_.phase = "schema";
  error_ = "历史记录格式无效";
  return false;
}

bool PlmClient::removeMovement(const String& id, const String& payload, JsonDocument& result) {
  if (!request("DELETE", "warehouse/movements/" + urlEncode(id), payload, result)) return false;
  if (result["id"].as<String>() == id) return true;
  transfer_.phase = "schema";
  error_ = "缺少删除结果，可安全重试";
  return false;
}

bool PlmClient::thumbnail(const String& id, uint16_t* pixels) {
  JsonDocument reply;
  return request("GET", "files/" + urlEncode(id) + "?scanner_thumb=1", "", reply, "", pixels);
}

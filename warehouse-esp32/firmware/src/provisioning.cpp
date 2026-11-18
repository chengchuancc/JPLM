#include "provisioning.h"
#include "settings.h"
#include <ArduinoJson.h>
#include <WiFi.h>
#include <esp_system.h>

namespace {
const char kForm[] PROGMEM = R"HTML(<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JPLM 扫码枪配网</title>
<style>body{font:17px system-ui;max-width:28em;margin:24px auto;padding:0 16px}
label,input,button{display:block;box-sizing:border-box;width:100%;margin:8px 0 16px}
input,button{font:inherit;padding:10px}</style>
<h1>扫码枪配网</h1>
<form method="post" action="/configure">
<label>2.4 GHz Wi-Fi 名称<input name="ssid" maxlength="32" required></label>
<label>Wi-Fi 密码<input name="password" maxlength="64" type="password"></label>
<button>连接</button></form></html>)HTML";

bool validKey(const String& key) {
  return key.length() == 64 && strspn(key.c_str(), "0123456789abcdef") == 64;
}

String makeKey() {
  uint8_t bytes[32];
  char hex[65];
  constexpr char digits[] = "0123456789abcdef";
  esp_fill_random(bytes, sizeof(bytes));
  for (size_t i = 0; i < sizeof(bytes); ++i) {
    hex[i * 2] = digits[bytes[i] >> 4];
    hex[i * 2 + 1] = digits[bytes[i] & 0x0f];
  }
  hex[64] = '\0';
  return hex;
}
}

void Provisioning::begin() {
  available_ = store_.begin("scanner-wifi", false);
  JsonDocument data;
  if (available_ && !deserializeJson(data, store_.getString("config"))) {
    ssid_ = data["ssid"] | "";
    pass_ = data["password"] | "";
    key_ = data["key"] | "";
  }
  if (ssid_.isEmpty()) { ssid_ = TERMINAL_WIFI_SSID; pass_ = TERMINAL_WIFI_PASSWORD; }
  WiFi.persistent(false);
  WiFi.setSleep(false);
  WiFi.mode(WIFI_STA);
  WiFi.setScanMethod(WIFI_ALL_CHANNEL_SCAN);
  WiFi.setSortMethod(WIFI_CONNECT_AP_BY_SIGNAL);
  if (available_) {
    const String savedKey = store_.getString("identity", "");
    if (validKey(savedKey)) {
      key_ = savedKey;
    } else {
      if (!validKey(key_)) key_ = TERMINAL_DEVICE_KEY;
      if (!validKey(key_)) key_ = makeKey();
      if (store_.putString("identity", key_) != 64) key_ = "";
    }
  }
  WiFi.setAutoReconnect(true);
  web_.on("/", HTTP_GET, [this]() {
    if (onAccessPoint()) {
      web_.sendHeader("Cache-Control", "no-store");
      web_.send_P(200, "text/html; charset=utf-8", kForm);
    }
  });
  web_.on("/configure", HTTP_POST, [this]() { if (onAccessPoint()) configure(); });
  if (ssid_.isEmpty()) open();
  else WiFi.begin(ssid_.c_str(), pass_.c_str());
}

void Provisioning::open() {
  if (active_) return;
  char name[18], password[9];
  snprintf(name, sizeof(name), "JPLM-%04lX", static_cast<unsigned long>(ESP.getEfuseMac() & 0xffff));
  WiFi.mode(WIFI_AP_STA);
  snprintf(password, sizeof(password), "%08lu", static_cast<unsigned long>(esp_random() % 100000000));
  apName_ = name;
  apPassword_ = password;
  if (!WiFi.softAP(apName_.c_str(), apPassword_.c_str(), 1, false, 1)) {
    WiFi.mode(WIFI_STA);
    message_ = "配网热点启动失败";
    return;
  }
  web_.begin();
  active_ = true;
  message_ = "用手机连接上方 Wi-Fi";
}

bool Provisioning::onAccessPoint() {
  if (active_ && web_.client().localIP() == WiFi.softAPIP()) return true;
  web_.send(403, "text/plain", "Connect to the scanner setup Wi-Fi.");
  return false;
}

void Provisioning::configure() {
  if (trying_ || closeAt_) {
    web_.send(409, "text/plain; charset=utf-8", "正在连接，请查看扫码枪屏幕");
    return;
  }
  if (!available_) {
    web_.send(503, "text/plain; charset=utf-8", "扫码枪存储不可用");
    return;
  }
  const String ssid = web_.arg("ssid"), password = web_.arg("password");
  if (ssid.isEmpty() || ssid.length() > 32 || password.length() > 64) {
    web_.send(400, "text/plain; charset=utf-8", "请检查 Wi-Fi 名称或密码");
    return;
  }
  candidateSsid_ = ssid;
  candidatePass_ = password;
  web_.sendHeader("Cache-Control", "no-store");
  web_.send(200, "text/plain; charset=utf-8", "正在连接，请查看扫码枪屏幕。失败时可以返回重试。");
  WiFi.disconnect(false);
  WiFi.begin(candidateSsid_.c_str(), candidatePass_.c_str());
  trying_ = true;
  deadline_ = millis() + 20000;
  message_ = "正在连接所选 Wi-Fi";
}

void Provisioning::close() {
  if (!active_) return;
  web_.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  if (trying_ && !ssid_.isEmpty()) WiFi.begin(ssid_.c_str(), pass_.c_str());
  active_ = trying_ = false;
  closeAt_ = 0;
  candidateSsid_ = candidatePass_ = "";
}

bool Provisioning::tick() {
  if (!active_) return false;
  const char* previous = message_;
  web_.handleClient();
  if (closeAt_ && static_cast<int32_t>(millis() - closeAt_) >= 0) {
    close();
    return true;
  }
  if (!trying_) return message_ != previous;
  if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == candidateSsid_) {
    JsonDocument data;
    data["ssid"] = candidateSsid_;
    data["password"] = candidatePass_;
    String encoded;
    serializeJson(data, encoded);
    if (store_.putString("config", encoded) == encoded.length()) {
      ssid_ = candidateSsid_;
      pass_ = candidatePass_;
      message_ = "已连接，正在启动扫码枪";
      closeAt_ = millis() + 300;
    } else {
      message_ = "无法保存配网信息";
    }
    trying_ = false;
    return true;
  }
  if (static_cast<int32_t>(millis() - deadline_) >= 0) {
    trying_ = false;
    WiFi.disconnect(false);
    message_ = "连接失败，请检查 Wi-Fi 后重试";
    return true;
  }
  return message_ != previous;
}

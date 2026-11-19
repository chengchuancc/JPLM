#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_ota_ops.h>
#include <esp_system.h>
#include <esp_wifi.h>
#include <sdkconfig.h>
#include <atomic>
#include <stdarg.h>
#include <sys/time.h>
#include <time.h>
#include <utility>
#include "firmware_version.h"
#include "material_preview.h"
#include "peripherals.h"
#include "provisioning.h"
#include "settings.h"
#include "terminal_display.h"
#include "terminal_network.h"
#include "wireless_debug.h"

namespace {
enum class Page { Users, Home, Material, Quantity, History, Record, Delete };
enum class Route { Checking, Local, Cloud, Unconfirmed };
// ESP-IDF 4.4 maps 80–84 quarter-dBm units to its highest table entry, 20 dBm.
constexpr int8_t kWifiMaxTxPower = 80;
using ui::Icon;
Peripherals hardware;
TerminalDisplay screen(hardware.display());
Provisioning wifi;
TerminalNetwork network;
TerminalNetwork background;
Preferences store;
MaterialPreviewCache previews;
WirelessDebug wirelessDebug;
Peripherals::ScanStats scanStats;
uint32_t scanStartedAt = 0, scanStartBytes = 0, scanStartRejected = 0;
Page page = Page::Users;
uint32_t generation = 0, usersAt = 0, healthAt = 0, batteryAt = 0, nextAnimation = 0;
uint32_t keepAliveAt = 0, lastInteractionAt = 0;
uint32_t keyPressedAt = 0;
uint32_t imageShownAt = 0;
char lastKey = 0;
bool dirty = true, connected = false;
bool debugPanel = false;
uint32_t debugSampleAt = 0;
bool freshRoute = true;
Route route = Route::Checking;
unsigned wifiRevision = 0;
uint8_t lastBssid[6] = {};
uint32_t signalAt = 0;
bool ready = false, backgroundReady = false, hasStorage = false, scanning = false;
bool clockReady = false, lowBatteryAlert = false;
bool verifyFirmwareBoot = false, rebootForFirmware = false;
uint32_t firmwareCheckAt = 0, firmwareRetryAt = 0, firmwareRebootAt = 0;
unsigned firmwareSize = 0;
String firmwareDigest, failedFirmware;
bool loadingVisible = false, motionVisible = false;
bool scannedMaterial = false, warmWanted = false;
int batteryLevel = -1, filteredMillivolts = 0;
std::atomic<unsigned> wifiDisconnects{0}, wifiReason{0};
unsigned reportedDisconnects = 0;
int lastSignal = 0;
bool firstSubmit = false;
String notice, deviceName, userId, userName, typed, query, waitingScan;
String deviceState, verification, sessionToken, signInWanted;
String partId, projectId, partCode, partName, custodian, unit, stock, imageId, quantity;
String pending, pendingUser, pendingServer;
const char* movementType = "";
bool lookupWanted = false, imageWanted = false, imageShown = false, historyWanted = false;
uint16_t imagePixels[80 * 80];
unsigned userIndex = 0, userOffset = 0, historyIndex = 0, historyOffset = 0;
bool moreUsers = false;
JsonDocument users, history;
String usbLine;

void diagnostic(const char* format, ...) {
  char line[192];
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(line, sizeof(line), format, arguments);
  va_end(arguments);
  Serial.print(line);
  wirelessDebug.record(line);
}

void debugLog(const char* format, ...) {
  if (!wirelessDebug.enabled()) return;
  char line[192];
  const int prefix = snprintf(line, sizeof(line), "[%lums] ", static_cast<unsigned long>(millis()));
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(line + prefix, sizeof(line) - prefix, format, arguments);
  va_end(arguments);
  wirelessDebug.record(line);
}

void show(const String& text, bool error = false) {
  notice = text;
  dirty = true;
  if (text.length()) Serial.println(text);
  if (error) hardware.beep(false);
}

void go(Page next) {
  if (page != next) lastKey = 0;
  page = next;
  ++generation;
  notice = "";
  dirty = true;
}

String formatQuantity(double value) {
  String text(value, 6);
  if (text.indexOf('.') < 0) return text;
  while (text.endsWith("0")) text.remove(text.length() - 1);
  if (text.endsWith(".")) text.remove(text.length() - 1);
  return text;
}

bool startRequest(TerminalNetwork& worker, NetworkJob job) {
  if (!worker.start(std::move(job))) return false;
  const auto& active = worker.job();
  debugLog("PLM #%u %s start context=%lu\n", worker.requestId(), operationLabel(active.operation),
           static_cast<unsigned long>(active.generation));
  return true;
}

bool start(Operation operation, const String& argument = "", const String& payload = "",
           unsigned offset = 0, uint16_t* pixels = nullptr) {
  if (!startRequest(network, {operation, generation, argument, payload, offset, pixels})) return false;
  keepAliveAt = millis() + 25000;
  return true;
}

void userList(bool keepRoster = false) {
  go(Page::Users);
  userId = userName = sessionToken = "";
  previews.clear();
  warmWanted = false;
  signInWanted = "";
  if (!keepRoster) {
    users.clear();
    userOffset = userIndex = 0;
    moreUsers = false;
  }
  usersAt = millis();
  lookupWanted = imageWanted = historyWanted = false;
}

void loadMaterial(const String& input, bool fromScanner = false) {
  go(Page::Material);
  query = input;
  scannedMaterial = fromScanner;
  partCode = input;
  partId = projectId = partName = custodian = unit = stock = imageId = "";
  const auto* preview = previews.find(query);
  if (preview) {
    partCode = preview->code;
    partName = preview->name;
    unit = preview->unit;
  }
  imageWanted = imageShown = false;
  lookupWanted = true;
  debugLog("Lookup queued context=%lu source=%s local_preview=%s wifi=%s\n",
           static_cast<unsigned long>(generation), fromScanner ? "scanner" : "keyboard",
           preview ? "hit" : "miss", connected ? "up" : "down");
  show(connected ? "正在查找物料..." : "等待联网后查找物料");
}

void loadHistory(bool firstPage) {
  go(Page::History);
  if (firstPage) historyOffset = 0;
  historyIndex = 0;
  history.clear();
  historyWanted = true;
  show("正在读取历史记录...");
}

String newRequestId() {
  String id;
  for (unsigned i = 0; i < 4; ++i) {
    char hex[9];
    snprintf(hex, sizeof(hex), "%08lx", static_cast<unsigned long>(esp_random()));
    id += hex;
  }
  return id;
}

void readPending() {
  hasStorage = store.begin("jplm", false);
  if (!hasStorage || !store.isKey("pending")) return;
  JsonDocument data;
  if (deserializeJson(data, store.getString("pending")) || !data["body"].is<const char*>()
      || !data["user"].is<const char*>() || !data["server"].is<const char*>()) {
    pending = "CORRUPT";
    return;
  }
  pending = data["body"].as<String>();
  pendingUser = data["user"].as<String>();
  pendingServer = data["server"].as<String>();
}

bool clearPending() {
  if (!hasStorage || !store.remove("pending")) return false;
  pending = pendingUser = pendingServer = "";
  return true;
}

void retryPending() {
  if (pending == "CORRUPT" || pendingServer != TERMINAL_API_URL) {
    show("待处理记录异常，请管理员核对", true);
  } else if (userId != pendingUser) {
    show("请由原经办人处理待确认登记", true);
  } else if (!connected || network.busy()) {
    show(connected ? "请求处理中，请稍后重试" : "联网后可重试原登记");
  } else {
    firstSubmit = false;
    start(Operation::Submit, "", pending);
    show("正在重试原登记...");
  }
}

void submit() {
  if (!pending.isEmpty()) { retryPending(); return; }
  if (!validQuantity(quantity.c_str())) { show("请输入 1 至 999999", true); return; }
  if (!connected || network.busy()) {
    show(connected ? "请求处理中，请稍后再按确定" : "网络断开，数量已保留");
    return;
  }
  JsonDocument request, saved;
  request["request_id"] = newRequestId();
  request["project_id"] = projectId;
  request["part_id"] = partId;
  request["qty"] = quantity.toInt();
  request["type"] = movementType;
  String body, encoded;
  serializeJson(request, body);
  saved["body"] = body;
  saved["user"] = userId;
  saved["server"] = TERMINAL_API_URL;
  serializeJson(saved, encoded);
  if (!hasStorage || store.putString("pending", encoded) != encoded.length()) {
    show("无法保存登记，未提交", true);
    return;
  }
  pending = body;
  pendingUser = userId;
  pendingServer = TERMINAL_API_URL;
  firstSubmit = true;
  start(Operation::Submit, partId, pending);
  show("正在登记...");
}

void deleteMovement() {
  const JsonObjectConst record = history[historyIndex].as<JsonObjectConst>();
  if (!record["expected"].is<JsonObject>() || !record["can_delete"].as<bool>()) {
    show("该记录不可删除", true);
    return;
  }
  if (!connected || network.busy()) {
    show(connected ? "请求处理中，请稍后再按确定" : "网络断开，尚未删除");
    return;
  }
  JsonDocument body;
  body["project_id"] = record["project_id"];
  body["expected"] = record["expected"];
  String payload;
  serializeJson(body, payload);
  start(Operation::Delete, record["id"].as<String>(), payload);
  show("正在删除并重新计算库存...");
}

bool clockBlocksNetwork() {
#ifdef CONFIG_MBEDTLS_HAVE_TIME_DATE
  return !clockReady && String(TERMINAL_API_URL).startsWith("https://");
#else
  return false;
#endif
}

bool idleForFirmware() {
  if (!connected || network.busy() || scanning || debugPanel || wifi.active()
      || !pending.isEmpty() || !signInWanted.isEmpty() || !waitingScan.isEmpty() || !typed.isEmpty()
      || lookupWanted || historyWanted || page == Page::Quantity || page == Page::Delete) return false;
  const unsigned quiet = page == Page::Home || page == Page::Users ? 6000 : 45000;
  return millis() - lastInteractionAt >= quiet;
}

void rebootAfterFirmware() {
  if (!rebootForFirmware) return;
  if (!idleForFirmware()) {
    if (firmwareRebootAt && notice == "固件已校验，即将重启") show("");
    firmwareRebootAt = 0;
    return;
  }
  if (!firmwareRebootAt) {
    firmwareRebootAt = millis() + 1400;
    show("固件已校验，即将重启");
  } else if (int32_t(millis() - firmwareRebootAt) >= 0) {
    ESP.restart();
  }
}

void scheduleNetwork() {
  if (!ready || !connected || clockBlocksNetwork() || wifi.active() || firmwareRebootAt) return;
  if (!network.busy()) {
    if (page == Page::Users && !signInWanted.isEmpty()) {
      if (start(Operation::SignIn, signInWanted, wifi.key())) signInWanted = "";
    } else if (page == Page::Users && int32_t(millis() - usersAt) >= 0) {
      usersAt = millis() + 8000;
      if (wifi.key().length() == 64) start(Operation::Users, wifi.key(), "", userOffset);
      else show("设备身份无法保存，请检查存储");
    } else if (page == Page::Material && lookupWanted) {
      lookupWanted = warmWanted = false;
      start(Operation::Lookup, query);
      show("正在查找物料...");
    } else if (page == Page::History && historyWanted) {
      historyWanted = false;
      start(Operation::History, "", "", historyOffset);
    } else if (!userId.isEmpty() && warmWanted) {
      warmWanted = false;
      start(Operation::Prepare);
    } else if (!userId.isEmpty() && millis() - lastInteractionAt < 5 * 60 * 1000UL
               && int32_t(millis() - keepAliveAt) >= 0) {
      start(Operation::KeepAlive);
    }
  }
  if (!backgroundReady || background.busy()) return;
  if (page == Page::Material && imageWanted && !sessionToken.isEmpty()) {
    if (startRequest(background, {Operation::Image, generation, imageId, sessionToken, 0, imagePixels})) {
      imageWanted = false;
    }
  } else if (!network.busy() && int32_t(millis() - healthAt) >= 0
             && startRequest(background, {Operation::Health, wifiRevision, freshRoute ? "fresh" : "", "", 0, nullptr})) {
    healthAt = millis() + 60000;
  } else if (!verifyFirmwareBoot && !rebootForFirmware && deviceState == "ready" && !network.busy()) {
    const uint32_t now = millis();
    if (int32_t(now - firmwareCheckAt) >= 0) {
      if (startRequest(background, {Operation::FirmwareCheck, wifiRevision, wifi.key(), failedFirmware, 0, nullptr})) {
        firmwareCheckAt = now + 15000;
      }
    } else if (!firmwareDigest.isEmpty() && idleForFirmware() && (batteryLevel < 0 || batteryLevel >= 20)
               && (firmwareDigest != failedFirmware || int32_t(now - firmwareRetryAt) >= 0)) {
      if (startRequest(background, {Operation::FirmwareDownload, wifiRevision, wifi.key(), firmwareDigest, firmwareSize, nullptr})) {
        firmwareDigest = "";
      }
    }
  }
}

void receiveBackground(const NetworkReply& reply, const NetworkJob& job) {
  if (job.operation == Operation::Health) {
    if (connected && job.generation == wifiRevision) {
      route = reply.ok ? (reply.viaEdge ? Route::Local : Route::Cloud) : Route::Unconfirmed;
      freshRoute = !reply.ok;
      healthAt = millis() + (reply.ok ? 60000 : 5000);
      diagnostic("PLM route %s, dns=%s, rssi=%d dBm\n",
                    reply.ok ? (reply.viaEdge ? "local" : "cloud") : "unconfirmed",
                    WiFi.dnsIP().toString().c_str(), lastSignal);
      dirty = true;
    }
  } else if (job.operation == Operation::FirmwareCheck) {
    if (!reply.ok) firmwareCheckAt = millis() + 30000;
    if (reply.ok && connected && job.generation == wifiRevision) {
      firmwareDigest = reply.data["update"]["sha256"] | "";
      firmwareSize = reply.data["update"]["size"] | 0U;
    } else {
      firmwareDigest = "";
    }
  } else if (job.operation == Operation::FirmwareDownload) {
    if (reply.ok) {
      diagnostic("Firmware validated; waiting to reboot while idle\n");
      rebootForFirmware = true;
    } else {
      failedFirmware = job.payload;
      firmwareRetryAt = millis() + 60000;
      firmwareCheckAt = millis();
      diagnostic("Firmware update failed: %s\n", reply.error.c_str());
    }
  } else if (job.operation == Operation::Image && job.argument == imageId && job.payload == sessionToken
             && (page == Page::Material || page == Page::Quantity)) {
    if (reply.ok) {
      imageWanted = false;
      screen.setThumbnail(imagePixels);
      imageShownAt = millis();
      imageShown = true;
      dirty = true;
      debugLog("Thumbnail accepted for display context=%lu\n", static_cast<unsigned long>(job.generation));
    } else if (page == Page::Material && reply.status != 401 && notice.isEmpty()) {
      show("图片暂不可用");
    }
  }
}

void receive(const NetworkReply& reply, const NetworkJob& job) {
  if (job.operation == Operation::Prepare || job.operation == Operation::KeepAlive) return;
  const bool current = job.generation == generation;
  if (job.operation == Operation::Submit) {
    if (reply.ok) {
      const bool cleared = clearPending();
      if (current && page == Page::Quantity) go(Page::Material);
      const String changedPart = reply.data["part_id"] | "";
      if ((!job.argument.isEmpty() && job.argument == partId) || changedPart == partId) {
        stock = formatQuantity(reply.data["stock"].as<double>());
      } else if (page == Page::Material && !query.isEmpty()) {
        lookupWanted = true;
      }
      show(cleared ? "登记成功" : "已登记，待确认记录未清除");
      hardware.beep();
    } else {
      if (firstSubmit && reply.rejected) clearPending();
      show(reply.error + (pending.isEmpty() ? "" : "。原登记已保留"), true);
    }
    firstSubmit = false;
  }

  if (reply.status == 401 && job.operation != Operation::Users && job.operation != Operation::SignIn) {
    if (page == Page::Material && !query.isEmpty()) waitingScan = query;
    userList();
    show("登录已失效，请重新选择用户", true);
    return;
  }
  if (!current || job.operation == Operation::Submit) return;
  if (!reply.ok) {
    if (job.operation == Operation::Lookup && reply.status >= 400 && reply.status < 500) {
      previews.forget(query);
      partCode = query;
      partName = unit = "";
    }
    if (job.operation == Operation::Users && reply.status == 401) {
      users.clear();
      moreUsers = false;
      show("设备身份未获授权", true);
    } else {
      show(reply.error, job.operation != Operation::Users);
    }
    return;
  }

  switch (job.operation) {
    case Operation::Users: {
      const long serverTime = reply.data["server_time"] | 0L;
      if (!clockReady && time(nullptr) < 1700000000 && serverTime >= 1700000000
          && String(TERMINAL_API_URL).startsWith("https://")) {
        const timeval stamp{serverTime, 0};
        if (settimeofday(&stamp, nullptr) == 0) {
          clockReady = true;
          diagnostic("PLM clock ready at %lu ms\n", static_cast<unsigned long>(millis()));
        }
      }
      if (verifyFirmwareBoot) {
        const esp_err_t result = esp_ota_mark_app_valid_cancel_rollback();
        if (result == ESP_OK) verifyFirmwareBoot = false;
        diagnostic("Firmware %s boot check: %s\n", firmwareVersion, esp_err_to_name(result));
      }
      users = reply.data["users"];
      userIndex = users.size() ? min(userIndex, users.size() - 1) : 0;
      moreUsers = reply.data["has_more"].as<bool>();
      deviceName = reply.data["name"] | "";
      const String state = reply.data["state"] | "ready";
      verification = reply.data["verification"] | "";
      if (deviceState == "pending" && state == "ready") hardware.beep();
      deviceState = state;
      usersAt = millis() + (state == "ready" ? 120000 : 3000);
      if (route == Route::Checking) healthAt = millis();
      if (state != "ready") {
        signInWanted = "";
        show("");
      }
      else show(users.size() ? "" : "请管理员为本机分配用户");
      break;
    }
    case Operation::SignIn:
      userId = reply.data["user"]["id"].as<String>();
      userName = reply.data["user"]["name"] | "";
      sessionToken = reply.data["token"] | "";
      previews.clear();
      lastInteractionAt = millis();
      hardware.beep();
      typed = "";
      go(Page::Home);
      if (!waitingScan.isEmpty()) {
        loadMaterial(waitingScan, true);
        waitingScan = "";
      }
      break;
    case Operation::Lookup:
      partId = reply.data["id"] | "";
      projectId = reply.data["project_id"] | "";
      if (partId.length() != 24 || projectId.isEmpty() || !reply.data["stock"].is<double>()) {
        partId = "";
        debugLog("Lookup result rejected context=%lu reason=material-schema\n", static_cast<unsigned long>(job.generation));
        show("物料返回数据不完整", true);
        break;
      }
      partCode = reply.data["code"] | "";
      partName = reply.data["name"] | "";
      custodian = reply.data["custodian_name"] | "";
      unit = reply.data["unit"] | "";
      stock = formatQuantity(reply.data["stock"].as<double>());
      imageId = reply.data["image_id"] | "";
      if (!partCode.isEmpty()) previews.remember(query, partCode, partName, unit);
      imageWanted = imageId.length() == 24;
      if (wirelessDebug.enabled()) {
        const bool simpleCode = partCode.length() && partCode.length() <= 40
            && strspn(partCode.c_str(), "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.") == partCode.length();
        debugLog("Lookup matched context=%lu material=%s thumbnail=%s\n",
                 static_cast<unsigned long>(job.generation), simpleCode ? partCode.c_str() : "-",
                 imageWanted ? "queued" : "none");
      }
      show("");
      if (!scannedMaterial) hardware.beep();
      break;
    case Operation::History:
      history = reply.data;
      show(history.size() ? "" : "本页没有出入库或报废记录");
      break;
    case Operation::Delete:
      loadHistory(true);
      show("已删除，库存已重新计算");
      hardware.beep();
      break;
    case Operation::Submit:
    case Operation::Health:
    case Operation::Image:
    case Operation::Prepare:
    case Operation::KeepAlive:
    case Operation::FirmwareCheck:
    case Operation::FirmwareDownload:
      break;
  }
}

void handleScan(const String& barcode) {
  debugPanel = false;
  if (wirelessDebug.enabled()) {
    debugLog("Scan decoded bytes=%u end=%s trigger_ms=%ld payload=%s action=%s\n",
             static_cast<unsigned>(barcode.length()), scanStats.endedOnIdle ? "uart-idle" : "cr-lf",
             scanning ? static_cast<long>(millis() - scanStartedAt) : -1L,
             barcode.startsWith("https://") || barcode.startsWith("http://") ? "url" : "text",
             userId.isEmpty() ? "wait-for-login" : "lookup");
  }
  scanning = false;
  lastInteractionAt = millis();
  hardware.beep();
  if (!userId.isEmpty()) loadMaterial(barcode, true);
  else {
    waitingScan = barcode;
    show("已收码，请先选择用户");
  }
}

void handleKey(char key) {
  hardware.keyClick();
  lastKey = key;
  keyPressedAt = millis();
  dirty = true;
  lastInteractionAt = millis();
  if (debugPanel) {
    if (key == 'E') {
      wirelessDebug.disable();
      debugPanel = false;
      show("无线调试已关闭");
      return;
    }
    if (key == 'B' || key == 'U' || key == 'T') debugPanel = false;
    if (key != 'T') return;
  }
  if (key == 'T') {
    if (!wifi.active()) {
      hardware.trigger(true);
      scanning = true;
      scanStartedAt = millis();
      scanStartBytes = scanStats.bytes;
      scanStartRejected = scanStats.rejected;
      debugLog("Scan trigger window=3000ms uart_baud=%u\n", static_cast<unsigned>(TERMINAL_SCANNER_BAUD));
      warmWanted = !userId.isEmpty();
      show("正在扫码...");
    }
    return;
  }
  if (wifi.active()) {
    if (key == 'B') {
      wifi.close();
      usersAt = millis();
      dirty = true;
    }
    return;
  }
  if (page == Page::Users) {
    if (key == 'L' && (userOffset == 0 || !connected)) {
      userList();
      wifi.open();
    } else if (key == 'F') {
      usersAt = millis();
    } else if ((key == 'L' && userOffset > 0) || (key == 'R' && moreUsers)) {
      userOffset = key == 'L' ? userOffset - 6 : userOffset + 6;
      users.clear();
      usersAt = millis();
      userIndex = 0;
    } else if (key == 'U' && userIndex > 0) {
      --userIndex;
    } else if (key == 'D' && userIndex + 1 < users.size()) {
      ++userIndex;
    } else if (key == 'E' && connected && users.size()
               && (!network.busy() || network.job().operation != Operation::SignIn)) {
      const String id = users[userIndex]["id"] | "";
      if (id.length() == 24) { signInWanted = id; show("正在登录..."); }
    }
    dirty = true;
    return;
  }
  if (page == Page::Quantity || page == Page::Home) {
    String& input = page == Page::Home ? typed : quantity;
    if (key >= '0' && key <= '9') {
      if (page == Page::Home && input.isEmpty()) warmWanted = true;
      if (input.length() < 6) input += key;
      show("");
      return;
    }
    if (key == 'L') {
      if (input.length()) input.remove(input.length() - 1);
      show("");
      return;
    }
  }
  switch (page) {
    case Page::Home:
      if (key == 'U') {
        debugPanel = wirelessDebug.enable();
        if (debugPanel) debugSampleAt = millis();
        else show("无法开启无线调试", true);
      } else if (key == 'E' && typed.length() == 6) {
        loadMaterial("JC" + typed);
        typed = "";
      } else if (key == 'E' && typed.isEmpty() && !pending.isEmpty()) {
        retryPending();
      } else if (key == 'E') {
        show("请输入 JC 后的 6 位数字");
      } else if (key == 'R') {
        loadHistory(true);
      } else if (key == 'B') {
        if (typed.length()) { typed = ""; show(""); }
        else userList(true);
      } else if (key == 'F') dirty = true;
      break;
    case Page::Material: {
      if (key == 'B') {
        lookupWanted = imageWanted = imageShown = false;
        go(Page::Home);
      } else if (key == 'F') {
        if (!query.isEmpty()) loadMaterial(query);
      } else if ((key == 'I' || key == 'O' || key == 'S') && !partId.isEmpty()) {
        go(Page::Quantity);
        movementType = key == 'I' ? "入库" : key == 'O' ? "出库" : "报废";
        quantity = "";
      }
      break;
    }
    case Page::Quantity:
      if (key == 'B') go(Page::Material);
      else if (key == 'E') submit();
      break;
    case Page::History:
      if (key == 'B') { historyWanted = false; go(Page::Home); }
      else if (key == 'U' && historyIndex > 0) { --historyIndex; dirty = true; }
      else if (key == 'D' && historyIndex + 1 < history.size()) { ++historyIndex; dirty = true; }
      else if (key == 'L' && historyOffset > 0) { historyOffset -= 6; loadHistory(false); }
      else if (key == 'R' && history.size() == 6 && historyOffset < 9996) { historyOffset += 6; loadHistory(false); }
      else if (key == 'F') loadHistory(true);
      else if (key == 'E' && history.size()) go(Page::Record);
      break;
    case Page::Record:
      if (key == 'B') go(Page::History);
      else if (key == 'E') {
        if (history[historyIndex]["can_delete"].as<bool>()) go(Page::Delete);
        else show("该记录不可删除", true);
      }
      break;
    case Page::Delete:
      if (key == 'B') go(Page::Record);
      else if (key == 'E') deleteMovement();
      break;
    case Page::Users:
      break;
  }
}

const char* connection() {
  if (!connected) return "Wi-Fi 重连中";
  if (route == Route::Local) return "局域网";
  if (route == Route::Cloud) return "云端";
  return route == Route::Checking ? "检测中" : "重查中";
}

String recordTime(const char* timestamp, bool full = false) {
  struct tm parsed = {};
  int year, month;
  if (sscanf(timestamp, "%4d-%2d-%2dT%2d:%2d", &year, &month, &parsed.tm_mday,
             &parsed.tm_hour, &parsed.tm_min) != 5) return "";
  parsed.tm_year = year - 1900;
  parsed.tm_mon = month - 1;
  time_t local = mktime(&parsed) + TERMINAL_UTC_OFFSET;
  if (!gmtime_r(&local, &parsed)) return "";
  char value[22];
  strftime(value, sizeof(value), full ? "%Y-%m-%d %H:%M" : "%m-%d %H:%M", &parsed);
  return value;
}

String recordQuantity(JsonObjectConst row) {
  return formatQuantity(row["qty"].as<double>());
}

Icon movementIcon(const char* kind) {
  if (strcmp(kind, "入库") == 0) return Icon::Inbound;
  if (strcmp(kind, "出库") == 0) return Icon::Outbound;
  return Icon::Trash;
}

void draw(uint32_t now) {
  const char* link = connection();
  if (wifi.active()) {
    screen.frame(Icon::Wifi, "手机配网", "配网热点", batteryLevel);
    screen.icon(Icon::Wifi, 12, 65, 16, ui::muted);
    screen.text(79, wifi.network(), ui::text, 46, 169);
    screen.divider(90);
    screen.icon(Icon::Key, 12, 99, 16, ui::muted);
    screen.number(46, 99, 169, wifi.password(), ui::accent);
    screen.icon(Icon::Link, 14, 150, 16);
    screen.text(164, "http://" + WiFi.softAPIP().toString(), ui::text, 37, 186);
    screen.text(196, wifi.message(), ui::muted, 12, 215);
    screen.button(10, 212, 220, 25, Icon::Back, "关闭配网", 'B', ui::panel);
    return;
  }
  if (debugPanel) {
    screen.frame(Icon::Link, "无线调试", link, batteryLevel);
    screen.text(66, wirelessDebug.attached() ? "浏览器已连接" : "在浏览器打开", ui::muted);
    screen.text(89, connected ? "http://" + WiFi.localIP().toString() + ':' + WirelessDebug::port
                              : "正在等待 Wi-Fi", ui::text, 11, 218);
    screen.divider(105);
    screen.icon(Icon::Key, 10, 115, 15, ui::muted);
    screen.text(130, "临时连接码", ui::muted, 34, 186);
    screen.number(10, 138, 210, wirelessDebug.code(), ui::accent);
    screen.button(10, 182, 106, 29, Icon::Back, "返回工作", 'B', ui::panel);
    screen.button(124, 182, 106, 29, Icon::Confirm, "关闭调试", 'E', ui::accent);
    screen.text(233, "30 分钟后自动关闭", ui::muted);
    return;
  }
  switch (page) {
    case Page::Users: {
      screen.frame(Icon::Person, "选择用户", link, batteryLevel);
      if (users.size()) {
        for (unsigned i = 0; i < users.size() && i < 6; ++i) {
          screen.row(42 + i * 25, Icon::Person, users[i]["name"] | "", i == userIndex);
        }
      } else if (deviceState == "pending" || deviceState == "disabled") {
        screen.icon(Icon::Key, 15, 65, 20, ui::warning);
        screen.text(82, deviceState == "pending" ? "等待后台审核" : "设备已停用", ui::warning, 51, 163);
        screen.number(20, 100, 198, verification, ui::accent);
        screen.text(153, "系统设置 / 扫码枪", ui::muted, 20, 198);
      } else {
        screen.icon(deviceState == "ready" ? Icon::Person : Icon::Wifi, 14, 63, 27);
        const String state = !connected ? "正在连接 Wi-Fi" : clockBlocksNetwork() ? "正在同步时间"
                             : deviceState == "ready" ? "尚未分配经办人" : "正在连接 PLM";
        screen.text(112, state);
        screen.text(139, deviceName, ui::muted);
      }
      screen.text(207, notice, ui::warning);
      const bool hasUsers = users.size() > 0;
      if (hasUsers && moreUsers) {
        screen.button(10, 212, 68, 25, userOffset ? Icon::Left : Icon::Wifi,
                      userOffset ? "上页" : "配网", 'L', ui::panel);
        screen.button(86, 212, 68, 25, Icon::Right, "下页", 'R', ui::panel);
        screen.button(162, 212, 68, 25, Icon::Confirm, "登录", 'E', ui::accent);
      } else {
        screen.button(10, 212, 106, 25, userOffset ? Icon::Left : Icon::Wifi,
                      userOffset ? "上页" : "配网", 'L', ui::panel);
        screen.button(124, 212, 106, 25, hasUsers ? Icon::Confirm : Icon::Refresh,
                      hasUsers ? "登录" : "刷新", hasUsers ? 'E' : 'F', hasUsers ? ui::accent : ui::panel);
      }
      break;
    }
    case Page::Home: {
      screen.frame(Icon::Warehouse, userName.isEmpty() ? "仓库" : userName, link, batteryLevel);
      screen.text(72, "物料编号", ui::muted);
      screen.number(10, 81, 174, typed.isEmpty() ? "JC ------" : "JC " + typed,
                    typed.isEmpty() ? ui::muted : ui::text);
      screen.icon(Icon::Scan, 196, 79, 23, scanning ? ui::accent : ui::muted);
      if (scanning) screen.scanLine(198, 83, 18, now);
      screen.divider(116);
      const bool retry = typed.isEmpty() && !pending.isEmpty();
      screen.text(140, notice.isEmpty() && typed.isEmpty() && !retry ? "按扳机扫码" : notice,
                  notice.isEmpty() ? ui::muted : ui::text);
      screen.button(10, 152, 131, 35, retry ? Icon::Refresh : Icon::Confirm,
                    retry ? "重试登记" : "查料", 'E', ui::accent);
      screen.button(149, 152, 81, 35, Icon::History, "历史", 'R', ui::raised);
      screen.button(10, 212, 106, 25, Icon::Back, typed.isEmpty() ? "切换用户" : "清空编号", 'B', ui::panel);
      screen.button(124, 212, 106, 25, typed.isEmpty() ? Icon::Link : Icon::Erase,
                    typed.isEmpty() ? (wirelessDebug.enabled() ? "调试已开" : "上键调试") : "左键退格",
                    typed.isEmpty() ? 'U' : 'L', ui::panel);
      break;
    }
    case Page::Material: {
      screen.frame(Icon::Box, "物料", link, batteryLevel);
      const bool found = !partId.isEmpty();
      const bool picture = imageShown || imageId.length() == 24;
      const String manager = custodian.isEmpty() ? String("未指定") : custodian;
      if (picture) {
        screen.text(63, partName.isEmpty() ? partCode : partName);
        screen.outline(11, 70, 122, 122);
        if (imageShown) screen.thumbnail(12, 71, imagePixels, now - imageShownAt);
        else screen.icon(Icon::Photo, 59, 115, 25, ui::muted);
        screen.text(84, partCode, ui::muted, 143, 87);
        screen.divider(91, 143, 87);
        screen.text(111, "库存", ui::muted, 143, 87);
        if (found) screen.number(143, 118, 87, stock);
        screen.text(156, unit, ui::muted, 143, 87);
        screen.text(175, "管理员", ui::muted, 143, 87);
        if (found) screen.text(191, manager, ui::text, 143, 87);
      } else {
        screen.text(64, partCode, ui::muted);
        screen.multiline(87, 17, 2, partName, ui::text, 10, 220);
        screen.divider(115);
        if (found) {
          screen.text(136, "库存", ui::muted, 20, 99);
          screen.number(20, 146, 92, stock);
          screen.text(171, unit, ui::muted, 114, 40);
          screen.text(136, "管理员", ui::muted, 160, 65);
          screen.text(164, manager, ui::text, 160, 65);
        } else {
          screen.icon(Icon::Box, 23, 133, 23, ui::muted);
          screen.text(155, partName.isEmpty() ? "查料" : "正在核对库存", ui::muted, 55, 160);
        }
      }
      screen.button(10, 197, 68, 23, Icon::Inbound, "入库", 'I', found ? ui::inbound : ui::background);
      screen.button(86, 197, 68, 23, Icon::Outbound, "出库", 'O', found ? ui::outbound : ui::background);
      screen.button(162, 197, 68, 23, Icon::Trash, "报废", 'S', found ? ui::danger : ui::background);
      const bool finding = notice == "正在查找物料...";
      if (!notice.isEmpty() && !finding) screen.text(237, notice, ui::warning);
      else {
        screen.icon(Icon::Back, 11, 225, 13, ui::muted);
        screen.text(237, "返回", ui::muted, 29, 86);
        screen.icon(Icon::Refresh, 171, 225, 13, ui::muted);
        screen.text(237, "刷新", ui::muted, 191, 44);
      }
      break;
    }
    case Page::Quantity: {
      const Icon operation = movementIcon(movementType);
      const uint16_t color = ui::movementColor(operation);
      screen.frame(operation, movementType, link, batteryLevel);
      screen.text(65, partName.isEmpty() ? partCode : partName);
      screen.text(85, partCode, ui::muted);
      screen.text(112, "数量", ui::muted);
      screen.number(10, 121, 170, quantity.isEmpty() ? "----" : quantity, color);
      screen.text(143, unit, ui::muted, 184, 37);
      screen.divider(153);
      screen.text(177, "当前库存  " + stock + ' ' + unit, ui::muted);
      screen.text(202, notice, ui::warning);
      screen.button(10, 212, 68, 25, Icon::Back, "返回", 'B', ui::panel);
      screen.button(86, 212, 68, 25, Icon::Erase, "退格", 'L', ui::raised);
      screen.button(162, 212, 68, 25, Icon::Confirm, "确定", 'E', color);
      break;
    }
    case Page::History: {
      screen.frame(Icon::History, "库存历史", link, batteryLevel);
      for (unsigned i = 0; i < history.size() && i < 6; ++i) {
        const JsonObjectConst row = history[i].as<JsonObjectConst>();
        const String name = row["part_name"] | "";
        const char* kind = row["type"] | "";
        screen.row(49 + i * 22, movementIcon(kind), name.isEmpty() ? (row["part_code"] | "") : name,
                   i == historyIndex, kind, recordQuantity(row));
      }
      if (!history.size()) screen.icon(Icon::History, 15, 67, 31, ui::muted);
      screen.text(history.size() ? 204 : 127, notice, history.size() ? ui::warning : ui::muted);
      screen.button(10, 212, 52, 25, Icon::Back, "返回", 'B', ui::panel);
      if (historyOffset > 0) screen.button(66, 212, 52, 25, Icon::Left, "上页", 'L', ui::panel);
      if (history.size() == 6) screen.button(122, 212, 52, 25, Icon::Right, "下页", 'R', ui::panel);
      if (history.size()) screen.button(178, 212, 52, 25, Icon::Document, "详情", 'E', ui::accent);
      else screen.button(154, 212, 76, 25, Icon::Refresh, "刷新", 'F', ui::raised);
      break;
    }
    case Page::Record: {
      const JsonObjectConst row = history[historyIndex].as<JsonObjectConst>();
      const char* kind = row["type"] | "";
      const Icon operation = movementIcon(kind);
      const uint16_t color = ui::movementColor(operation);
      const char* timestamp = row["expected"]["occurred_at"] | "";
      const String name = row["part_name"] | "";
      const String reason = row["expected"]["reason"] | "";
      screen.frame(Icon::Document, "流水详情", link, batteryLevel);
      screen.multiline(64, 17, 2, name.isEmpty() ? (row["part_code"] | "") : name, ui::text, 10, 220);
      screen.text(100, row["part_code"] | "", ui::muted);
      screen.divider(109);
      screen.divider(155);
      screen.icon(operation, 14, 120, 23, color);
      screen.text(137, kind, color, 50, 51);
      screen.number(104, 118, 82, recordQuantity(row));
      screen.text(138, row["unit"] | "", ui::muted, 190, 34);
      screen.icon(Icon::History, 12, 161, 13, ui::muted);
      screen.text(174, recordTime(*timestamp ? timestamp : (row["created_at"] | ""), true), ui::text, 31, 199);
      screen.icon(Icon::Warehouse, 12, 180, 13, ui::muted);
      screen.text(193, row["project_name"] | "", ui::muted, 31, 199);
      if (notice.isEmpty() && reason.isEmpty()) screen.divider(204);
      else screen.text(209, notice.isEmpty() ? reason : notice, notice.isEmpty() ? ui::muted : ui::warning);
      screen.button(10, 215, 106, 23, Icon::Back, "返回", 'B', ui::panel);
      if (row["can_delete"].as<bool>()) screen.button(124, 215, 106, 23, Icon::Trash, "删除", 'E', ui::raised);
      break;
    }
    case Page::Delete: {
      const JsonObjectConst row = history[historyIndex].as<JsonObjectConst>();
      const String name = row["part_name"] | "";
      screen.frame(Icon::Alert, "确认删除", link, batteryLevel);
      screen.icon(Icon::Trash, 12, 65, 24, ui::danger);
      screen.text(82, name.isEmpty() ? (row["part_code"] | "") : name, ui::text, 52, 165);
      screen.text(104, row["part_code"] | "", ui::muted, 52, 165);
      screen.text(127, String(row["type"] | "") + ' ' + recordQuantity(row) + ' ' + (row["unit"] | ""),
                  ui::text, 52, 165);
      screen.divider(145);
      screen.multiline(170, 18, 2, notice.isEmpty() ? String("删除后将重新计算库存") : notice,
                       notice.isEmpty() ? ui::text : ui::warning, 10, 220);
      screen.button(10, 209, 106, 28, Icon::Back, "取消", 'B', ui::raised);
      screen.button(124, 209, 106, 28, Icon::Trash, "确定删除", 'E', ui::danger);
      break;
    }
  }
}

void sampleBattery() {
  if (int32_t(millis() - batteryAt) < 0) return;
  batteryAt = millis() + 1800;
  const int raw = lroundf(hardware.batteryVolts() * 1000);
  const bool valid = batteryPercent(raw) >= 0;
  filteredMillivolts = !valid ? 0 : filteredMillivolts ? (filteredMillivolts * 3 + raw) / 4 : raw;
  const int next = batteryPercent(filteredMillivolts);
  if (next != batteryLevel && (next < 0 || batteryLevel < 0 || abs(next - batteryLevel) >= 2
                               || next == 100 || next == 0 || (next <= 15) != (batteryLevel <= 15))) {
    batteryLevel = next;
    dirty = true;
  }
  if (next < 0 || next >= 22) lowBatteryAlert = false;
  else if (next <= 15 && !lowBatteryAlert) {
    lowBatteryAlert = true;
    hardware.beep(false);
  }
}

void recheckRoute() {
  ++wifiRevision;
  route = Route::Checking;
  freshRoute = true;
  healthAt = millis();
  dirty = true;
}

void sampleSignal() {
  if (!connected || int32_t(millis() - signalAt) < 0) return;
  signalAt = millis() + 1500;
  wifi_ap_record_t ap{};
  if (esp_wifi_sta_get_ap_info(&ap) != ESP_OK) return;
  if (memcmp(lastBssid, ap.bssid, sizeof(lastBssid)) != 0) {
    memcpy(lastBssid, ap.bssid, sizeof(lastBssid));
    recheckRoute();
    diagnostic("WiFi AP %02x:%02x:%02x:%02x:%02x:%02x ch=%u rssi=%d dBm\n",
               ap.bssid[0], ap.bssid[1], ap.bssid[2], ap.bssid[3], ap.bssid[4], ap.bssid[5],
               static_cast<unsigned>(ap.primary), static_cast<int>(ap.rssi));
  }
  if (ap.rssi != lastSignal) {
    lastSignal = ap.rssi;
    dirty = true;
  }
}

void wifiDisconnected(WiFiEvent_t, WiFiEventInfo_t info) {
  wifiReason.store(info.wifi_sta_disconnected.reason);
  wifiDisconnects.fetch_add(1);
}

void wifiStationStarted(WiFiEvent_t) {
  // Configure the transmit ceiling before the first association starts.
  esp_wifi_set_max_tx_power(kWifiMaxTxPower);
}

void reportWifiPerformance() {
  int8_t txPower;
  wifi_ps_type_t sleep;
  if (esp_wifi_get_max_tx_power(&txPower) == ESP_OK && esp_wifi_get_ps(&sleep) == ESP_OK) {
    diagnostic("WiFi radio tx_limit=%.2f dBm, modem_sleep=%s\n",
               txPower / 4.0, sleep == WIFI_PS_NONE ? "off" : "on");
  }
}

const char* wifiReasonName(unsigned reason) {
  switch (reason) {
    case WIFI_REASON_ASSOC_LEAVE: return "association closed";
    case WIFI_REASON_BEACON_TIMEOUT: return "beacon timeout";
    case WIFI_REASON_NO_AP_FOUND: return "access point not found";
    case WIFI_REASON_AUTH_FAIL: return "authentication failed";
    case WIFI_REASON_ASSOC_FAIL: return "association failed";
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT: return "Wi-Fi handshake timeout";
    default: return "station disconnected";
  }
}

void reportWifiDisconnect() {
  const unsigned drops = wifiDisconnects.load();
  if (reportedDisconnects == drops) return;
  reportedDisconnects = drops;
  recheckRoute();
  const unsigned reason = wifiReason.load();
  diagnostic("WiFi disconnected reason=%u (%s), last_rssi=%d dBm, setup=%s, uptime=%lu ms\n",
             reason, wifiReasonName(reason), lastSignal, wifi.active() ? "yes" : "no",
             static_cast<unsigned long>(millis()));
}

void reportStatus() {
  const char* routeName = route == Route::Local ? "local" : route == Route::Cloud ? "cloud" : "unconfirmed";
  diagnostic("WiFi=%s route=%s rssi=%d drops=%u reason=%u reset=%d\n",
             connected ? "on" : "off", routeName, lastSignal, wifiDisconnects.load(),
             wifiReason.load(), static_cast<int>(esp_reset_reason()));
  if (connected) {
    reportWifiPerformance();
    wifi_ap_record_t ap{};
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
      diagnostic("WiFi current AP %02x:%02x:%02x:%02x:%02x:%02x ch=%u\n",
                 ap.bssid[0], ap.bssid[1], ap.bssid[2], ap.bssid[3], ap.bssid[4], ap.bssid[5],
                 static_cast<unsigned>(ap.primary));
    }
  }
  diagnostic("auth=%s pending=%s PSRAM=%u battery=%.2fV estimate=%d\n",
             userId.isEmpty() ? "no" : "yes", pending.isEmpty() ? "no" : "yes",
             ESP.getPsramSize(), hardware.batteryVolts(), batteryLevel);
}

void serviceWirelessDebug() {
  if (!wirelessDebug.enabled()) return;
  const bool attached = wirelessDebug.attached();
  const bool available = connected && !wifi.active();
  if (wirelessDebug.tick(available ? WiFi.localIP() : IPAddress(),
                         available ? WiFi.subnetMask() : IPAddress())) reportStatus();
  if (attached != wirelessDebug.attached()) dirty = true;
  if (!wirelessDebug.enabled()) {
    debugPanel = false;
    dirty = true;
  } else if (int32_t(millis() - debugSampleAt) >= 0) {
    debugSampleAt = millis() + 5000;
    if (available) {
      char line[96];
      snprintf(line, sizeof(line), "WiFi sample rssi=%d dBm drops=%u route=%s\n", lastSignal,
               wifiDisconnects.load(), route == Route::Local ? "local" :
                                       route == Route::Cloud ? "cloud" : "unconfirmed");
      wirelessDebug.record(line);
    }
  }
}

void readConsole() {
  while (Serial.available()) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '\n' || ch == '\r') {
      if (usbLine == "status") {
        reportStatus();
      } else if (usbLine == "clear-pending CONFIRMED-IN-JPLM" && !pending.isEmpty()) {
        if (network.busy()) Serial.println("Wait for current request to finish.");
        else Serial.println(clearPending() ? "Operator verified pending request cleared." : "NVS clear failed.");
        dirty = true;
      }
      usbLine = "";
    } else if (usbLine.length() < 80) {
      usbLine += ch;
    } else {
      usbLine = "";
    }
  }
}
}

void setup() {
  Serial.begin(115200);
  Serial.printf("Scanner boot firmware=%s reset_reason=%d\n", firmwareVersion, static_cast<int>(esp_reset_reason()));
  hardware.begin();
  screen.begin();
  readPending();
  ready = network.begin();
  backgroundReady = background.begin();
  esp_ota_img_states_t imageState;
  verifyFirmwareBoot = esp_ota_get_state_partition(esp_ota_get_running_partition(), &imageState) == ESP_OK
                       && imageState == ESP_OTA_IMG_PENDING_VERIFY;
  if (verifyFirmwareBoot && (!ready || !backgroundReady)) esp_ota_mark_app_invalid_rollback_and_reboot();
  WiFi.onEvent(wifiStationStarted, ARDUINO_EVENT_WIFI_STA_START);
  WiFi.onEvent(wifiDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  wifi.begin();
  configTime(0, 0, "ntp.aliyun.com", "pool.ntp.org", "time.cloudflare.com");
  if (!ready) show("网络任务初始化失败");
  hardware.beep();
}

void loop() {
  if (wifi.tick()) dirty = true;
  reportWifiDisconnect();
  const bool online = WiFi.status() == WL_CONNECTED;
  if (online != connected) {
    connected = online;
    recheckRoute();
    if (online) {
      usersAt = signalAt = millis();
      firmwareCheckAt = millis();
      const esp_err_t txResult = esp_wifi_set_max_tx_power(kWifiMaxTxPower);
      if (txResult != ESP_OK) diagnostic("WiFi could not set TX limit: %s\n", esp_err_to_name(txResult));
      lastSignal = WiFi.RSSI();
      diagnostic("WiFi connected at %lu ms, rssi=%d dBm\n",
                 static_cast<unsigned long>(millis()), lastSignal);
      reportWifiPerformance();
    }
  }
  if (!clockReady && time(nullptr) >= 1700000000) {
    clockReady = true;
    usersAt = healthAt = millis();
    dirty = true;
    diagnostic("TLS clock ready at %lu ms\n", static_cast<unsigned long>(millis()));
  }
  String scanned;
  const uint32_t rejectedBeforePoll = scanStats.rejected;
  const bool freshScan = hardware.pollScanner(scanned, wirelessDebug.enabled() ? &scanStats : nullptr);
  if (scanStats.rejected != rejectedBeforePoll) {
    debugLog("Scan rejected frames=%lu reason=invalid-uart-frame\n",
             static_cast<unsigned long>(scanStats.rejected - rejectedBeforePoll));
  }
  if (freshScan && !wifi.active()) handleScan(scanned);
  hardware.tick();
  if (scanning && !hardware.scanActive()) {
    scanning = false;
    debugLog("Scan timed out elapsed=%lums uart_bytes=%lu rejected=%lu\n",
             static_cast<unsigned long>(millis() - scanStartedAt),
             static_cast<unsigned long>(scanStats.bytes - scanStartBytes),
             static_cast<unsigned long>(scanStats.rejected - scanStartRejected));
    show("扫码超时，请重试", true);
  }
  if (const auto* reply = network.poll()) {
    wirelessDebug.record(reply->trace);
    receive(*reply, network.job());
  }
  if (const auto* reply = background.poll()) {
    wirelessDebug.record(reply->trace);
    receiveBackground(*reply, background.job());
  }
  const char key = hardware.pollKey();
  if (key && !freshScan) handleKey(key);
  readConsole();
  sampleSignal();
  sampleBattery();
  serviceWirelessDebug();
  rebootAfterFirmware();
  scheduleNetwork();
  const uint32_t now = millis();
  const bool busy = network.busy() && network.job().operation != Operation::Prepare
                                   && network.job().operation != Operation::KeepAlive;
  const bool loading = !wifi.active() && (busy || scanning || (connected && clockBlocksNetwork())
                     || (connected && page == Page::Material && lookupWanted));
  if (loading != loadingVisible) {
    loadingVisible = loading;
    dirty = true;
  }
  const bool moving = (lastKey && now - keyPressedAt < ui::keyMotionMs)
                      || (page == Page::Material && imageShown && now - imageShownAt < ui::imageMotionMs);
  if (moving != motionVisible) {
    motionVisible = moving;
    dirty = true;
  }
  if (int32_t(now - nextAnimation) >= 0 && (loading || moving)) {
    dirty = true;
    nextAnimation = now + 33;
  }
  if (dirty) {
    dirty = false;
    screen.motion(lastKey, now - keyPressedAt);
    draw(now);
    screen.signal(connected && !wifi.active() ? lastSignal : 0);
    if (loading && !debugPanel) screen.loading(now);
    screen.present();
  }
  delay(2);
}

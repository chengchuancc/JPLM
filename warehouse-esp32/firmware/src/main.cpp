#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_system.h>
#include <esp_wifi.h>
#include <atomic>
#include <time.h>
#include "material_preview.h"
#include "peripherals.h"
#include "provisioning.h"
#include "settings.h"
#include "terminal_display.h"
#include "terminal_network.h"

namespace {
enum class Page { Users, Home, Material, Quantity, History, Record, Delete };
enum class Route { Checking, Local, Cloud, Unconfirmed };
using ui::Icon;
Peripherals hardware;
TerminalDisplay screen(hardware.display());
Provisioning wifi;
TerminalNetwork network;
TerminalNetwork background;
Preferences store;
MaterialPreviewCache previews;
Page page = Page::Users;
uint32_t generation = 0, usersAt = 0, healthAt = 0, batteryAt = 0, nextAnimation = 0;
uint32_t keepAliveAt = 0, lastInteractionAt = 0;
uint32_t pageShownAt = 0, keyPressedAt = 0;
char lastKey = 0;
bool dirty = true, connected = false;
bool freshRoute = true;
Route route = Route::Checking;
unsigned wifiRevision = 0;
uint8_t lastBssid[6] = {};
uint32_t signalAt = 0;
bool ready = false, backgroundReady = false, hasStorage = false, scanning = false;
bool clockReady = false, lowBatteryAlert = false;
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

void show(const String& text, bool error = false) {
  notice = text;
  dirty = true;
  if (text.length()) Serial.println(text);
  if (error) hardware.beep(false);
}

void go(Page next) {
  if (page != next) lastKey = 0;
  page = next;
  pageShownAt = millis();
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

bool start(Operation operation, const String& argument = "", const String& payload = "",
           unsigned offset = 0, uint16_t* pixels = nullptr) {
  if (!network.start({operation, generation, argument, payload, offset, pixels})) return false;
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
  if (const auto* preview = previews.find(query)) {
    partCode = preview->code;
    partName = preview->name;
    unit = preview->unit;
  }
  imageWanted = imageShown = false;
  lookupWanted = true;
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

void scheduleNetwork() {
  if (!ready || !connected || !clockReady || wifi.active()) return;
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
    if (background.start({Operation::Image, generation, imageId, sessionToken, 0, imagePixels})) {
      imageWanted = false;
    }
  } else if (!network.busy() && int32_t(millis() - healthAt) >= 0
             && background.start({Operation::Health, wifiRevision, freshRoute ? "fresh" : "", "", 0, nullptr})) {
    healthAt = millis() + 60000;
  }
}

void receiveBackground(const NetworkReply& reply, const NetworkJob& job) {
  if (job.operation == Operation::Health) {
    if (connected && job.generation == wifiRevision) {
      route = reply.ok ? (reply.viaEdge ? Route::Local : Route::Cloud) : Route::Unconfirmed;
      freshRoute = !reply.ok;
      healthAt = millis() + (reply.ok ? 60000 : 5000);
      Serial.printf("PLM route %s, dns=%s, rssi=%d dBm\n",
                    reply.ok ? (reply.viaEdge ? "local" : "cloud") : "unconfirmed",
                    WiFi.dnsIP().toString().c_str(), lastSignal);
      dirty = true;
    }
  } else if (job.argument == imageId && job.payload == sessionToken
             && (page == Page::Material || page == Page::Quantity)) {
    if (reply.ok) {
      imageWanted = false;
      imageShown = true;
      dirty = true;
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
      break;
  }
}

void handleScan(const String& barcode) {
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
  if (key == 'T') {
    if (!wifi.active()) {
      hardware.trigger(true);
      scanning = true;
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
      if (key == 'E' && typed.length() == 6) {
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

String connection() {
  if (!connected) return "Wi-Fi 重连中";
  const char* path = route == Route::Local ? "  本地路由"
                   : route == Route::Cloud ? "  云端直连"
                   : route == Route::Checking ? "  检测路由" : "  路由重查";
  return WiFi.localIP().toString() + path;
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

void draw() {
  if (wifi.active()) {
    screen.frame(Icon::Wifi, "手机配网", WiFi.softAPIP().toString(), batteryLevel);
    screen.card(10, 56, 220, 108);
    screen.text(78, "热点   " + wifi.network(), ui::accent, 22);
    screen.text(102, "密码   " + wifi.password(), ui::text, 22);
    screen.text(126, "连接热点后打开浏览器", ui::muted, 22);
    screen.text(149, "http://" + WiFi.softAPIP().toString(), ui::text, 22);
    screen.footer(wifi.message(), "返回 关闭配网");
    return;
  }
  const String link = connection();
  switch (page) {
    case Page::Users:
      screen.frame(Icon::Person, "选择用户", link, batteryLevel);
      if (users.size()) {
        for (unsigned i = 0; i < users.size() && i < 6; ++i) {
          screen.row(50 + i * 21, users[i]["name"] | "", i == userIndex);
        }
      } else {
        screen.card(10, 56, 220, 113);
        if (deviceState == "pending" || deviceState == "disabled") {
          screen.text(79, deviceState == "pending" ? "等待后台审核" : "设备已停用", ui::warning, 22);
          screen.number(22, 95, 195, verification, ui::accent);
          screen.text(145, "系统设置 / 扫码枪", ui::muted, 22);
        } else {
          const String state = !connected ? "正在连接 Wi-Fi" : !clockReady ? "正在同步时间"
                             : deviceState == "ready" ? "尚未分配经办人" : "正在连接 PLM";
          screen.text(83, state, ui::text, 22);
          screen.text(114, deviceName, ui::muted, 22, 195);
        }
      }
      screen.footer(notice);
      if (moreUsers) {
        screen.button(10, 216, 68, 22, userOffset ? Icon::Left : Icon::Wifi,
                      userOffset ? "上页" : "配网", 'L', ui::panel);
        screen.button(85, 216, 68, 22, Icon::Right, "下页", 'R', ui::panel);
        screen.button(160, 216, 70, 22, Icon::Confirm, "登录", 'E', ui::accent);
      } else {
        screen.button(10, 216, 105, 22, userOffset ? Icon::Left : Icon::Wifi,
                      userOffset ? "上页" : "配网", 'L', ui::panel);
        screen.button(123, 216, 107, 22, users.size() ? Icon::Confirm : Icon::Refresh,
                      users.size() ? "登录" : "刷新", users.size() ? 'E' : 'F',
                      users.size() ? ui::accent : ui::panel);
      }
      break;
    case Page::Home:
      screen.frame(Icon::Warehouse, userName.isEmpty() ? "仓库" : userName, link, batteryLevel);
      screen.card(10, 52, 220, 51);
      screen.text(69, "物料编号", ui::muted, 22);
      screen.number(22, 76, 195, typed.isEmpty() ? "JC ------" : "JC " + typed, ui::accent);
      screen.button(10, 111, 106, 69, Icon::Scan, "查料", 'E', ui::accent, "确定");
      screen.button(124, 111, 106, 69, Icon::History, "历史", 'R', ui::raised, "右键");
      screen.footer(notice.isEmpty() && !pending.isEmpty() ? "待确认登记，确定重试" : notice);
      if (notice.isEmpty()) {
        screen.button(10, 216, 105, 22, Icon::Back, "切换用户", 'B', ui::panel);
        if (!typed.isEmpty()) screen.button(123, 216, 107, 22, Icon::Erase, "左键退格", 'L', ui::panel);
      }
      break;
    case Page::Material: {
      screen.frame(Icon::Document, "物料", link, batteryLevel);
      screen.card(10, 48, 220, 103);
      screen.text(65, partCode, ui::accent, 19, imageShown ? 118 : 195);
      screen.text(83, partName, ui::text, 19, imageShown ? 118 : 195);
      if (!partId.isEmpty()) {
        screen.number(19, 89, imageShown ? 116 : 195, stock);
        screen.text(125, "库存  " + unit, ui::muted, 19, imageShown ? 118 : 195);
      } else if (!partName.isEmpty() && (lookupWanted || network.busy())) {
        screen.text(112, "正在核对库存", ui::muted, 19, 195);
      }
      if (imageShown) screen.thumbnail(imagePixels);
      if (!partId.isEmpty()) {
        screen.text(146, "管理员  " + (custodian.isEmpty() ? String("未指定") : custodian),
                    ui::muted, 19, 202);
      }
      screen.button(10, 156, 68, 45, Icon::Inbound, "入库", 'I', partId.isEmpty() ? ui::panel : ui::accent);
      screen.button(86, 156, 68, 45, Icon::Outbound, "出库", 'O', partId.isEmpty() ? ui::panel : ui::raised);
      screen.button(162, 156, 68, 45, Icon::Trash, "报废", 'S', partId.isEmpty() ? ui::panel : ui::danger);
      const bool finding = notice == "正在查找物料...";
      if (!finding) screen.text(221, notice, ui::warning);
      if (notice.isEmpty() || finding) {
        screen.button(10, 216, 105, 22, Icon::Back, "返回", 'B', ui::panel);
        screen.button(123, 216, 107, 22, Icon::Refresh, "刷新", 'F', ui::panel);
      }
      break;
    }
    case Page::Quantity:
      screen.frame(strcmp(movementType, "入库") == 0 ? Icon::Inbound
                   : strcmp(movementType, "出库") == 0 ? Icon::Outbound : Icon::Trash,
                   movementType, link, batteryLevel);
      screen.text(69, partCode + "  " + partName, ui::muted);
      screen.card(10, 81, 220, 57);
      screen.number(20, 97, 195, quantity.isEmpty() ? "----" : quantity, ui::accent);
      screen.button(10, 146, 66, 36, Icon::Erase, "退格", 'L', ui::raised);
      screen.button(82, 146, 66, 36, Icon::Back, "返回", 'B', ui::raised);
      screen.button(154, 146, 76, 36, Icon::Confirm, "确定", 'E', ui::accent);
      screen.footer(notice, "库存  " + stock + " " + unit);
      break;
    case Page::History:
      screen.frame(Icon::History, "库存历史", link, batteryLevel);
      for (unsigned i = 0; i < history.size() && i < 6; ++i) {
        const JsonObjectConst row = history[i].as<JsonObjectConst>();
        const String name = row["part_name"] | "";
        screen.row(50 + i * 21, name.isEmpty() ? (row["part_code"] | "") : name,
                   i == historyIndex, String(row["type"] | "") + " " + recordQuantity(row));
      }
      screen.footer(notice);
      if (history.size() && notice.isEmpty()) {
        if (historyOffset > 0) screen.button(10, 216, 68, 22, Icon::Left, "上页", 'L', ui::panel);
        if (history.size() == 6) screen.button(85, 216, 68, 22, Icon::Right, "下页", 'R', ui::panel);
        screen.button(160, 216, 70, 22, Icon::Document, "详情", 'E', ui::accent);
      }
      break;
    case Page::Record: {
      const JsonObjectConst row = history[historyIndex].as<JsonObjectConst>();
      const bool canDelete = row["can_delete"].as<bool>();
      const char* timestamp = row["expected"]["occurred_at"] | "";
      const String reason = row["expected"]["reason"] | "";
      screen.frame(Icon::Document, "流水详情", link, batteryLevel);
      screen.card(10, 48, 220, 124);
      screen.multiline(67, 16, 2, row["part_name"] | "", ui::text, 20, 200);
      screen.text(101, row["part_code"] | "", ui::muted, 20, 200);
      screen.text(120, String(row["type"] | "") + "  " + recordQuantity(row) + " " + (row["unit"] | ""),
                  ui::accent, 20, 200);
      screen.text(139, recordTime(*timestamp ? timestamp : (row["created_at"] | ""), true),
                  ui::text, 20, 200);
      screen.text(158, row["project_name"] | "", ui::muted, 20, 200);
      screen.text(202, notice.isEmpty() ? reason : notice, notice.isEmpty() ? ui::muted : ui::warning);
      screen.button(10, 216, 105, 22, Icon::Back, "返回", 'B', ui::panel);
      if (canDelete) screen.button(123, 216, 107, 22, Icon::Trash, "删除", 'E', ui::danger);
      break;
    }
    case Page::Delete: {
      const JsonObjectConst row = history[historyIndex].as<JsonObjectConst>();
      screen.frame(Icon::Trash, "确认删除", link, batteryLevel);
      screen.card(10, 52, 220, 83);
      screen.text(73, String(row["type"] | "") + " " + (row["part_code"] | ""), ui::warning, 20);
      screen.text(96, row["part_name"] | "", ui::text, 20, 200);
      screen.text(121, "数量 " + recordQuantity(row) + " " + (row["unit"] | ""), ui::muted, 20);
      screen.button(10, 142, 106, 41, Icon::Back, "取消", 'B', ui::raised);
      screen.button(124, 142, 106, 41, Icon::Trash, "确定删除", 'E', ui::danger);
      screen.footer(notice);
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
    Serial.printf("WiFi AP %02x:%02x:%02x:%02x:%02x:%02x ch=%u rssi=%d dBm\n",
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
  Serial.printf("WiFi disconnected reason=%u (%s), last_rssi=%d dBm, setup=%s, uptime=%lu ms\n",
                reason, wifiReasonName(reason), lastSignal, wifi.active() ? "yes" : "no",
                static_cast<unsigned long>(millis()));
}

void readConsole() {
  while (Serial.available()) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '\n' || ch == '\r') {
      if (usbLine == "status") {
        Serial.printf("WiFi=%s auth=%s pending=%s PSRAM=%u battery=%.2fV estimate=%d rssi=%d drops=%u reason=%u reset=%d\n",
                      connected ? "on" : "off", userId.isEmpty() ? "no" : "yes",
                      pending.isEmpty() ? "no" : "yes", ESP.getPsramSize(), hardware.batteryVolts(),
                      batteryLevel, lastSignal, wifiDisconnects.load(), wifiReason.load(),
                      static_cast<int>(esp_reset_reason()));
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
  Serial.printf("Scanner boot reset_reason=%d\n", static_cast<int>(esp_reset_reason()));
  hardware.begin();
  screen.begin();
  readPending();
  ready = network.begin();
  backgroundReady = background.begin();
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
      if (!WiFi.setTxPower(WIFI_POWER_19_5dBm)) Serial.println("WiFi could not set TX power");
      lastSignal = WiFi.RSSI();
      Serial.printf("WiFi connected at %lu ms, rssi=%d dBm, tx_limit=%.2f dBm, sleep=%d\n",
                    static_cast<unsigned long>(millis()), lastSignal,
                    static_cast<int>(WiFi.getTxPower()) / 4.0, static_cast<int>(WiFi.getSleep()));
    }
  }
  if (!clockReady && time(nullptr) >= 1700000000) {
    clockReady = true;
    usersAt = healthAt = millis();
    dirty = true;
    Serial.printf("TLS clock ready at %lu ms\n", static_cast<unsigned long>(millis()));
  }
  String scanned;
  const bool freshScan = hardware.pollScanner(scanned);
  if (freshScan && !wifi.active()) handleScan(scanned);
  hardware.tick();
  if (scanning && !hardware.scanActive()) {
    scanning = false;
    show("扫码超时，请重试", true);
  }
  if (const auto* reply = network.poll()) receive(*reply, network.job());
  if (const auto* reply = background.poll()) receiveBackground(*reply, background.job());
  const char key = hardware.pollKey();
  if (key && !freshScan) handleKey(key);
  readConsole();
  sampleSignal();
  sampleBattery();
  scheduleNetwork();
  const uint32_t now = millis();
  const bool busy = network.busy() && network.job().operation != Operation::Prepare
                                   && network.job().operation != Operation::KeepAlive;
  const bool loading = !wifi.active() && (busy || scanning || (connected && !clockReady)
                     || (connected && page == Page::Material && lookupWanted));
  if (loading != loadingVisible) {
    loadingVisible = loading;
    dirty = true;
  }
  const bool moving = now - pageShownAt < 140 || (lastKey && now - keyPressedAt < 100);
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
    screen.motion(now - pageShownAt, lastKey, now - keyPressedAt);
    draw();
    screen.signal(connected && !wifi.active() ? lastSignal : 0);
    if (loading) screen.loading(now);
    screen.present();
  }
  delay(2);
}

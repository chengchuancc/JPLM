#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_system.h>
#include "settings.h"
#include "peripherals.h"
#include "plm_client.h"

namespace {
Peripherals hw;
PlmClient api;
Preferences store;
String code, partId, projectId, quantity = "1", mode = "OUT", message = "Scan a material";
String pending, pendingUser, pendingServer;
bool armed = false, dirty = true, storageReady = false;
bool quantityEdited = false;
bool wifiWasConnected = false;
uint32_t wifiAttemptAt = 0, nextRefresh = 0;
String console;

void report(const String& value, bool ok = true) {
  message = value; dirty = true;
  Serial.println(value); // no credentials, cookies, or raw barcode URLs
  hw.beep(ok);
}
String newRequestId() {
  String id;
  for (unsigned i = 0; i < 4; ++i) {
    char hex[9]; snprintf(hex, sizeof(hex), "%08lx", static_cast<unsigned long>(esp_random()));
    id += hex;
  }
  return id;
}
void lookup(const String& scanned) {
  if (!pending.isEmpty()) { report("Pending operation: confirm to retry", false); return; }
  hw.trigger(false);
  armed = false; partId = ""; projectId = ""; code = scanned; quantity = "1"; quantityEdited = false;
  if (!api.authenticated()) { report("Login first (serial: login)", false); return; }
  JsonDocument result;
  if (!api.lookup(scanned, result)) { report(api.error(), false); return; }
  partId = result["id"].as<String>(); projectId = result["project_id"].as<String>();
  if (partId.length() != 24 || projectId.isEmpty()) {
    partId = ""; projectId = ""; report("Material response missing identity", false); return;
  }
  code = result["code"].as<String>();
  report("Stock: " + String(result["stock"].as<double>(), 6));
}
bool persistPending(const String& body, const String& user) {
  if (!storageReady) return false;
  // One NVS value commits the exact request and its authenticated owner together.
  JsonDocument record; record["body"] = body; record["user"] = user;
  record["server"] = TERMINAL_API_URL;
  String saved; serializeJson(record, saved);
  return store.putString("pending", saved) == saved.length();
}
void submitPending() {
  hw.trigger(false);
  if (!api.authenticated()) { report("Login first; pending request retained", false); return; }
  if (pendingServer != TERMINAL_API_URL) { report("Retry requires the original server", false); return; }
  if (api.userId() != pendingUser) { report("Retry requires the original account", false); return; }
  JsonDocument result;
  if (!api.submit(pending, result)) {
    report("Pending retained. " + api.error(), false); return;
  }
  // Never forget a pending request until clearing NVS succeeds.
  if (!store.remove("pending")) {
    report("Saved on server; NVS clear failed. Retry is safe.", false); return;
  }
  pending = ""; pendingUser = ""; pendingServer = "";
  partId = ""; projectId = ""; code = ""; quantity = "1"; quantityEdited = false; armed = false;
  report("Saved. Stock: " + String(result["stock"].as<double>(), 6));
}
void confirm() {
  if (!pending.isEmpty()) { submitPending(); return; }
  if (!api.authenticated() || partId.isEmpty() || !validQuantity(quantity.c_str())) {
    report("Login, scan material and enter quantity first", false); return;
  }
  if (!armed) { armed = true; report("Check mode/qty. Confirm again to SAVE."); return; }
  JsonDocument request;
  request["request_id"] = newRequestId(); request["project_id"] = projectId;
  request["part_id"] = partId; request["qty"] = quantity.toInt();
  request["type"] = mode == "IN" ? "入库" : mode == "OUT" ? "出库" : "报废";
  String body; serializeJson(request, body);
  if (!persistPending(body, api.userId())) { report("NVS error: nothing submitted", false); return; }
  pending = body; pendingUser = api.userId(); pendingServer = TERMINAL_API_URL; armed = false;
  submitPending();
}
void key(char value) {
  if (!value) return;
  if (!pending.isEmpty()) {
    if (value == 'E') confirm();
    else report("Pending locked: confirm retries same request", false);
    return;
  }
  if (value == 'E') { confirm(); return; }
  armed = false; dirty = true;
  if (value == 'T') { hw.trigger(true); message = "Scanning (3 second limit)"; }
  else if (value == 'I') { mode = "IN"; message = "Inbound"; }
  else if (value == 'O') { mode = "OUT"; message = "Outbound"; }
  else if (value == 'S') { mode = "SCRAP"; message = "Scrap"; }
  else if (value >= '0' && value <= '9') {
    if (!quantityEdited) { quantity = ""; quantityEdited = true; }
    if (quantity.length() < 6) quantity += value;
  } else if (value == 'X') { quantityEdited = true; quantity.remove(quantity.length() ? quantity.length() - 1 : 0); }
  else if (value == 'B') {
    hw.trigger(false); partId = ""; projectId = ""; code = ""; quantity = "1"; quantityEdited = false; message = "Cancelled";
  }
  // Arrow keys are reserved for future menu navigation.
}
void command(const String& cmd) {
  if (cmd == "help") Serial.println("status | scan | login | lookup CODE | key K | retry\nK: I/O/S mode, digits, X delete, B cancel, E confirm (twice)");
  else if (cmd == "status") {
    Serial.printf("WiFi=%s login=%s PSRAM=%u battery=%.2fV pending=%s\n",
      WiFi.status() == WL_CONNECTED ? "on" : "off", api.authenticated() ? "yes" : "no",
      ESP.getPsramSize(), hw.batteryVolts(), pending.isEmpty() ? "no" : "yes");
  } else if (cmd == "scan") key('T');
  else if (cmd == "login") {
    hw.trigger(false);
    const bool ok = api.login();
    report(ok ? "Login OK" : api.error(), ok);
  } else if (cmd.startsWith("lookup ")) lookup(cmd.substring(7));
  else if (cmd.startsWith("key ") && cmd.length() == 5) key(cmd[4]);
  else if (cmd == "retry" && !pending.isEmpty()) submitPending();
  else if (cmd == "clear-pending CONFIRMED-IN-JPLM" && !pending.isEmpty()) {
    // Explicit service recovery only, after the operator reconciles the server ledger.
    if (storageReady && store.remove("pending")) {
      pending = ""; pendingUser = ""; pendingServer = "";
      partId = ""; projectId = ""; code = ""; armed = false;
      report("Pending cleared manually. Scan again for a NEW operation.");
    } else report("NVS clear failed", false);
  }
  else Serial.println("Unknown command. Type help.");
}
}

void setup() {
  Serial.begin(115200); // native USB; do not wait indefinitely for a host
  hw.begin();
  storageReady = store.begin("jplm", false);
  if (storageReady && store.isKey("pending")) {
    JsonDocument saved;
    if (deserializeJson(saved, store.getString("pending")) ||
        !saved["body"].is<String>() || !saved["user"].is<String>() || !saved["server"].is<String>()) {
      // Lock corrupt records rather than silently allowing a duplicate operation.
      pending = "CORRUPT";
      message = "Pending record corrupt: inspect NVS before use";
    } else {
      pending = saved["body"].as<String>(); pendingUser = saved["user"].as<String>();
      pendingServer = saved["server"].as<String>();
      message = "Pending restored. Login then confirm to retry.";
    }
  }
  WiFi.persistent(false); // credentials are not written by the WiFi library
  WiFi.mode(WIFI_STA);
  if (strlen(TERMINAL_WIFI_SSID)) {
    WiFi.begin(TERMINAL_WIFI_SSID, TERMINAL_WIFI_PASSWORD); wifiAttemptAt = millis();
  }
  configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");
  Serial.println("JPLM ESP32 terminal. Type help. Offline hardware diagnostics available.");
}
void loop() {
  hw.tick();
  key(hw.pollKey());
  String scanned;
  if (hw.pollScanner(scanned)) lookup(scanned);
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r' || c == '\n') {
      if (!console.isEmpty()) command(console);
      console = "";
    } else if (console.length() < 600) console += c;
    else console = "";
  }
  const bool connected = WiFi.status() == WL_CONNECTED;
  if (connected != wifiWasConnected) { wifiWasConnected = connected; dirty = true; }
  if (!connected && strlen(TERMINAL_WIFI_SSID) && millis() - wifiAttemptAt > 15000) {
    WiFi.reconnect(); wifiAttemptAt = millis();
  }
  if (dirty || static_cast<int32_t>(millis() - nextRefresh) >= 0) {
    String status = connected ? "WiFi OK" : "Offline";
    status += api.authenticated() ? " / Logged in" : " / Login needed";
    hw.screen(status, code, mode, quantity, message);
    dirty = false; nextRefresh = millis() + 5000;
  }
  delay(2);
}

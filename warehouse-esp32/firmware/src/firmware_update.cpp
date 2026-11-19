#include "firmware_version.h"
#include "plm_client.h"
#include "settings.h"
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>

#define SCANNER_IMAGE_MARKER "JPLM_OTA_ESP32S3_N16R8:"
namespace {
const char imageVersion[] = SCANNER_IMAGE_MARKER SCANNER_FIRMWARE_VERSION;
constexpr uint32_t kDownloadDeadline = 90000;

bool validDigest(const String& digest) {
  return digest.length() == 64 && strspn(digest.c_str(), "0123456789abcdef") == 64;
}

bool newerVersion(const char* offered, const char* current) {
  unsigned target[3], running[3];
  char extra;
  if (!offered || strlen(offered) > 14 || sscanf(offered, "%u.%u.%u%c", &target[0], &target[1], &target[2], &extra) != 3
      || sscanf(current, "%u.%u.%u", &running[0], &running[1], &running[2]) != 3) return false;
  for (unsigned i = 0; i < 3; ++i) {
    if (target[i] != running[i]) return target[i] > running[i];
  }
  return false;
}

class FirmwareSink : public Stream {
 public:
  FirmwareSink(esp_ota_handle_t handle, size_t size) : handle_(handle), size_(size) {
    mbedtls_sha256_init(&sha_);
    mbedtls_sha256_starts_ret(&sha_, 0);
  }
  ~FirmwareSink() { mbedtls_sha256_free(&sha_); }
  size_t write(uint8_t byte) override { return write(&byte, 1); }
  size_t write(const uint8_t* bytes, size_t count) override {
    if (count > size_ - received_ || millis() - started_ >= kDownloadDeadline
        || esp_ota_write(handle_, bytes, count) != ESP_OK
        || mbedtls_sha256_update_ret(&sha_, bytes, count)) return 0;
    received_ += count;
    return count;
  }
  bool matches(const String& expected) {
    uint8_t bytes[32];
    if (received_ != size_ || mbedtls_sha256_finish_ret(&sha_, bytes)) return false;
    char digest[65];
    for (size_t i = 0; i < sizeof(bytes); ++i) snprintf(digest + 2 * i, 3, "%02x", bytes[i]);
    return expected == digest;
  }
  size_t received() const { return received_; }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
 private:
  esp_ota_handle_t handle_;
  size_t size_, received_ = 0;
  uint32_t started_ = millis();
  mbedtls_sha256_context sha_;
};
}

const char* const firmwareVersion = imageVersion + sizeof(SCANNER_IMAGE_MARKER) - 1;

bool PlmClient::checkFirmware(const String& key, const String& failed, JsonDocument& result) {
  resetTiming();
  if (!String(TERMINAL_API_URL).startsWith("https://") || key.length() != 64) return false;
  const String path = String("scanner/update?version=") + firmwareVersion
                      + (validDigest(failed) ? "&failed=" + failed : "");
  if (!request("GET", path, "", result, key)) return false;
  if (result["update"].isNull()) return true;
  const auto* partition = esp_ota_get_next_update_partition(nullptr);
  const auto update = result["update"].as<JsonObject>();
  if (newerVersion(update["version"].as<const char*>(), firmwareVersion)
      && validDigest(update["sha256"].as<String>()) && update["size"].is<unsigned>()
      && update["size"].as<unsigned>() >= 256 && partition && update["size"].as<unsigned>() <= partition->size) return true;
  error_ = "Invalid firmware manifest or partition size";
  transfer_.phase = "manifest";
  return false;
}

bool PlmClient::installFirmware(const String& key, const String& sha256, unsigned size) {
  resetTiming();
  if (!String(TERMINAL_API_URL).startsWith("https://") || key.length() != 64 || !validDigest(sha256)) return false;
  const auto* partition = esp_ota_get_next_update_partition(nullptr);
  if (!partition || size < 256 || size > partition->size) {
    transfer_.phase = "ota-slot";
    error_ = "Firmware does not fit OTA partition";
    return false;
  }
  WiFiClient* transport = prepareRequest("scanner/update/" + sha256, false);
  if (!transport || !connect()) return false;
  const char* headers[] = {"Content-Type"};
  http_.collectHeaders(headers, 1);
  http_.addHeader("X-Scanner-Key", key);
  const uint32_t sentAt = millis();
  transfer_.phase = "ota-response";
  status_ = http_.GET();
  headersMs_ = millis() - sentAt;
  transfer_.expected = http_.getSize();
  esp_ota_handle_t handle;
  if (status_ != 200 || http_.header("Content-Type") != "application/octet-stream"
      || transfer_.expected != static_cast<int>(size)
      || esp_ota_begin(partition, OTA_WITH_SEQUENTIAL_WRITES, &handle) != ESP_OK) {
    transport->stop();
    http_.end();
    error_ = "Firmware response rejected or OTA slot unavailable";
    return false;
  }
  const uint32_t bodyAt = millis();
  transfer_.phase = "ota-write";
  FirmwareSink sink(handle, size);
  const bool valid = http_.writeToStream(&sink) == static_cast<int>(size) && sink.matches(sha256);
  transfer_.received = sink.received();
  bodyMs_ = millis() - bodyAt;
  if (!valid) transport->stop();
  http_.end();
  if (!valid) {
    esp_ota_abort(handle);
    error_ = "Firmware download incomplete or SHA-256 mismatch";
    return false;
  }
  if (esp_ota_end(handle) != ESP_OK) {
    transfer_.phase = "ota-image";
    error_ = "Firmware image rejected by bootloader validation";
    return false;
  }
  const auto download = transfer_;
  const uint32_t connMs = connectMs_, hdrMs = headersMs_, dataMs = bodyMs_;
  const bool reused = reusedConnection_;
  JsonDocument confirmation;
  const bool confirmed = checkFirmware(key, "", confirmation)
                         && confirmation["update"]["sha256"].as<String>() == sha256;
  const int recheckTls = transfer_.tlsError;
  transfer_ = download;
  connectMs_ = connMs;
  headersMs_ = hdrMs;
  bodyMs_ = dataMs;
  reusedConnection_ = reused;
  if (!confirmed) {
    transfer_.phase = "ota-recheck";
    transfer_.tlsError = recheckTls;
    error_ = "Firmware job changed before activation";
    return false;
  }
  if (esp_ota_set_boot_partition(partition) != ESP_OK) {
    transfer_.phase = "ota-boot-slot";
    error_ = "Unable to select validated firmware slot";
    return false;
  }
  return true;
}

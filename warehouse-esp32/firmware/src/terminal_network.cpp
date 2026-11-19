#include "terminal_network.h"
#include <utility>

const char* operationLabel(Operation operation) {
  switch (operation) {
    case Operation::Users: return "POST roster";
    case Operation::SignIn: return "POST login";
    case Operation::Lookup: return "GET material";
    case Operation::Submit: return "POST movement";
    case Operation::History: return "GET history";
    case Operation::Delete: return "DELETE movement";
    case Operation::Image: return "GET thumbnail";
    case Operation::Health: return "GET health";
    case Operation::Prepare: return "preconnect";
    case Operation::KeepAlive: return "GET keepalive";
    case Operation::FirmwareCheck: return "GET firmware-check";
    case Operation::FirmwareDownload: return "GET firmware-download";
  }
  return "unknown";
}

bool TerminalNetwork::begin() {
  completed_ = xSemaphoreCreateBinary();
  return completed_ && xTaskCreate(run, "scanner-http", 12288, this, 1, &worker_) == pdPASS;
}

bool TerminalNetwork::start(NetworkJob job) {
  // Both workers are scheduled by the main loop.
  static unsigned nextRequestId = 0;
  if (busy_ || !worker_) return false;
  job_ = std::move(job);
  requestId_ = ++nextRequestId;
  busy_ = true;
  xTaskNotifyGive(worker_);
  return true;
}

const NetworkReply* TerminalNetwork::poll() {
  if (!busy_ || xSemaphoreTake(completed_, 0) != pdTRUE) return nullptr;
  busy_ = false;
  return &reply_;
}

void TerminalNetwork::run(void* context) {
  auto* network = static_cast<TerminalNetwork*>(context);
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    network->process();
    xSemaphoreGive(network->completed_);
  }
}

void TerminalNetwork::process() {
  const uint32_t startedAt = millis();
  reply_.data.clear();
  switch (job_.operation) {
    case Operation::Users:
      reply_.ok = client_.operators(job_.argument, job_.offset, reply_.data);
      break;
    case Operation::SignIn:
      reply_.ok = client_.select(job_.payload, job_.argument, reply_.data);
      break;
    case Operation::Lookup:
      reply_.ok = client_.lookup(job_.argument, reply_.data);
      break;
    case Operation::Submit:
      reply_.ok = client_.submit(job_.payload, reply_.data);
      break;
    case Operation::History:
      reply_.ok = client_.history(job_.offset, reply_.data);
      break;
    case Operation::Delete:
      reply_.ok = client_.removeMovement(job_.argument, job_.payload, reply_.data);
      break;
    case Operation::Image:
      client_.useSession(job_.payload);
      reply_.ok = client_.thumbnail(job_.argument, job_.image);
      break;
    case Operation::Health:
      reply_.ok = client_.probe(job_.argument == "fresh");
      break;
    case Operation::Prepare:
      reply_.ok = client_.prepare();
      break;
    case Operation::KeepAlive:
      reply_.ok = client_.keepAlive();
      break;
    case Operation::FirmwareCheck:
      reply_.ok = client_.checkFirmware(job_.argument, job_.payload, reply_.data);
      break;
    case Operation::FirmwareDownload:
      reply_.ok = client_.installFirmware(job_.argument, job_.payload, job_.offset);
      break;
  }
  reply_.status = client_.status();
  reply_.rejected = client_.rejected();
  reply_.error = client_.error();
  reply_.viaEdge = client_.viaEdge();
  reply_.trace[0] = '\0';
  if ((job_.operation != Operation::Prepare || !client_.reusedConnection())
      && (job_.operation != Operation::KeepAlive || reply_.status)) {
    const auto& transfer = client_.transfer();
    snprintf(reply_.trace, sizeof(reply_.trace),
             "[%lums] PLM #%u %s %s HTTP=%d %s elapsed=%lums conn=%lums headers=%lums body=%lums "
             "bytes=%u/%d cache=%s phase=%s tls=%d retry_from=%d\n",
             static_cast<unsigned long>(millis()), requestId_, operationLabel(job_.operation),
             reply_.ok ? "ok" : "fail", reply_.status, client_.reusedConnection() ? "reused" : "fresh",
             static_cast<unsigned long>(millis() - startedAt),
             static_cast<unsigned long>(client_.connectMs()),
             static_cast<unsigned long>(client_.headersMs()),
             static_cast<unsigned long>(client_.bodyMs()), transfer.received, transfer.expected, transfer.cache,
             reply_.ok ? "done" : transfer.phase, transfer.tlsError, transfer.retryHttp);
    Serial.print(reply_.trace);
  }
}

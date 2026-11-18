#include "terminal_network.h"
#include <utility>

bool TerminalNetwork::begin() {
  completed_ = xSemaphoreCreateBinary();
  return completed_ && xTaskCreate(run, "scanner-http", 12288, this, 1, &worker_) == pdPASS;
}

bool TerminalNetwork::start(NetworkJob job) {
  if (busy_ || !worker_) return false;
  job_ = std::move(job);
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
  const char* label = "";
  reply_.data.clear();
  switch (job_.operation) {
    case Operation::Users:
      label = "roster";
      reply_.ok = client_.operators(job_.argument, job_.offset, reply_.data);
      break;
    case Operation::SignIn:
      label = "login";
      reply_.ok = client_.select(job_.payload, job_.argument, reply_.data);
      break;
    case Operation::Lookup:
      label = "material";
      reply_.ok = client_.lookup(job_.argument, reply_.data);
      break;
    case Operation::Submit:
      label = "movement";
      reply_.ok = client_.submit(job_.payload, reply_.data);
      break;
    case Operation::History:
      label = "history";
      reply_.ok = client_.history(job_.offset, reply_.data);
      break;
    case Operation::Delete:
      label = "delete";
      reply_.ok = client_.removeMovement(job_.argument, job_.payload, reply_.data);
      break;
    case Operation::Image:
      label = "thumbnail";
      client_.useSession(job_.payload);
      reply_.ok = client_.thumbnail(job_.argument, job_.image);
      break;
    case Operation::Health:
      label = "health";
      reply_.ok = client_.probe(job_.argument == "fresh");
      break;
    case Operation::Prepare:
      label = "preconnect";
      reply_.ok = client_.prepare();
      break;
    case Operation::KeepAlive:
      label = "keepalive";
      reply_.ok = client_.keepAlive();
      break;
  }
  reply_.status = client_.status();
  reply_.rejected = client_.rejected();
  reply_.error = client_.error();
  reply_.viaEdge = client_.viaEdge();
  if ((job_.operation != Operation::Prepare || !client_.reusedConnection())
      && (job_.operation != Operation::KeepAlive || reply_.status)) {
    Serial.printf("PLM %s %lu ms HTTP %d%s (conn %lu / headers %lu / body %lu ms)\n", label,
                  static_cast<unsigned long>(millis() - startedAt), reply_.status,
                  client_.reusedConnection() ? " reused" : "",
                  static_cast<unsigned long>(client_.connectMs()),
                  static_cast<unsigned long>(client_.headersMs()),
                  static_cast<unsigned long>(client_.bodyMs()));
  }
}

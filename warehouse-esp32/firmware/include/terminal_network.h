#pragma once
#include "plm_client.h"
#include <freertos/semphr.h>

enum class Operation { Users, SignIn, Lookup, Submit, History, Delete, Image, Health, Prepare, KeepAlive };

struct NetworkJob {
  Operation operation;
  uint32_t generation;
  String argument, payload;
  unsigned offset;
  uint16_t* image;
};

struct NetworkReply {
  JsonDocument data;
  String error;
  int status = 0;
  bool ok = false, rejected = false, viaEdge = false;
};

class TerminalNetwork {
 public:
  bool begin();
  bool start(NetworkJob job);
  const NetworkReply* poll();
  const NetworkJob& job() const { return job_; }
  bool busy() const { return busy_; }
 private:
  static void run(void* context);
  void process();
  TaskHandle_t worker_ = nullptr;
  SemaphoreHandle_t completed_ = nullptr;
  NetworkJob job_{Operation::Users, 0, "", "", 0, nullptr};
  NetworkReply reply_;
  PlmClient client_;
  bool busy_ = false;
};

#include "wireless_debug.h"

#include <esp_system.h>
#include <fcntl.h>
#include <lwip/sockets.h>
#include <new>
#include <strings.h>

namespace {
constexpr size_t kCapacity = 8192;
const char kPage[] PROGMEM = R"HTML(<!doctype html><html lang="zh-CN">
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>JPLM 扫码枪调试</title>
<style>
*{box-sizing:border-box}body{background:#0d1117;color:#e6edf3;margin:32px auto;padding:0 20px;max-width:920px;font:16px system-ui}
h1{font-size:26px;margin-bottom:20px}form{display:flex;gap:10px;flex-wrap:wrap}
input,button{font:inherit;padding:10px 12px;border-radius:6px;border:1px solid #46566b;color:inherit;background:#161c25}
button{background:#2258a3;cursor:pointer}p{color:#aab8c9}
pre{height:60vh;overflow:auto;padding:16px;background:#161c25;border:1px solid #303a48;border-radius:6px;
white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.55 ui-monospace,monospace}
</style>
<h1>扫码枪调试</h1>
<form id="login"><input id="code" aria-label="8 位连接码" placeholder="8 位连接码" type="password"
inputmode="numeric" pattern="[0-9]{8}" maxlength="8" autocomplete="off" required><button>连接</button></form>
<p id="status" role="status">输入扫码枪屏幕上的连接码</p><pre id="logs" tabindex="0"></pre>
<script>
const form=document.querySelector('#login'), input=document.querySelector('#code');
const statusLine=document.querySelector('#status'), logs=document.querySelector('#logs');
let code='', offset=0, attempt=0, timer;
form.addEventListener('submit',event=>{
 event.preventDefault();clearTimeout(timer);code=input.value;input.value='';offset=0;
 logs.textContent='';poll(++attempt);
});
async function poll(id){
 let delay=1500;
 try{
   const result=await fetch('/logs',{cache:'no-store',headers:{'X-Debug-Code':code,'X-Log-Offset':String(offset)}});
   if(id!==attempt)return;
   if(result.status===401){statusLine.textContent='连接码有误或已变更';code='';return;}
   if(result.status===429){statusLine.textContent='尝试过多，10 秒后重试';delay=10000;}
   else{
     if(!result.ok)throw Error();
     const chunk=await result.text();
     if(id!==attempt)return;
     offset=Number(result.headers.get('X-Next-Offset'));
     const follow=logs.scrollHeight-logs.scrollTop-logs.clientHeight<32;
     logs.textContent=(logs.textContent+chunk).slice(-48000);
     if(follow)logs.scrollTop=logs.scrollHeight;
     statusLine.textContent='已连接 · 日志自动刷新';
   }
 }catch(error){
   if(id!==attempt)return;
   statusLine.textContent='连接中断，正在重试';
 }
 if(id===attempt&&code)timer=setTimeout(()=>poll(id),delay);
}
</script></html>)HTML";

bool due(uint32_t now, uint32_t deadline) {
  return static_cast<int32_t>(now - deadline) >= 0;
}

bool wouldBlock() {
  return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
}
}

struct WirelessDebug::Workspace {
  char log[kCapacity];
  char request[1536];
  char output[2048];
  char headers[450];
  const char* body = nullptr;
  size_t received = 0, headerLength = 0, bodyLength = 0, sent = 0;
};

bool WirelessDebug::enable() {
  if (enabled()) return true;
  workspace_ = new (std::nothrow) Workspace;
  if (!workspace_) return false;
  snprintf(code_, sizeof(code_), "%08lu", static_cast<unsigned long>(esp_random() % 100000000));
  createdAt_ = nextPoll_ = nextBind_ = millis();
  written_ = failures_ = 0;
  coolingDown_ = attached_ = false;
  return true;
}

void WirelessDebug::disable() {
  closeListener();
  delete workspace_;
  workspace_ = nullptr;
  memset(code_, 0, sizeof(code_));
}

void WirelessDebug::closeClient() {
  if (client_ >= 0) lwip_close(client_);
  client_ = -1;
}

void WirelessDebug::closeListener() {
  closeClient();
  if (server_ >= 0) lwip_close(server_);
  server_ = -1;
  address_ = IPAddress();
  attached_ = false;
}

void WirelessDebug::bindTo(IPAddress ip) {
  sockaddr_in local{};
  local.sin_family = AF_INET;
  local.sin_port = htons(port);
  local.sin_addr.s_addr = static_cast<uint32_t>(ip);
  server_ = lwip_socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (server_ < 0) return;
  const int reuse = 1;
  lwip_setsockopt(server_, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
  if (lwip_fcntl(server_, F_SETFL, O_NONBLOCK) < 0
      || lwip_bind(server_, reinterpret_cast<sockaddr*>(&local), sizeof(local)) < 0
      || lwip_listen(server_, 2) < 0) {
    closeListener();
    return;
  }
  address_ = ip;
}

void WirelessDebug::response(const char* status, const char* type, const char* body,
                             size_t length, uint32_t nextOffset) {
  auto& ws = *workspace_;
  ws.headerLength = snprintf(ws.headers, sizeof(ws.headers),
      "HTTP/1.1 %s\r\nContent-Type: %s; charset=utf-8\r\nContent-Length: %u\r\n"
      "Connection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
      "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; "
      "script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'\r\n"
      "X-Next-Offset: %lu\r\n\r\n", status, type, static_cast<unsigned>(length),
      static_cast<unsigned long>(nextOffset));
  ws.bodyLength = length;
  ws.body = body;
  ws.sent = 0;
}

bool WirelessDebug::request() {
  auto& ws = *workspace_;
  const size_t available = sizeof(ws.request) - ws.received - 1;
  const int count = lwip_recv(client_, ws.request + ws.received, available, MSG_DONTWAIT);
  if (count < 0 && wouldBlock()) return false;
  if (count <= 0) {
    closeClient();
    return false;
  }
  ws.received += count;
  ws.request[ws.received] = '\0';
  char* end = strstr(ws.request, "\r\n\r\n");
  if (!end) {
    if (ws.received == sizeof(ws.request) - 1) response("431 Request Header Fields Too Large", "text/plain", "", 0);
    return false;
  }
  char* firstLine = strstr(ws.request, "\r\n");
  *firstLine = '\0';
  if (!strcmp(ws.request, "GET / HTTP/1.1") || !strcmp(ws.request, "GET / HTTP/1.0")) {
    response("200 OK", "text/html", kPage, sizeof(kPage) - 1);
    return false;
  }
  if (strcmp(ws.request, "GET /logs HTTP/1.1") && strcmp(ws.request, "GET /logs HTTP/1.0")) {
    response("404 Not Found", "text/plain", "", 0);
    return false;
  }
  const uint32_t now = millis();
  if (coolingDown_ && !due(now, retryAt_)) {
    response("429 Too Many Requests", "text/plain", "", 0);
    return false;
  }
  coolingDown_ = false;
  bool valid = false;
  uint32_t offset = 0;
  for (char* line = firstLine + 2; line < end; ) {
    char* next = strstr(line, "\r\n");
    *next = '\0';
    constexpr char codeHeader[] = "X-Debug-Code:";
    constexpr char offsetHeader[] = "X-Log-Offset:";
    if (!strncasecmp(line, codeHeader, sizeof(codeHeader) - 1)) {
      const char* value = line + sizeof(codeHeader) - 1;
      while (*value == ' ' || *value == '\t') ++value;
      valid = strcmp(value, code_) == 0;
    } else if (!strncasecmp(line, offsetHeader, sizeof(offsetHeader) - 1)) {
      offset = strtoul(line + sizeof(offsetHeader) - 1, nullptr, 10);
    }
    line = next + 2;
  }
  if (!valid) {
    if (++failures_ >= 5) {
      failures_ = 0;
      coolingDown_ = true;
      retryAt_ = now + 10000;
    }
    response("401 Unauthorized", "text/plain", "", 0);
    return false;
  }
  failures_ = 0;
  const bool newReader = !attached_;
  attached_ = true;
  lastReaderAt_ = now;
  const uint32_t oldest = written_ > kCapacity ? written_ - kCapacity : 0;
  if (offset > written_) offset = 0;
  if (offset < oldest) {
    offset = oldest;
    while (offset < written_ && ws.log[offset++ % kCapacity] != '\n') {}
  }
  const size_t length = min<size_t>(sizeof(ws.output), written_ - offset);
  for (size_t i = 0; i < length; ++i) ws.output[i] = ws.log[(offset + i) % kCapacity];
  response("200 OK", "text/plain", ws.output, length, offset + length);
  return newReader;
}

void WirelessDebug::record(const char* line) {
  if (!enabled()) return;
  for (; *line; ++line) workspace_->log[written_++ % kCapacity] = *line;
}

void WirelessDebug::flush() {
  auto& ws = *workspace_;
  const bool inHeader = ws.sent < ws.headerLength;
  const size_t offset = inHeader ? ws.sent : ws.sent - ws.headerLength;
  const size_t length = (inHeader ? ws.headerLength : ws.bodyLength) - offset;
  if (!length) {
    closeClient();
    return;
  }
  const char* data = (inHeader ? ws.headers : ws.body) + offset;
  const int count = lwip_send(client_, data, min<size_t>(length, 1024), MSG_DONTWAIT);
  if (count > 0) {
    ws.sent += count;
    if (ws.sent == ws.headerLength + ws.bodyLength) closeClient();
  } else if (count == 0 || !wouldBlock()) closeClient();
}

bool WirelessDebug::tick(IPAddress ip, IPAddress subnet) {
  if (!enabled()) return false;
  const uint32_t now = millis();
  if (now - createdAt_ >= 30 * 60 * 1000UL) {
    disable();
    return false;
  }
  if (attached_ && now - lastReaderAt_ >= 6000) attached_ = false;
  const bool online = static_cast<uint32_t>(ip) != 0 && static_cast<uint32_t>(subnet) != 0;
  if ((!online || address_ != ip) && server_ >= 0) closeListener();
  if (!online || !due(now, nextPoll_)) return false;
  nextPoll_ = now + 20;
  if (server_ < 0 && due(now, nextBind_)) {
    nextBind_ = now + 2000;
    bindTo(ip);
  }
  if (server_ < 0) return false;
  if (client_ < 0) {
    sockaddr_in peer{};
    socklen_t length = sizeof(peer);
    const int accepted = lwip_accept(server_, reinterpret_cast<sockaddr*>(&peer), &length);
    if (accepted < 0) return false;
    const uint32_t mask = static_cast<uint32_t>(subnet);
    if ((peer.sin_addr.s_addr & mask) != (static_cast<uint32_t>(ip) & mask)) {
      lwip_close(accepted);
      return false;
    }
    client_ = accepted;
    acceptedAt_ = now;
    workspace_->received = workspace_->headerLength = 0;
  }
  if (now - acceptedAt_ >= 2000) {
    closeClient();
    return false;
  }
  const bool newReader = !workspace_->headerLength && request();
  if (client_ >= 0 && workspace_->headerLength) flush();
  return newReader;
}

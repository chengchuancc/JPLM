#pragma once
// Copy to local_config.h (gitignored). Never commit credentials or firmware with them.
#define TERMINAL_WIFI_SSID ""
#define TERMINAL_WIFI_PASSWORD ""
#define TERMINAL_API_URL "https://work.makagic.com/JPLM/"
#define TERMINAL_EMAIL ""
#define TERMINAL_PASSWORD ""
// Paste the SERVER'S trusted PEM root CA, not a cloud proxy certificate.
// HTTPS is refused until a CA is configured. Do not disable certificate checks.
static const char terminalServerRootCa[] = R"PEM(
)PEM";
#define TERMINAL_ROOT_CA terminalServerRootCa
// HTTP is only for explicit trusted LAN development; it transmits credentials in cleartext.
#define TERMINAL_ALLOW_HTTP 0
#define TERMINAL_ROTATION 0
#define TERMINAL_SPI_MODE 3
#define TERMINAL_BACKLIGHT_ON 1
#define TERMINAL_SCANNER_BAUD 9600
// Barcode ends at CR/LF or this UART idle interval; tune for the actual module.
#define TERMINAL_SCANNER_IDLE_MS 150
#define TERMINAL_BATTERY_SCALE 2.0f

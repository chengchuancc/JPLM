#pragma once
// Optional compile-time overrides. Phone provisioning is the default.
// Do not publish firmware built with Wi-Fi or device credentials.
#define TERMINAL_WIFI_SSID ""
#define TERMINAL_WIFI_PASSWORD ""
#define TERMINAL_API_URL "https://work.makagic.com/JPLM/"
#define TERMINAL_DEVICE_KEY ""
// The firmware includes JPLM's trusted CA roots. Define TERMINAL_ROOT_CA only for a custom server.
// HTTP is only for explicit trusted LAN development; it transmits credentials in cleartext.
#define TERMINAL_ALLOW_HTTP 0
#define TERMINAL_ROTATION 2
#define TERMINAL_SPI_MODE 3
#define TERMINAL_BACKLIGHT_ON 1
#define TERMINAL_SCANNER_BAUD 9600
// Barcode ends at CR/LF or this UART idle interval; tune for the actual module.
#define TERMINAL_SCANNER_IDLE_MS 150
#define TERMINAL_BATTERY_SCALE 2.0f

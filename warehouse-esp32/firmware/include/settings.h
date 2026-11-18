#pragma once
#if __has_include("local_config.h")
#include "local_config.h"
#endif
#ifndef TERMINAL_WIFI_SSID
#define TERMINAL_WIFI_SSID ""
#endif
#ifndef TERMINAL_WIFI_PASSWORD
#define TERMINAL_WIFI_PASSWORD ""
#endif
#ifndef TERMINAL_API_URL
#define TERMINAL_API_URL "https://work.makagic.com/JPLM/"
#endif
#ifndef TERMINAL_DEVICE_KEY
#define TERMINAL_DEVICE_KEY ""
#endif
#ifndef TERMINAL_ROOT_CA
#include "jplm_root_ca.h"
#define TERMINAL_ROOT_CA kJplmRootCa
#endif
#ifndef TERMINAL_ALLOW_HTTP
#define TERMINAL_ALLOW_HTTP 0
#endif
#ifndef TERMINAL_UTC_OFFSET
#define TERMINAL_UTC_OFFSET (8 * 3600)
#endif
#ifndef TERMINAL_ROTATION
#define TERMINAL_ROTATION 2
#endif
#ifndef TERMINAL_SPI_MODE
#define TERMINAL_SPI_MODE 3
#endif
#ifndef TERMINAL_BACKLIGHT_ON
#define TERMINAL_BACKLIGHT_ON 1
#endif
#ifndef TERMINAL_SCANNER_BAUD
#define TERMINAL_SCANNER_BAUD 9600
#endif
#ifndef TERMINAL_SCANNER_IDLE_MS
#define TERMINAL_SCANNER_IDLE_MS 150
#endif
#ifndef TERMINAL_BATTERY_SCALE
#define TERMINAL_BATTERY_SCALE 2.0f
#endif

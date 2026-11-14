#pragma once
#include <stdint.h>

// GPIO numbers, not WROOM module pad numbers. Source: docs/gpio-review.md.
namespace pins {
constexpr uint8_t scan = 4;
constexpr uint8_t rows[] = {5, 6, 7, 8, 9};
constexpr uint8_t cols[] = {10, 11, 12, 13};
constexpr uint8_t scannerPower = 15; // P-MOS: LOW = on
constexpr uint8_t scannerTrigger = 16; // open drain, LOW = scan
constexpr uint8_t uartTx = 17; // MCU TX -> ER RXD
constexpr uint8_t uartRx = 18; // MCU RX <- ER TXD
constexpr uint8_t buzzer = 21;
constexpr uint8_t battery = 1;
constexpr uint8_t tftClock = 42, tftData = 41, tftBacklight = 40;
constexpr uint8_t tftReset = 39, tftDc = 38;
}

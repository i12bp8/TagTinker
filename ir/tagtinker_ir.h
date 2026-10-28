/*
 * IR transmitter API.
 *
 * Sends already-built ESL frames over the built-in IR LED or over an
 * external IR module wired to GPIO pin 2 (PA7), the same pin the stock
 * Infrared app uses for external modules.
 * Frames are played by TIM1 + DMA; tagtinker_ir_transmit() blocks the calling
 * thread (sleeping, not spinning) until the last repeat has been sent.
 */

#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

typedef enum {
    TagTinkerIrOutputInternal = 0, /* built-in IR LED (PB9, TIM1 CH3N) */
    TagTinkerIrOutputGpioA7, /* external module on GPIO pin 2 (PA7, TIM1 CH1N) */
} TagTinkerIrOutput;

/* Pick the output used by the next tagtinker_ir_init(). enable_5v turns on
 * the 5V rail of GPIO pin 1 while the transmitter is initialized (only used
 * with TagTinkerIrOutputGpioA7; restored on deinit). Default: internal. */
void tagtinker_ir_set_output(TagTinkerIrOutput output, bool enable_5v);

/* Look for an external IR module on PA7, like the stock Infrared app's
 * "Detect" setting: the module must pull PA7 low against a weak pull-up.
 * Must be called while the transmitter is not initialized. */
TagTinkerIrOutput tagtinker_ir_detect_output(void);

void tagtinker_ir_init(void);

void tagtinker_ir_deinit(void);

/* Repeats are sent with PP4 timing; the high bit is ignored for legacy saved data.
 * len must be 1..TAGTINKER_IR_MAX_FRAME_LEN (96). delay is the gap between
 * repeats in 500 us units. Returns false if stopped, invalid or not init. */
bool tagtinker_ir_transmit(const uint8_t* data, size_t len, uint16_t repeats, uint8_t delay);

bool tagtinker_ir_is_busy(void);

void tagtinker_ir_stop(void);

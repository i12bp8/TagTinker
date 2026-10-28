/*
 * PP4 frame -> DMA segment table.
 *
 * Pure C, no Flipper headers: this file also builds on a PC for host tests.
 *
 * The IR carrier runs on TIM1 at 64 MHz / 51 = ~1.255 MHz. Every segment is a
 * whole number of carrier periods, either "mark" (carrier on) or "space"
 * (carrier off). On each TIM1 update event two DMA channels feed the timer:
 *   - mode[]: written to TIM1->CCMR2, takes effect immediately;
 *   - rcr[]:  written to TIM1->RCR, preloaded, takes effect one update later.
 * Because of that one-update shift the two tables are offset by one entry:
 *   mode[0]     = space (lead-in, 1 carrier period)
 *   mode[j]     = level of segment j-1          (j = 1..n)
 *   rcr[j-1]    = length of segment j-1, minus 1
 *   mode[n + 1] = space (terminal: the LED stays off once the DMA is done)
 */

#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/* Largest frame the driver accepts (matches TAGTINKER_MAX_FRAME_SIZE). */
#define TAGTINKER_IR_MAX_FRAME_LEN 96U

/* Carrier period in CPU cycles at 64 MHz (TIM1 ARR + 1). */
#define TAGTINKER_IR_CARRIER_CYCLES 51U

/* PP4 timing in carrier periods (1 period = 0.797 us). */
#define TAGTINKER_IR_BURST_PERIODS 51U /* ~40.6 us */
#define TAGTINKER_IR_GAP_SYM0      76U /* ~60.6 us */
#define TAGTINKER_IR_GAP_SYM1      304U /* ~242.3 us */
#define TAGTINKER_IR_GAP_SYM2      152U /* ~121.2 us */
#define TAGTINKER_IR_GAP_SYM3      228U /* ~181.7 us */

/* One "delay" unit between repeats = 500 us = 32000 CPU cycles. */
#define TAGTINKER_IR_DELAY_UNIT_CYCLES 32000U

/* TIM1 RCR is 16 bits: one update every RCR + 1 periods, so 65536 max. */
#define TAGTINKER_IR_MAX_SEGMENT_PERIODS 65536U

/* Worst case: 4 symbols x 2 segments per byte, closing burst, a 255-unit
 * repeat gap split in 3 chunks, lead-in and terminal entries. */
#define TAGTINKER_IR_SEQ_CAPACITY (TAGTINKER_IR_MAX_FRAME_LEN * 8U + 1U + 3U + 2U)

typedef struct {
    size_t frame_entries; /* DMA count for the last repeat (no trailing gap) */
    size_t total_entries; /* DMA count for a repeat followed by the gap */
    uint32_t frame_periods; /* carrier periods for frame_entries */
    uint32_t total_periods; /* carrier periods for total_entries */
} TagTinkerIrSeqInfo;

/* Repeat gap in carrier periods for a given delay value (500 us units). */
uint32_t tagtinker_ir_seq_gap_periods(uint8_t delay);

/*
 * Fill mode[] and rcr[] (both `capacity` entries long) for one frame followed
 * by `gap_periods` of space. `mark` and `space` are the raw CCMR2 values.
 * Returns false if the tables are too small or the input is invalid.
 */
bool tagtinker_ir_seq_build(
    const uint8_t* data,
    size_t len,
    uint32_t gap_periods,
    uint8_t mark,
    uint8_t space,
    uint8_t* mode,
    uint16_t* rcr,
    size_t capacity,
    TagTinkerIrSeqInfo* info);

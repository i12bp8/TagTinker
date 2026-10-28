/*
 * Host test for ir/tagtinker_ir_seq.c (runs on a PC, no Flipper needed).
 *
 * It replays the DMA tables through a small model of TIM1 + the two DMA
 * channels, rebuilds the IR waveform, and checks it against the timing of
 * the original bit-banging driver (CPU cycles at 64 MHz).
 *
 * Build and run:  make test
 */

#include "../ir/tagtinker_ir_seq.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#define MARK  1U
#define SPACE 0U

/* Timing of the original driver, in CPU cycles, indexed by symbol value. */
#define OLD_BURST_CYCLES 2581.0
static const double old_gap_cycles[4] = {3871.0, 15483.0, 7741.0, 11612.0};

/* Rounding to whole carrier periods may move an edge by half a period. */
#define MAX_EDGE_ERROR_US 0.40

typedef struct {
    uint8_t level;
    uint32_t periods;
} Seg;

static int failures = 0;

#define CHECK(cond, ...)                                     \
    do {                                                     \
        if(!(cond)) {                                        \
            failures++;                                      \
            printf("FAIL %s:%d: ", __FILE__, __LINE__);      \
            printf(__VA_ARGS__);                             \
            printf("\n");                                    \
        }                                                    \
    } while(0)

static void push_seg(Seg* out, size_t* n, uint8_t level, uint32_t periods) {
    if(*n > 0 && out[*n - 1].level == level) {
        out[*n - 1].periods += periods;
    } else {
        out[*n].level = level;
        out[*n].periods = periods;
        (*n)++;
    }
}

/*
 * Model of the hardware:
 *  - after the forced update: output = space, RCR shadow = preload = 0;
 *  - a segment lasts (RCR shadow + 1) carrier periods;
 *  - at each update: shadow <- preload, then DMA writes mode[i] (applies now)
 *    and rcr[i] (goes to preload);
 *  - when the last mode[] entry has been written, DMA "transfer complete"
 *    fires and the driver halts the timer.
 */
static size_t simulate(
    const uint8_t* mode,
    const uint16_t* rcr,
    size_t entries,
    Seg* out,
    uint32_t* total_periods) {
    uint8_t level = SPACE;
    uint32_t shadow = 0;
    uint32_t preload = 0;
    size_t n = 0;
    *total_periods = 0;

    for(size_t i = 0; i < entries; i++) {
        uint32_t len = shadow + 1U;
        push_seg(out, &n, level, len);
        *total_periods += len;

        /* Update event */
        shadow = preload;
        level = mode[i];
        preload = rcr[i];
    }
    /* Transfer complete: the output is now mode[entries - 1], halted. */
    CHECK(level == SPACE, "carrier left on after transfer complete");
    return n;
}

/* Reference waveform of the old driver, in CPU cycles. */
static size_t reference(const uint8_t* data, size_t len, double* out_cycles, uint8_t* out_level) {
    size_t n = 0;
    for(size_t i = 0; i < len; i++) {
        uint8_t b = data[i];
        for(int s = 0; s < 4; s++) {
            out_level[n] = MARK;
            out_cycles[n++] = OLD_BURST_CYCLES;
            out_level[n] = SPACE;
            out_cycles[n++] = old_gap_cycles[b & 3U];
            b >>= 2;
        }
    }
    out_level[n] = MARK;
    out_cycles[n++] = OLD_BURST_CYCLES;
    return n;
}

static double periods_to_us(uint32_t p) {
    return p * (double)TAGTINKER_IR_CARRIER_CYCLES / 64.0;
}

static void check_frame(const uint8_t* data, size_t len, uint8_t delay) {
    static uint8_t mode[TAGTINKER_IR_SEQ_CAPACITY];
    static uint16_t rcr[TAGTINKER_IR_SEQ_CAPACITY];
    static Seg wave[TAGTINKER_IR_SEQ_CAPACITY + 8];
    static double ref_cycles[TAGTINKER_IR_SEQ_CAPACITY];
    static uint8_t ref_level[TAGTINKER_IR_SEQ_CAPACITY];

    TagTinkerIrSeqInfo info;
    uint32_t gap = tagtinker_ir_seq_gap_periods(delay);
    bool ok = tagtinker_ir_seq_build(
        data, len, gap, MARK, SPACE, mode, rcr, TAGTINKER_IR_SEQ_CAPACITY, &info);
    CHECK(ok, "build failed len=%zu delay=%u", len, delay);
    if(!ok) return;

    size_t ref_n = reference(data, len, ref_cycles, ref_level);

    /* --- Last repeat: frame only --- */
    uint32_t periods;
    size_t n = simulate(mode, rcr, info.frame_entries, wave, &periods);
    CHECK(periods == info.frame_periods, "frame periods %u != info %u", periods, info.frame_periods);

    /* wave[0] is the 2-period lead-in, then one segment per reference edge. */
    CHECK(wave[0].level == SPACE && wave[0].periods == 2, "bad lead-in");
    CHECK(n == ref_n + 1, "segment count %zu != %zu (len=%zu)", n, ref_n + 1, len);

    for(size_t i = 0; i < ref_n && i + 1 < n; i++) {
        double want_us = ref_cycles[i] / 64.0;
        double got_us = periods_to_us(wave[i + 1].periods);
        CHECK(wave[i + 1].level == ref_level[i], "level mismatch at %zu", i);
        CHECK(
            fabs(got_us - want_us) <= MAX_EDGE_ERROR_US,
            "segment %zu: %.2f us vs %.2f us",
            i,
            got_us,
            want_us);
    }

    /* PP4 is pulse-position coded: the tag decodes each symbol from the time
     * between two bursts, so that interval is what must match. (Absolute
     * time may drift a little over a long frame; that is harmless.) */
    for(size_t i = 0; i + 1 < ref_n && i + 2 < n; i += 2) {
        double want_us = (ref_cycles[i] + ref_cycles[i + 1]) / 64.0;
        double got_us = periods_to_us(wave[i + 1].periods + wave[i + 2].periods);
        CHECK(
            fabs(got_us - want_us) <= 2 * MAX_EDGE_ERROR_US,
            "symbol %zu: %.2f us vs %.2f us",
            i / 2,
            got_us,
            want_us);
    }

    /* --- Other repeats: frame + gap --- */
    n = simulate(mode, rcr, info.total_entries, wave, &periods);
    CHECK(periods == info.total_periods, "total periods %u != info %u", periods, info.total_periods);
    CHECK(periods == info.frame_periods + gap, "gap not appended (delay=%u)", delay);
    if(gap > 0) {
        CHECK(wave[n - 1].level == SPACE && wave[n - 1].periods == gap, "trailing gap wrong");
    }
}

static void test_known_bytes(void) {
    /* Every symbol value, in every position of a byte. */
    const uint8_t data[] = {0x00, 0x55, 0xAA, 0xFF, 0xE4, 0x1B};
    for(uint8_t d = 0; d <= 10; d++) {
        check_frame(data, sizeof(data), d);
    }
}

static void test_random_frames(void) {
    uint8_t buf[TAGTINKER_IR_MAX_FRAME_LEN];
    srand(1234);
    for(int t = 0; t < 2000; t++) {
        size_t len = 1U + (size_t)(rand() % TAGTINKER_IR_MAX_FRAME_LEN);
        for(size_t i = 0; i < len; i++) buf[i] = (uint8_t)rand();
        check_frame(buf, len, (uint8_t)(rand() % 12));
    }
}

static void test_long_gap_split(void) {
    /* 255 x 500 us = 127.5 ms > 65536 periods: must be split. */
    uint8_t buf[TAGTINKER_IR_MAX_FRAME_LEN];
    memset(buf, 0x5A, sizeof(buf));
    check_frame(buf, sizeof(buf), 255);
}

static void test_invalid_input(void) {
    static uint8_t mode[TAGTINKER_IR_SEQ_CAPACITY];
    static uint16_t rcr[TAGTINKER_IR_SEQ_CAPACITY];
    uint8_t buf[TAGTINKER_IR_MAX_FRAME_LEN + 1] = {0};
    TagTinkerIrSeqInfo info;

    CHECK(!tagtinker_ir_seq_build(NULL, 4, 0, 1, 0, mode, rcr, TAGTINKER_IR_SEQ_CAPACITY, &info),
          "NULL data accepted");
    CHECK(!tagtinker_ir_seq_build(buf, 0, 0, 1, 0, mode, rcr, TAGTINKER_IR_SEQ_CAPACITY, &info),
          "empty frame accepted");
    CHECK(
        !tagtinker_ir_seq_build(
            buf, sizeof(buf), 0, 1, 0, mode, rcr, TAGTINKER_IR_SEQ_CAPACITY, &info),
        "oversized frame accepted");
    CHECK(!tagtinker_ir_seq_build(buf, 8, 0, 1, 0, mode, rcr, 20, &info),
          "table overflow not detected");
}

int main(void) {
    test_known_bytes();
    test_random_frames();
    test_long_gap_split();
    test_invalid_input();

    if(failures) {
        printf("%d check(s) failed\n", failures);
        return 1;
    }
    printf("ir_seq: all checks passed\n");
    return 0;
}

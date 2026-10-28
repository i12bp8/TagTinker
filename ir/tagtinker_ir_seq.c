/*
 * PP4 frame -> DMA segment table. See tagtinker_ir_seq.h for the layout.
 */

#include "tagtinker_ir_seq.h"

/* Gap after the burst, indexed by the 2-bit symbol value. */
static const uint16_t pp4_gap_periods[4] = {
    TAGTINKER_IR_GAP_SYM0,
    TAGTINKER_IR_GAP_SYM1,
    TAGTINKER_IR_GAP_SYM2,
    TAGTINKER_IR_GAP_SYM3,
};

typedef struct {
    uint8_t* mode;
    uint16_t* rcr;
    size_t capacity;
    size_t count; /* segments pushed so far */
    uint32_t periods;
    bool overflow;
} SeqWriter;

/* Append one segment, split in chunks that fit the 16-bit RCR. */
static void seq_push(SeqWriter* w, uint8_t level, uint32_t periods) {
    while(periods > 0 && !w->overflow) {
        uint32_t chunk = periods;
        if(chunk > TAGTINKER_IR_MAX_SEGMENT_PERIODS) chunk = TAGTINKER_IR_MAX_SEGMENT_PERIODS;

        /* Segment k uses mode[k + 1] and rcr[k]; keep room for the terminal
         * entry mode[count + 1] and its rcr slot. */
        if(w->count + 2U >= w->capacity) {
            w->overflow = true;
            return;
        }
        w->mode[w->count + 1U] = level;
        w->rcr[w->count] = (uint16_t)(chunk - 1U);
        w->count++;
        w->periods += chunk;
        periods -= chunk;
    }
}

uint32_t tagtinker_ir_seq_gap_periods(uint8_t delay) {
    uint32_t cycles = (uint32_t)delay * TAGTINKER_IR_DELAY_UNIT_CYCLES;
    return (cycles + TAGTINKER_IR_CARRIER_CYCLES / 2U) / TAGTINKER_IR_CARRIER_CYCLES;
}

bool tagtinker_ir_seq_build(
    const uint8_t* data,
    size_t len,
    uint32_t gap_periods,
    uint8_t mark,
    uint8_t space,
    uint8_t* mode,
    uint16_t* rcr,
    size_t capacity,
    TagTinkerIrSeqInfo* info) {
    if(!data || !mode || !rcr || !info) return false;
    if(len == 0 || len > TAGTINKER_IR_MAX_FRAME_LEN) return false;
    if(capacity < 3U) return false;

    SeqWriter w = {
        .mode = mode,
        .rcr = rcr,
        .capacity = capacity,
        .count = 0,
        .periods = 0,
        .overflow = false,
    };

    /* Lead-in: the timer starts with RCR = 0, so this lasts one period. */
    mode[0] = space;

    /* LSB-first, 2 bits per symbol, exactly like the original bit-banger. */
    for(size_t i = 0; i < len; i++) {
        uint8_t byte = data[i];
        for(int sym = 0; sym < 4; sym++) {
            seq_push(&w, mark, TAGTINKER_IR_BURST_PERIODS);
            seq_push(&w, space, pp4_gap_periods[byte & 0x03U]);
            byte >>= 2;
        }
    }
    seq_push(&w, mark, TAGTINKER_IR_BURST_PERIODS); /* closing burst */
    if(w.overflow) return false;

    /* Last repeat stops here: the next mode[] entry is a space, either the
     * first gap chunk or the terminal entry written below. */
    size_t frame_segments = w.count;
    uint32_t frame_periods = w.periods;

    seq_push(&w, space, gap_periods);
    if(w.overflow) return false;

    /* Terminal entry: carrier stays off after the last DMA transfer. */
    mode[w.count + 1U] = space;
    rcr[w.count] = 0;
    rcr[w.count + 1U] = 0;

    /* Lead-in: 1 period before the first update (shadow RCR = 0) plus
     * 1 period of mode[0] (preload RCR = 0 at the first update). */
    info->frame_entries = frame_segments + 2U;
    info->total_entries = w.count + 2U;
    info->frame_periods = frame_periods + 2U;
    info->total_periods = w.periods + 2U;
    return true;
}

/*
 * IR transmitter, DMA driven.
 *
 * TIM1 drives the IR output with a ~1.255 MHz carrier: CH3N for the built-in
 * LED (PB9) or CH1N for an external module on GPIO pin 2 (PA7).
 * The stock furi_hal_infrared API caps the carrier at 1 MHz, so this file
 * drives TIM1 itself, using the same technique as the firmware:
 *
 *   - TIM1 counts carrier periods. Its repetition counter (RCR) makes it
 *     raise an update event only every RCR + 1 periods, i.e. once per
 *     segment (burst or gap).
 *   - On each update event, DMA2 channel 1 writes the next output mode
 *     (PWM2 = carrier on, forced inactive = off) into TIM1->CCMR2 (CH3) or
 *     TIM1->CCMR1 (CH1), and
 *     DMA2 channel 2 writes the next segment length into TIM1->RCR.
 *
 * The whole frame is played by hardware: no busy loop, no critical section.
 * The calling thread sleeps on a semaphore until the DMA "transfer complete"
 * interrupt, so the GUI and the radio stack keep running during a send.
 */

#include "tagtinker_ir.h"
#include "tagtinker_ir_seq.h"

#include <furi.h>
#include <furi_hal.h>
#include <furi_hal_bus.h>
#include <furi_hal_resources.h>
#include <furi_hal_gpio.h>
#include <furi_hal_interrupt.h>
#include <furi_hal_infrared.h>
#include <furi_hal_power.h>
#include <power/power_service/power.h>

#include <stm32wbxx_ll_tim.h>
#include <stm32wbxx_ll_dma.h>

#define TAG "TagTinkerIR"

/* Carrier: 64 MHz / 51 = ~1.255 MHz, 49 % duty. */
#define CARRIER_TIM TIM1
#define CARRIER_ARR (TAGTINKER_IR_CARRIER_CYCLES - 1U)
#define CARRIER_CCR 25U

/* DMA2 channels 1 and 2, the pair the firmware IR driver uses for TX. */
#define IR_DMA          DMA2
#define IR_DMA_CH_MODE  LL_DMA_CHANNEL_1
#define IR_DMA_CH_RCR   LL_DMA_CHANNEL_2
#define IR_DMA_MODE_IRQ FuriHalInterruptIdDma2Ch1

/* CCMRx values written by DMA. OC3 sits in the low byte of CCMR2 exactly
 * like OC1 sits in the low byte of CCMR1, so one value fits both outputs.
 * OCxPE keeps CCRx preloaded. */
#define CCMR_MARK  ((uint8_t)(TIM_CCMR2_OC3PE | LL_TIM_OCMODE_PWM2))
#define CCMR_SPACE ((uint8_t)(TIM_CCMR2_OC3PE | LL_TIM_OCMODE_FORCED_INACTIVE))

/* Let the 5V rail settle before the first frame. */
#define IR_OTG_SETTLE_MS 100U

/* Extra time allowed on top of the computed frame duration. */
#define IR_TIMEOUT_MARGIN_MS 20U

typedef struct {
    const GpioPin* pin;
    uint32_t channel; /* LL_TIM_CHANNEL_CHx, output compare config */
    uint32_t channel_n; /* LL_TIM_CHANNEL_CHxN, the pin actually driven */
    volatile uint32_t* ccmr; /* CCMRx register fed by DMA */
} IrOutputHw;

typedef struct {
    bool initialized;
    TagTinkerIrOutput output;
    bool want_5v;
    bool otg_enabled_by_us;
    IrOutputHw hw;
    volatile bool busy;
    volatile bool stop_requested;
    volatile bool dma_error;
    FuriSemaphore* done;
    uint8_t* mode; /* CCMR2 values, one byte per entry */
    uint16_t* rcr; /* RCR values, one halfword per entry */
} TagTinkerIr;

static TagTinkerIr ir = {0};

static IrOutputHw ir_output_hw(TagTinkerIrOutput output) {
    IrOutputHw hw;
    if(output == TagTinkerIrOutputGpioA7) {
        hw.pin = &gpio_ext_pa7;
        hw.channel = LL_TIM_CHANNEL_CH1;
        hw.channel_n = LL_TIM_CHANNEL_CH1N;
        hw.ccmr = &CARRIER_TIM->CCMR1;
    } else {
        hw.pin = &gpio_infrared_tx;
        hw.channel = LL_TIM_CHANNEL_CH3;
        hw.channel_n = LL_TIM_CHANNEL_CH3N;
        hw.ccmr = &CARRIER_TIM->CCMR2;
    }
    return hw;
}

void tagtinker_ir_set_output(TagTinkerIrOutput output, bool enable_5v) {
    /* Takes effect on the next init; never switch pins under a running timer. */
    ir.output = (output == TagTinkerIrOutputGpioA7) ? output : TagTinkerIrOutputInternal;
    ir.want_5v = enable_5v && (ir.output == TagTinkerIrOutputGpioA7);
}

TagTinkerIrOutput tagtinker_ir_detect_output(void) {
    if(ir.initialized) return ir.output;
    return (furi_hal_infrared_detect_tx_output() == FuriHalInfraredTxPinExtPA7) ?
               TagTinkerIrOutputGpioA7 :
               TagTinkerIrOutputInternal;
}

static void ir_set_5v(bool enable) {
    Power* power = furi_record_open(RECORD_POWER);
    power_enable_otg(power, enable);
    furi_record_close(RECORD_POWER);
}

static void ir_dma_isr(void* context) {
    UNUSED(context);

    if(LL_DMA_IsActiveFlag_TE1(IR_DMA)) {
        LL_DMA_ClearFlag_TE1(IR_DMA);
        ir.dma_error = true;
        furi_semaphore_release(ir.done);
    }
    if(LL_DMA_IsActiveFlag_TC1(IR_DMA)) {
        LL_DMA_ClearFlag_TC1(IR_DMA);
        furi_semaphore_release(ir.done);
    }
}

static void ir_dma_config(void) {
    LL_DMA_InitTypeDef cfg = {0};

    /* Channel 1: mode byte -> CCMR2 or CCMR1 (zero-extended to a word, so the
     * unused channel 4 / channel 2 bits stay cleared). */
    cfg.PeriphOrM2MSrcAddress = (uint32_t)ir.hw.ccmr;
    cfg.MemoryOrM2MDstAddress = (uint32_t)ir.mode;
    cfg.Direction = LL_DMA_DIRECTION_MEMORY_TO_PERIPH;
    cfg.Mode = LL_DMA_MODE_NORMAL;
    cfg.PeriphOrM2MSrcIncMode = LL_DMA_PERIPH_NOINCREMENT;
    cfg.MemoryOrM2MDstIncMode = LL_DMA_MEMORY_INCREMENT;
    cfg.PeriphOrM2MSrcDataSize = LL_DMA_PDATAALIGN_WORD;
    cfg.MemoryOrM2MDstDataSize = LL_DMA_MDATAALIGN_BYTE;
    cfg.NbData = 0;
    cfg.PeriphRequest = LL_DMAMUX_REQ_TIM1_UP;
    cfg.Priority = LL_DMA_PRIORITY_VERYHIGH;
    LL_DMA_Init(IR_DMA, IR_DMA_CH_MODE, &cfg);

    /* Channel 2: segment length -> RCR. */
    cfg.PeriphOrM2MSrcAddress = (uint32_t)&CARRIER_TIM->RCR;
    cfg.MemoryOrM2MDstAddress = (uint32_t)ir.rcr;
    cfg.PeriphOrM2MSrcDataSize = LL_DMA_PDATAALIGN_HALFWORD;
    cfg.MemoryOrM2MDstDataSize = LL_DMA_MDATAALIGN_HALFWORD;
    cfg.Priority = LL_DMA_PRIORITY_HIGH;
    LL_DMA_Init(IR_DMA, IR_DMA_CH_RCR, &cfg);
}

/* Stop the timer and both DMA channels, carrier forced off. */
static void ir_hw_halt(void) {
    LL_TIM_DisableCounter(CARRIER_TIM);
    LL_TIM_DisableDMAReq_UPDATE(CARRIER_TIM);
    LL_DMA_DisableChannel(IR_DMA, IR_DMA_CH_MODE);
    LL_DMA_DisableChannel(IR_DMA, IR_DMA_CH_RCR);
    LL_DMA_DisableIT_TC(IR_DMA, IR_DMA_CH_MODE);
    LL_DMA_DisableIT_TE(IR_DMA, IR_DMA_CH_MODE);
    *ir.hw.ccmr = CCMR_SPACE;
}

/* Play the first `entries` entries of the tables once. Blocks until done. */
static bool ir_play(size_t entries, uint32_t periods) {
    /* Reset the timer with the carrier off and RCR = 0. UDE is off here, so
     * this forced update loads the shadow registers without a DMA request. */
    ir_hw_halt();
    LL_TIM_SetRepetitionCounter(CARRIER_TIM, 0);
    LL_TIM_SetCounter(CARRIER_TIM, 0);
    LL_TIM_GenerateEvent_UPDATE(CARRIER_TIM);
    LL_TIM_ClearFlag_UPDATE(CARRIER_TIM);

    LL_DMA_ClearFlag_GI1(IR_DMA);
    LL_DMA_ClearFlag_GI2(IR_DMA);
    LL_DMA_SetMemoryAddress(IR_DMA, IR_DMA_CH_MODE, (uint32_t)ir.mode);
    LL_DMA_SetDataLength(IR_DMA, IR_DMA_CH_MODE, entries);
    LL_DMA_SetMemoryAddress(IR_DMA, IR_DMA_CH_RCR, (uint32_t)ir.rcr);
    LL_DMA_SetDataLength(IR_DMA, IR_DMA_CH_RCR, entries);
    LL_DMA_EnableIT_TC(IR_DMA, IR_DMA_CH_MODE);
    LL_DMA_EnableIT_TE(IR_DMA, IR_DMA_CH_MODE);
    LL_DMA_EnableChannel(IR_DMA, IR_DMA_CH_RCR);
    LL_DMA_EnableChannel(IR_DMA, IR_DMA_CH_MODE);

    /* Drop a stale completion; a stop already requested still wins below
     * because the flag is set before the semaphore is released. */
    furi_semaphore_acquire(ir.done, 0);
    ir.dma_error = false;
    if(ir.stop_requested) {
        ir_hw_halt();
        return false;
    }

    LL_TIM_EnableDMAReq_UPDATE(CARRIER_TIM);
    LL_TIM_EnableCounter(CARRIER_TIM);

    /* periods * 51 cycles / 64 MHz, in ms, rounded up, plus margin. */
    uint32_t us = (uint32_t)(((uint64_t)periods * TAGTINKER_IR_CARRIER_CYCLES + 63U) / 64U);
    uint32_t timeout_ms = (us + 999U) / 1000U + IR_TIMEOUT_MARGIN_MS;
    FuriStatus status = furi_semaphore_acquire(ir.done, furi_ms_to_ticks(timeout_ms));

    ir_hw_halt();

    if(status != FuriStatusOk) {
        FURI_LOG_E(TAG, "DMA timeout");
        return false;
    }
    if(ir.dma_error) {
        FURI_LOG_E(TAG, "DMA transfer error");
        return false;
    }
    return !ir.stop_requested;
}

void tagtinker_ir_init(void) {
    if(ir.initialized) return;

    /* Another app or the CLI may be using the IR hardware. */
    if(furi_hal_infrared_is_busy()) {
        FURI_LOG_E(TAG, "IR hardware busy");
        return;
    }

    ir.mode = malloc(TAGTINKER_IR_SEQ_CAPACITY * sizeof(uint8_t));
    ir.rcr = malloc(TAGTINKER_IR_SEQ_CAPACITY * sizeof(uint16_t));
    ir.done = furi_semaphore_alloc(1, 0);

    ir.hw = ir_output_hw(ir.output);

    /* External modules are often powered from GPIO pin 1 (5V). Only switch
     * the rail on if nobody else did, so deinit can restore it. */
    ir.otg_enabled_by_us = false;
    if(ir.want_5v && !furi_hal_power_is_otg_enabled()) {
        ir_set_5v(true);
        ir.otg_enabled_by_us = true;
        furi_delay_ms(IR_OTG_SETTLE_MS);
    }

    if(furi_hal_bus_is_enabled(FuriHalBusTIM1)) {
        furi_hal_bus_disable(FuriHalBusTIM1);
    }
    furi_hal_bus_enable(FuriHalBusTIM1);

    /* Drive the pin low before handing it to the timer: no false pulse. */
    LL_GPIO_ResetOutputPin(ir.hw.pin->port, ir.hw.pin->pin);
    furi_hal_gpio_init_ex(
        ir.hw.pin, GpioModeAltFunctionPushPull, GpioPullNo, GpioSpeedVeryHigh, GpioAltFn1TIM1);

    LL_TIM_SetPrescaler(CARRIER_TIM, 0);
    LL_TIM_SetCounterMode(CARRIER_TIM, LL_TIM_COUNTERMODE_UP);
    LL_TIM_EnableARRPreload(CARRIER_TIM);
    LL_TIM_SetAutoReload(CARRIER_TIM, CARRIER_ARR);
    LL_TIM_SetRepetitionCounter(CARRIER_TIM, 0);
    LL_TIM_SetCounter(CARRIER_TIM, 0);

    if(ir.output == TagTinkerIrOutputGpioA7) {
        LL_TIM_OC_SetCompareCH1(CARRIER_TIM, CARRIER_CCR);
    } else {
        LL_TIM_OC_SetCompareCH3(CARRIER_TIM, CARRIER_CCR);
    }
    LL_TIM_OC_EnablePreload(CARRIER_TIM, ir.hw.channel);
    LL_TIM_OC_SetMode(CARRIER_TIM, ir.hw.channel, LL_TIM_OCMODE_FORCED_INACTIVE);
    LL_TIM_OC_SetPolarity(CARRIER_TIM, ir.hw.channel_n, LL_TIM_OCPOLARITY_HIGH);
    LL_TIM_OC_DisableFast(CARRIER_TIM, ir.hw.channel);
    LL_TIM_CC_EnableChannel(CARRIER_TIM, ir.hw.channel_n);
    LL_TIM_DisableMasterSlaveMode(CARRIER_TIM);
    LL_TIM_DisableIT_UPDATE(CARRIER_TIM);
    LL_TIM_EnableAllOutputs(CARRIER_TIM);

    ir_dma_config();
    furi_hal_interrupt_set_isr(IR_DMA_MODE_IRQ, ir_dma_isr, NULL);

    ir_hw_halt();
    ir.stop_requested = false;
    ir.busy = false;
    ir.initialized = true;
}

void tagtinker_ir_deinit(void) {
    if(!ir.initialized) return;

    ir_hw_halt();
    furi_hal_interrupt_set_isr(IR_DMA_MODE_IRQ, NULL, NULL);
    LL_DMA_DeInit(IR_DMA, IR_DMA_CH_MODE);
    LL_DMA_DeInit(IR_DMA, IR_DMA_CH_RCR);

    LL_TIM_DisableAllOutputs(CARRIER_TIM);
    LL_TIM_CC_DisableChannel(CARRIER_TIM, ir.hw.channel_n);

    if(furi_hal_bus_is_enabled(FuriHalBusTIM1)) {
        furi_hal_bus_disable(FuriHalBusTIM1);
    }

    furi_hal_gpio_init(ir.hw.pin, GpioModeAnalog, GpioPullNo, GpioSpeedLow);

    if(ir.otg_enabled_by_us) {
        ir_set_5v(false);
        ir.otg_enabled_by_us = false;
    }

    furi_semaphore_free(ir.done);
    free(ir.mode);
    free(ir.rcr);
    ir.done = NULL;
    ir.mode = NULL;
    ir.rcr = NULL;
    ir.initialized = false;
}

bool tagtinker_ir_transmit(const uint8_t* data, size_t len, uint16_t repeats_raw, uint8_t delay) {
    if(!ir.initialized) return false;
    if(!data || len == 0 || len > TAGTINKER_IR_MAX_FRAME_LEN) return false;

    /* Same contract as before: a new transmit clears an old stop request. */
    ir.stop_requested = false;
    uint32_t repeats = repeats_raw & 0x7FFFU;

    TagTinkerIrSeqInfo info;
    if(!tagtinker_ir_seq_build(
           data,
           len,
           tagtinker_ir_seq_gap_periods(delay),
           CCMR_MARK,
           CCMR_SPACE,
           ir.mode,
           ir.rcr,
           TAGTINKER_IR_SEQ_CAPACITY,
           &info)) {
        return false;
    }

    ir.busy = true;
    bool ok = true;
    for(uint32_t rep = 0; rep <= repeats; rep++) {
        /* Every repeat but the last plays the gap after the frame. */
        bool last = (rep == repeats);
        ok = ir_play(
            last ? info.frame_entries : info.total_entries,
            last ? info.frame_periods : info.total_periods);
        if(!ok) break;
    }
    ir.busy = false;

    return ok;
}

bool tagtinker_ir_is_busy(void) {
    return ir.busy;
}

void tagtinker_ir_stop(void) {
    /* Called from the GUI thread: only signal, the TX thread halts the
     * hardware itself when it wakes up. Flag first, then wake. */
    ir.stop_requested = true;
    if(ir.initialized && ir.done) {
        furi_semaphore_release(ir.done);
    }
}

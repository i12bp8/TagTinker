/*
 * USB serial control (issue #21). See tagtinker_cli.h.
 *
 * Threads: the command runs in a CLI thread. That thread only parses the
 * arguments (and reads the saved tag list for "list"). Everything that
 * changes app state or the GUI runs on the GUI thread, through a view
 * dispatcher custom event; the CLI thread then waits until the transmit
 * scene reports the result.
 */

#include "tagtinker_cli.h"
#include "../tagtinker_app.h"

#include <cli/cli.h>
#include <toolbox/args.h>
#include <toolbox/pipe.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#define CLI_COMMAND "tagtinker"

#define CLI_POLL_MS           100U
#define CLI_SEND_TIMEOUT_MS   (10U * 60U * 1000U)
#define CLI_STOP_TIMEOUT_MS   5000U
#define CLI_CLOSE_GRACE_MS    200U
#define CLI_TAG_LEN           32U
#define CLI_FILE_LEN          128U
#define CLI_TEXT_LEN          63U /* app->text_input_buf is 64 bytes */
#define CLI_DEFAULT_REPEATS   200U
#define CLI_MAX_REPEATS       2000U
#define CLI_PING_REPEATS      160U
#define CLI_ADDRESSED_REPEATS 80U
#define CLI_DEFAULT_DURATION  15U

typedef enum {
    CliReqLed,
    CliReqPage,
    CliReqImage,
    CliReqText,
    CliReqRaw,
} CliReqKind;

typedef struct {
    CliReqKind kind;
    char tag[CLI_TAG_LEN + 1]; /* "#" from list, name or barcode; "all" = broadcast */
    uint8_t page; /* image/text: page 1-8 as on the Flipper; page cmd: 0-7 */
    bool forever;
    uint16_t duration; /* seconds */
    bool invert;
    bool accent;
    uint16_t repeats;
    uint8_t raw[TAGTINKER_MAX_FRAME_SIZE];
    size_t raw_len;
    char file[CLI_FILE_LEN + 1];
    char text[CLI_TEXT_LEN + 1];
} CliRequest;

typedef struct {
    CliRegistry* registry;
    FuriMutex* lock; /* one send at a time */
    FuriSemaphore* done; /* GUI thread -> waiting CLI thread */
    CliRequest req; /* written by the CLI thread before posting the event */
    volatile bool pending; /* request posted, result not reported yet */
    volatile bool on_air; /* the transmit scene is running this request */
    volatile bool ok;
    char error[64];
    volatile bool closing;
    volatile uint32_t running; /* CLI callbacks currently executing */
} TagTinkerCli;

/* ------------------------------------------------------------------------ */
/* CLI thread                                                                 */
/* ------------------------------------------------------------------------ */

static void cli_print_help(void) {
    printf("Usage: tagtinker <command> [args]\r\n"
           "  list                                   saved tags\r\n"
           "  led   <tag>                            flash the tag's LED\r\n"
           "  page  <tag|all> <0-7> [secs|forever]   show a page (default 15 s)\r\n"
           "  image <tag> <1-8> <file.bmp>           send a BMP (name in dropped/ or full path)\r\n"
           "  text  <tag> <1-8> [-i] [-a] <text>     send text (-i invert, -a accent color)\r\n"
           "  raw   [-r repeats] <hex bytes>         send one frame, CRC is added\r\n"
           "  stop                                   stop the current send\r\n"
           "<tag>:  # from list, tag name (quote it if it has spaces) or 17-char barcode\r\n"
           "Pages use the Flipper's numbers: 1-8 like Set Text, 0-7 like Change Page.\r\n"
           "TagTinker must stay open on the Flipper; Back on the Flipper cancels a send.\r\n");
}

static void cli_list(TagTinkerApp* app) {
    if(app->target_count == 0) {
        printf("No saved tags. Add one on the Flipper, or pass a barcode.\r\n");
        return;
    }
    printf("#  name             barcode            type  size     color\r\n");
    for(uint8_t i = 0; i < app->target_count; i++) {
        const TagTinkerTarget* t = &app->targets[i];
        uint16_t type = 0;
        tagtinker_barcode_to_type(t->barcode, &type);
        printf(
            "%-2u %-16s %-17s  %4u  %3ux%-3u  %s\r\n",
            (unsigned)(i + 1U),
            t->name,
            t->barcode,
            (unsigned)type,
            (unsigned)t->profile.width,
            (unsigned)t->profile.height,
            tagtinker_profile_color_label(t->profile.color));
    }
}

static int cli_hex_nibble(char c) {
    if(c >= '0' && c <= '9') return c - '0';
    if(c >= 'a' && c <= 'f') return c - 'a' + 10;
    if(c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static bool cli_read_tag(FuriString* args, CliRequest* r) {
    FuriString* word = furi_string_alloc();
    bool ok = args_read_probably_quoted_string_and_trim(args, word) &&
              furi_string_size(word) > 0 && furi_string_size(word) <= CLI_TAG_LEN;
    if(ok) {
        strncpy(r->tag, furi_string_get_cstr(word), CLI_TAG_LEN);
        r->tag[CLI_TAG_LEN] = '\0';
    } else {
        printf("Missing or too long <tag>\r\n");
    }
    furi_string_free(word);
    return ok;
}

static bool cli_read_page(FuriString* args, uint8_t* page, int min, int max) {
    int value = 0;
    if(!args_read_int_and_trim(args, &value) || value < min || value > max) {
        printf("<page> must be %d-%d\r\n", min, max);
        return false;
    }
    *page = (uint8_t)value;
    return true;
}

/* Remove a leading "-x" flag from args if it is there. */
static bool cli_take_flag(FuriString* args, const char* flag) {
    size_t len = args_get_first_word_length(args);
    if(len != strlen(flag) || strncmp(furi_string_get_cstr(args), flag, len) != 0) return false;
    furi_string_right(args, len);
    furi_string_trim(args, " ");
    return true;
}

static bool cli_parse_page(FuriString* args, CliRequest* r) {
    /* Same numbers as Broadcast > Change Page. */
    if(!cli_read_tag(args, r) || !cli_read_page(args, &r->page, 0, 7)) return false;
    r->duration = CLI_DEFAULT_DURATION;
    r->forever = false;

    FuriString* word = furi_string_alloc();
    bool ok = true;
    if(args_read_string_and_trim(args, word)) {
        if(furi_string_cmp_str(word, "forever") == 0) {
            r->forever = true;
        } else {
            char* end = NULL;
            unsigned long secs = strtoul(furi_string_get_cstr(word), &end, 10);
            if(!end || *end != '\0' || secs < 1UL || secs > 65535UL) {
                printf("Duration must be 1-65535 seconds or 'forever'\r\n");
                ok = false;
            } else {
                r->duration = (uint16_t)secs;
            }
        }
    }
    furi_string_free(word);
    return ok;
}

static bool cli_parse_image(FuriString* args, CliRequest* r) {
    /* Same numbers as the Flipper's text page picker: 1-8. */
    if(!cli_read_tag(args, r) || !cli_read_page(args, &r->page, 1, 8)) return false;
    FuriString* word = furi_string_alloc();
    bool ok = args_read_probably_quoted_string_and_trim(args, word) &&
              furi_string_size(word) > 0 && furi_string_size(word) <= CLI_FILE_LEN;
    if(ok) {
        strncpy(r->file, furi_string_get_cstr(word), CLI_FILE_LEN);
        r->file[CLI_FILE_LEN] = '\0';
    } else {
        printf("Missing or too long <file.bmp>\r\n");
    }
    furi_string_free(word);
    return ok;
}

static bool cli_parse_text(FuriString* args, CliRequest* r) {
    if(!cli_read_tag(args, r) || !cli_read_page(args, &r->page, 1, 8)) return false;
    bool flag = true;
    while(flag) {
        flag = false;
        if(cli_take_flag(args, "-i")) r->invert = flag = true;
        if(cli_take_flag(args, "-a")) r->accent = flag = true;
    }

    furi_string_trim(args, " ");
    /* Allow "quoted text": drop one pair of surrounding quotes. */
    size_t len = furi_string_size(args);
    if(len >= 2U && furi_string_get_char(args, 0) == '"' &&
       furi_string_get_char(args, len - 1U) == '"') {
        furi_string_left(args, len - 1U);
        furi_string_right(args, 1U);
    }
    if(furi_string_size(args) == 0U) {
        printf("Missing <text>\r\n");
        return false;
    }
    if(furi_string_size(args) > CLI_TEXT_LEN) {
        printf("Text is cut to %u characters\r\n", (unsigned)CLI_TEXT_LEN);
    }
    strncpy(r->text, furi_string_get_cstr(args), CLI_TEXT_LEN);
    r->text[CLI_TEXT_LEN] = '\0';
    return true;
}

static bool cli_parse_raw(FuriString* args, CliRequest* r) {
    FuriString* word = furi_string_alloc();
    bool ok = true;
    r->repeats = CLI_DEFAULT_REPEATS;
    r->raw_len = 0;

    while(ok && args_read_string_and_trim(args, word)) {
        const char* s = furi_string_get_cstr(word);
        if(strcmp(s, "-r") == 0) {
            int n = 0;
            if(!args_read_int_and_trim(args, &n) || n < 1 || n > (int)CLI_MAX_REPEATS) {
                printf("-r needs 1-%u\r\n", (unsigned)CLI_MAX_REPEATS);
                ok = false;
            } else {
                r->repeats = (uint16_t)n;
            }
            continue;
        }
        /* Bytes as "85 00 06" or "850006". */
        size_t len = strlen(s);
        if(len % 2U) {
            printf("Bad hex: %s\r\n", s);
            ok = false;
            break;
        }
        for(size_t i = 0; ok && i < len; i += 2U) {
            int hi = cli_hex_nibble(s[i]);
            int lo = cli_hex_nibble(s[i + 1U]);
            if(hi < 0 || lo < 0) {
                printf("Bad hex: %s\r\n", s);
                ok = false;
            } else if(r->raw_len >= TAGTINKER_MAX_FRAME_SIZE - 2U) {
                printf("Frame too long (max %u bytes before CRC)\r\n",
                       (unsigned)(TAGTINKER_MAX_FRAME_SIZE - 2U));
                ok = false;
            } else {
                r->raw[r->raw_len++] = (uint8_t)((hi << 4) | lo);
            }
        }
    }
    if(ok && r->raw_len == 0U) {
        printf("Missing <hex bytes>\r\n");
        ok = false;
    }
    furi_string_free(word);
    return ok;
}

static void cli_send(TagTinkerApp* app, PipeSide* pipe, const CliRequest* r) {
    TagTinkerCli* cli = app->cli;
    if(furi_mutex_acquire(cli->lock, 0) != FuriStatusOk) {
        printf("Busy: another tagtinker command is running\r\n");
        return;
    }

    while(furi_semaphore_acquire(cli->done, 0) == FuriStatusOk) {
    }
    memcpy(&cli->req, r, sizeof(cli->req));
    cli->ok = false;
    cli->error[0] = '\0';
    cli->on_air = false;
    cli->pending = true;
    view_dispatcher_send_custom_event(app->view_dispatcher, TAGTINKER_CLI_EVENT_RUN);
    printf("Sending, Ctrl+C to stop...\r\n");

    uint32_t waited = 0;
    uint32_t stop_at = 0;
    bool finished = false;
    while(!cli->closing) {
        if(furi_semaphore_acquire(cli->done, furi_ms_to_ticks(CLI_POLL_MS)) == FuriStatusOk) {
            finished = true;
            break;
        }
        waited += CLI_POLL_MS;
        if(stop_at == 0U &&
           (cli_is_pipe_broken_or_is_etx_next_char(pipe) || waited >= CLI_SEND_TIMEOUT_MS)) {
            view_dispatcher_send_custom_event(app->view_dispatcher, TAGTINKER_CLI_EVENT_STOP);
            stop_at = waited;
        }
        if(stop_at != 0U && waited - stop_at >= CLI_STOP_TIMEOUT_MS) break;
    }

    if(finished && cli->ok) {
        printf("OK\r\n");
    } else if(finished) {
        printf("FAILED%s%s\r\n", cli->error[0] ? ": " : "", cli->error);
    } else {
        printf("FAILED: no answer from the app\r\n");
    }
    cli->pending = false;
    furi_mutex_release(cli->lock);
}

static void tagtinker_cli_command(PipeSide* pipe, FuriString* args, void* context) {
    TagTinkerApp* app = context;
    TagTinkerCli* cli = app->cli;
    __atomic_add_fetch(&cli->running, 1U, __ATOMIC_SEQ_CST);
    if(cli->closing) {
        printf("TagTinker is closing\r\n");
        __atomic_sub_fetch(&cli->running, 1U, __ATOMIC_SEQ_CST);
        return;
    }

    FuriString* cmd = furi_string_alloc();
    CliRequest* r = malloc(sizeof(CliRequest));
    memset(r, 0, sizeof(*r));
    bool send = false;

    if(!args_read_string_and_trim(args, cmd) || furi_string_cmp_str(cmd, "help") == 0) {
        cli_print_help();
    } else if(furi_string_cmp_str(cmd, "list") == 0) {
        cli_list(app);
    } else if(furi_string_cmp_str(cmd, "stop") == 0) {
        view_dispatcher_send_custom_event(app->view_dispatcher, TAGTINKER_CLI_EVENT_STOP);
        printf("Stop requested\r\n");
    } else if(furi_string_cmp_str(cmd, "led") == 0) {
        r->kind = CliReqLed;
        send = cli_read_tag(args, r);
    } else if(furi_string_cmp_str(cmd, "page") == 0) {
        r->kind = CliReqPage;
        send = cli_parse_page(args, r);
    } else if(furi_string_cmp_str(cmd, "image") == 0) {
        r->kind = CliReqImage;
        send = cli_parse_image(args, r);
    } else if(furi_string_cmp_str(cmd, "text") == 0) {
        r->kind = CliReqText;
        send = cli_parse_text(args, r);
    } else if(furi_string_cmp_str(cmd, "raw") == 0) {
        r->kind = CliReqRaw;
        send = cli_parse_raw(args, r);
    } else {
        printf("Unknown command '%s'\r\n", furi_string_get_cstr(cmd));
        cli_print_help();
    }

    if(send) cli_send(app, pipe, r);

    free(r);
    furi_string_free(cmd);
    __atomic_sub_fetch(&cli->running, 1U, __ATOMIC_SEQ_CST);
}

/* ------------------------------------------------------------------------ */
/* GUI thread                                                                 */
/* ------------------------------------------------------------------------ */

static void cli_report(TagTinkerCli* cli, bool ok, const char* error) {
    if(!cli->pending) return;
    cli->ok = ok;
    if(error) {
        strncpy(cli->error, error, sizeof(cli->error) - 1U);
        cli->error[sizeof(cli->error) - 1U] = '\0';
    }
    cli->on_air = false;
    cli->pending = false;
    furi_semaphore_release(cli->done);
}

/* Leave whatever screen is open (its on_exit cleans up), back to the menu. */
static void cli_go_home(TagTinkerApp* app) {
    SceneManager* sm = app->scene_manager;
    if(scene_manager_get_current_scene(sm) == TagTinkerSceneMainMenu) return;
    if(!scene_manager_search_and_switch_to_previous_scene(sm, TagTinkerSceneMainMenu)) {
        scene_manager_search_and_switch_to_another_scene(sm, TagTinkerSceneMainMenu);
    }
}

static void cli_alloc_sequence(TagTinkerApp* app, size_t count) {
    tagtinker_free_frame_sequence(app);
    app->frame_sequence = malloc(sizeof(uint8_t*) * count);
    app->frame_lengths = malloc(sizeof(size_t) * count);
    app->frame_repeats = malloc(sizeof(uint16_t) * count);
    for(size_t i = 0; i < count; i++) {
        app->frame_sequence[i] = malloc(TAGTINKER_MAX_FRAME_SIZE);
        app->frame_lengths[i] = 0;
        app->frame_repeats[i] = CLI_DEFAULT_REPEATS;
    }
    app->frame_seq_count = count;
}

static int8_t cli_resolve_target(TagTinkerApp* app, const char* tag, char* error, size_t size) {
    char* end = NULL;
    long number = strtol(tag, &end, 10);
    if(tag[0] != '\0' && end && *end == '\0') {
        if(number >= 1 && number <= (long)app->target_count) return (int8_t)(number - 1);
        snprintf(error, size, "no tag #%ld (see: tagtinker list)", number);
        return -1;
    }
    for(uint8_t i = 0; i < app->target_count; i++) {
        if(strcasecmp(app->targets[i].name, tag) == 0) return (int8_t)i;
    }
    if(tagtinker_is_barcode_valid(tag)) {
        /* Finds a saved tag or adds this barcode to the list, like web jobs. */
        int8_t index = tagtinker_ensure_target(app, tag);
        if(index >= 0) return index;
        snprintf(error, size, "cannot add tag (list full?)");
        return -1;
    }
    snprintf(error, size, "unknown tag '%s'", tag);
    return -1;
}

static bool cli_check_graphics(const TagTinkerTarget* t, char* error, size_t size) {
    if(!tagtinker_target_supports_graphics(t)) {
        snprintf(error, size, "not a graphic tag");
        return false;
    }
    if(t->profile.width == 0U || t->profile.height == 0U) {
        snprintf(error, size, "unknown size: set Custom Size on the Flipper");
        return false;
    }
    return true;
}

/* Prepare app state for the request. On success the caller opens the
 * transmit scene. */
static bool cli_prepare(TagTinkerApp* app, const CliRequest* r, char* error, size_t size) {
    bool broadcast = (r->kind == CliReqRaw) ||
                     (r->kind == CliReqPage && strcasecmp(r->tag, "all") == 0);
    const TagTinkerTarget* t = NULL;
    if(!broadcast) {
        int8_t index = cli_resolve_target(app, r->tag, error, size);
        if(index < 0) return false;
        tagtinker_select_target(app, (uint8_t)index);
        t = &app->targets[index];
    }
    app->tx_spam = false;

    switch(r->kind) {
    case CliReqLed: {
        /* Same frames as the Flipper's Ping / Flash action. */
        static const uint8_t blink[6] = {0x06, 0x49, 0x00, 0x00, 0x00, 0x05};
        cli_alloc_sequence(app, 2);
        app->frame_lengths[0] = tagtinker_make_ping_frame(app->frame_sequence[0], t->plid);
        app->frame_repeats[0] = CLI_PING_REPEATS;
        app->frame_lengths[1] =
            tagtinker_make_addressed_frame(app->frame_sequence[1], t->plid, blink, sizeof(blink));
        app->frame_repeats[1] = CLI_ADDRESSED_REPEATS;
        return true;
    }
    case CliReqPage:
        if(broadcast) {
            cli_alloc_sequence(app, 1);
            app->frame_lengths[0] = tagtinker_build_broadcast_page_frame(
                app->frame_sequence[0], r->page, r->forever, r->duration);
            app->frame_repeats[0] = CLI_DEFAULT_REPEATS;
        } else {
            /* The broadcast page command, addressed to one tag. */
            const uint8_t payload[6] = {
                0x06,
                (uint8_t)(((r->page & 7U) << 3) | 0x01U | (r->forever ? 0x80U : 0x00U)),
                0x00,
                0x00,
                (uint8_t)(r->duration >> 8),
                (uint8_t)(r->duration & 0xFFU),
            };
            cli_alloc_sequence(app, 2);
            app->frame_lengths[0] = tagtinker_make_ping_frame(app->frame_sequence[0], t->plid);
            app->frame_repeats[0] = CLI_PING_REPEATS;
            app->frame_lengths[1] = tagtinker_make_addressed_frame(
                app->frame_sequence[1], t->plid, payload, sizeof(payload));
            app->frame_repeats[1] = CLI_ADDRESSED_REPEATS;
        }
        return true;
    case CliReqRaw: {
        cli_alloc_sequence(app, 1);
        uint8_t* frame = app->frame_sequence[0];
        memcpy(frame, r->raw, r->raw_len);
        uint16_t crc = tagtinker_crc16(frame, r->raw_len);
        frame[r->raw_len] = (uint8_t)(crc & 0xFFU);
        frame[r->raw_len + 1U] = (uint8_t)(crc >> 8);
        app->frame_lengths[0] = r->raw_len + 2U;
        app->frame_repeats[0] = r->repeats;
        return true;
    }
    case CliReqImage: {
        if(!cli_check_graphics(t, error, size)) return false;
        char path[TAGTINKER_IMAGE_PATH_LEN + 1];
        if(r->file[0] == '/') {
            strncpy(path, r->file, TAGTINKER_IMAGE_PATH_LEN);
            path[TAGTINKER_IMAGE_PATH_LEN] = '\0';
        } else {
            snprintf(path, sizeof(path), "%s/%s", APP_DATA_PATH("dropped"), r->file);
        }
        Storage* storage = furi_record_open(RECORD_STORAGE);
        bool exists = storage_file_exists(storage, path);
        furi_record_close(RECORD_STORAGE);
        if(!exists) {
            snprintf(error, size, "file not found: %.40s", r->file);
            return false;
        }
        /* Page 1-8 -> protocol 0-7 on HD tags, exactly like Set Text does
         * (tagtinker_prepare_text_tx); Color 2.6 takes the page as-is. */
        uint8_t page = tagtinker_profile_uses_ui_page(&t->profile) ? r->page :
                                                                    (uint8_t)(r->page - 1U);
        app->img_page = page;
        app->draw_x = 0;
        app->draw_y = 0;
        app->color_clear = false;
        tagtinker_prepare_bmp_tx(app, t->plid, path, t->profile.width, t->profile.height, page);
        return true;
    }
    case CliReqText:
        if(!cli_check_graphics(t, error, size)) return false;
        strncpy(app->text_input_buf, r->text, sizeof(app->text_input_buf) - 1U);
        app->text_input_buf[sizeof(app->text_input_buf) - 1U] = '\0';
        app->invert_text = r->invert;
        app->color_clear = r->accent;
        app->draw_x = 0;
        app->draw_y = 0;
        app->img_page = r->page; /* 1-8, mapped by tagtinker_prepare_text_tx */
        tagtinker_prepare_text_tx(app, t->plid);
        return true;
    }
    snprintf(error, size, "bad request");
    return false;
}

bool tagtinker_cli_handle_custom_event(TagTinkerApp* app, uint32_t event) {
    TagTinkerCli* cli = app->cli;
    if(event == TAGTINKER_CLI_EVENT_STOP) {
        /* Same as Back while sending. */
        if(app->tx_active) {
            app->tx_active = false;
            tagtinker_ir_stop();
        }
        return true;
    }
    if(event != TAGTINKER_CLI_EVENT_RUN) return false;
    if(!cli || !cli->pending || cli->on_air) return true;

    if(app->tx_active) {
        cli_report(cli, false, "busy: a send is running on the Flipper");
        return true;
    }
    if(scene_manager_get_current_scene(app->scene_manager) == TagTinkerSceneWarning) {
        cli_report(cli, false, "accept the startup warning on the Flipper first");
        return true;
    }

    cli_go_home(app);
    char error[sizeof(cli->error)] = {0};
    if(!cli_prepare(app, &cli->req, error, sizeof(error))) {
        tagtinker_free_frame_sequence(app);
        cli_report(cli, false, error);
        return true;
    }
    cli->on_air = true;
    scene_manager_next_scene(app->scene_manager, TagTinkerSceneTransmit);
    return true;
}

void tagtinker_cli_tx_finished(TagTinkerApp* app, bool ok) {
    TagTinkerCli* cli = app->cli;
    if(!cli || !cli->on_air) return;
    cli_report(cli, ok, ok ? NULL : "send failed or cancelled");
}

void tagtinker_cli_register(TagTinkerApp* app) {
    TagTinkerCli* cli = malloc(sizeof(TagTinkerCli));
    memset(cli, 0, sizeof(*cli));
    cli->lock = furi_mutex_alloc(FuriMutexTypeNormal);
    cli->done = furi_semaphore_alloc(1, 0);
    cli->registry = furi_record_open(RECORD_CLI);
    app->cli = cli;
    cli_registry_add_command(
        cli->registry, CLI_COMMAND, CliCommandFlagParallelSafe, tagtinker_cli_command, app);
}

void tagtinker_cli_unregister(TagTinkerApp* app) {
    TagTinkerCli* cli = app->cli;
    if(!cli) return;

    /* Wake a waiting command first, then remove the command, then wait for
     * every running callback to return before freeing anything. */
    cli->closing = true;
    furi_semaphore_release(cli->done);
    cli_registry_delete_command(cli->registry, CLI_COMMAND);
    furi_delay_ms(CLI_CLOSE_GRACE_MS);
    while(__atomic_load_n(&cli->running, __ATOMIC_SEQ_CST) > 0U) {
        furi_delay_ms(10);
    }

    furi_record_close(RECORD_CLI);
    furi_mutex_free(cli->lock);
    furi_semaphore_free(cli->done);
    free(cli);
    app->cli = NULL;
}

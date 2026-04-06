/*
 * TagTinker - ESL Flipper Zero application
 *
 * Transmit infrared commands to supported ESL displays
 * using the built-in IR LED at 1.255 MHz carrier.
 *
 * App by I12BP8 - github.com/i12bp8
 * Research by furrtek - github.com/furrtek
 *
 * SPDX-License-Identifier: MIT
 */

#include "tagtinker_app.h"

static bool navigation_cb(void* ctx) {
    TagTinkerApp* app = ctx;
    return scene_manager_handle_back_event(app->scene_manager);
}

static void tick_cb(void* ctx) {
    TagTinkerApp* app = ctx;
    scene_manager_handle_tick_event(app->scene_manager);
}

static bool custom_event_cb(void* ctx, uint32_t event) {
    TagTinkerApp* app = ctx;
    return scene_manager_handle_custom_event(app->scene_manager, event);
}

extern const SceneManagerHandlers tagtinker_scene_handlers;

void tagtinker_settings_load(TagTinkerApp* app) {
    app->show_startup_warning = true;

    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* file = storage_file_alloc(storage);

    if(storage_file_open(file, APP_DATA_PATH("settings.txt"), FSAM_READ, FSOM_OPEN_EXISTING)) {
        char value = '1';
        if(storage_file_read(file, &value, 1) == 1) {
            app->show_startup_warning = (value != '0');
        }
        storage_file_close(file);
    }

    storage_file_free(file);
    furi_record_close(RECORD_STORAGE);
}

bool tagtinker_settings_save(const TagTinkerApp* app) {
    Storage* storage = furi_record_open(RECORD_STORAGE);
    storage_common_mkdir(storage, APP_DATA_PATH(""));

    File* file = storage_file_alloc(storage);
    bool ok = false;

    if(storage_file_open(file, APP_DATA_PATH("settings.txt"), FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        const char value = app->show_startup_warning ? '1' : '0';
        ok = (storage_file_write(file, &value, 1) == 1);
        storage_file_close(file);
    }

    storage_file_free(file);
    furi_record_close(RECORD_STORAGE);
    return ok;
}

void tagtinker_targets_load(TagTinkerApp* app) {
    app->target_count = 0;

    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* file = storage_file_alloc(storage);

    if(storage_file_open(file, APP_DATA_PATH("targets.txt"), FSAM_READ, FSOM_OPEN_EXISTING)) {
        char buf[768];
        uint16_t read = storage_file_read(file, buf, sizeof(buf) - 1);
        buf[read] = '\0';
        storage_file_close(file);

        char* line = buf;
        while(line && *line && app->target_count < TAGTINKER_MAX_TARGETS) {
            char* nl = strchr(line, '\n');
            if(nl) *nl = '\0';

            if(*line) {
                char* sep = strchr(line, '|');
                if(sep) *sep = '\0';

                if(tagtinker_barcode_to_plid(line, app->targets[app->target_count].plid)) {
                    TagTinkerTarget* target = &app->targets[app->target_count];
                    strncpy(target->barcode, line, TAGTINKER_BC_LEN);
                    target->barcode[TAGTINKER_BC_LEN] = '\0';
                    memset(target->name, 0, sizeof(target->name));

                    if(sep && *(sep + 1)) {
                        strncpy(target->name, sep + 1, TAGTINKER_TARGET_NAME_LEN);
                        target->name[TAGTINKER_TARGET_NAME_LEN] = '\0';
                    } else {
                        char suffix[7];
                        memcpy(suffix, target->barcode + TAGTINKER_BC_LEN - 6, 6);
                        suffix[6] = '\0';
                        snprintf(target->name, TAGTINKER_TARGET_NAME_LEN + 1, "Tag ...%s", suffix);
                    }

                    app->target_count++;
                }
            }

            line = nl ? nl + 1 : NULL;
        }
    }

    storage_file_free(file);
    furi_record_close(RECORD_STORAGE);
}

bool tagtinker_targets_save(const TagTinkerApp* app) {
    Storage* storage = furi_record_open(RECORD_STORAGE);
    storage_common_mkdir(storage, APP_DATA_PATH(""));

    File* file = storage_file_alloc(storage);
    bool ok = false;

    if(storage_file_open(file, APP_DATA_PATH("targets.txt"), FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        ok = true;
        for(uint8_t i = 0; i < app->target_count; i++) {
            char line[64];
            int len = snprintf(
                line,
                sizeof(line),
                "%s|%s\n",
                app->targets[i].barcode,
                app->targets[i].name);

            if(len <= 0 || !storage_file_write(file, line, (uint16_t)len)) {
                ok = false;
                break;
            }
        }

        storage_file_close(file);
    }

    storage_file_free(file);
    furi_record_close(RECORD_STORAGE);
    return ok;
}

static TagTinkerApp* app_alloc(void) {
    TagTinkerApp* app = malloc(sizeof(TagTinkerApp));
    memset(app, 0, sizeof(TagTinkerApp));

    /* Defaults */
    app->page = 0;
    app->duration = 15;
    app->repeats = 200;
    app->draw_width = 48;
    app->draw_height = 48;
    app->img_page = 1;
    app->esl_width = 200;
    app->esl_height = 80;
    app->color_clear = false;
    app->invert_text = false;
    strcpy(app->text_input_buf, "TagTinker");
    app->selected_target = -1;
    tagtinker_settings_load(app);
    tagtinker_targets_load(app);

    /* Scene manager */
    app->scene_manager = scene_manager_alloc(&tagtinker_scene_handlers, app);

    /* View dispatcher */
    app->view_dispatcher = view_dispatcher_alloc();
    view_dispatcher_set_event_callback_context(app->view_dispatcher, app);
    view_dispatcher_set_navigation_event_callback(app->view_dispatcher, navigation_cb);
    view_dispatcher_set_tick_event_callback(app->view_dispatcher, tick_cb, 50);
    view_dispatcher_set_custom_event_callback(app->view_dispatcher, custom_event_cb);

    /* GUI */
    app->gui = furi_record_open(RECORD_GUI);
    view_dispatcher_attach_to_gui(app->view_dispatcher, app->gui, ViewDispatcherTypeFullscreen);

    /* Notifications */
    app->notifications = furi_record_open(RECORD_NOTIFICATION);

    /* Views */
    app->submenu = submenu_alloc();
    view_dispatcher_add_view(
        app->view_dispatcher, TagTinkerViewSubmenu, submenu_get_view(app->submenu));

    app->var_item_list = variable_item_list_alloc();
    view_dispatcher_add_view(
        app->view_dispatcher, TagTinkerViewVarItemList,
        variable_item_list_get_view(app->var_item_list));

    app->text_input = text_input_alloc();
    view_dispatcher_add_view(
        app->view_dispatcher, TagTinkerViewTextInput, text_input_get_view(app->text_input));

    app->popup = popup_alloc();
    view_dispatcher_add_view(
        app->view_dispatcher, TagTinkerViewPopup, popup_get_view(app->popup));

    app->widget = widget_alloc();
    view_dispatcher_add_view(
        app->view_dispatcher, TagTinkerViewWidget, widget_get_view(app->widget));

    app->numlock = numlock_input_alloc();
    view_dispatcher_add_view(
        app->view_dispatcher, TagTinkerViewNumlock, numlock_input_get_view(app->numlock));

    app->transmit_view = view_alloc();
    view_dispatcher_add_view(
        app->view_dispatcher, TagTinkerViewTransmit, app->transmit_view);

    app->about_view = view_alloc();
    view_dispatcher_add_view(
        app->view_dispatcher, TagTinkerViewAbout, app->about_view);

    app->dialogs = furi_record_open(RECORD_DIALOGS);

    /* Allocate Thread and Timer for animations and TX */
    app->tx_thread = furi_thread_alloc();
    furi_thread_set_name(app->tx_thread, "TagTinkerTx");
    furi_thread_set_stack_size(app->tx_thread, 2048);
    furi_thread_set_priority(app->tx_thread, FuriThreadPriorityHighest);
    furi_thread_set_context(app->tx_thread, app);

    return app;
}

static void app_free(TagTinkerApp* app) {
    tagtinker_ir_deinit();

    if(app->frame_sequence) {
        for(size_t i = 0; i < app->frame_seq_count; i++)
            free(app->frame_sequence[i]);
        free(app->frame_sequence);
        free(app->frame_lengths);
        free(app->frame_repeats);
    }

    view_dispatcher_remove_view(app->view_dispatcher, TagTinkerViewSubmenu);
    view_dispatcher_remove_view(app->view_dispatcher, TagTinkerViewVarItemList);
    view_dispatcher_remove_view(app->view_dispatcher, TagTinkerViewTextInput);
    view_dispatcher_remove_view(app->view_dispatcher, TagTinkerViewPopup);
    view_dispatcher_remove_view(app->view_dispatcher, TagTinkerViewWidget);
    view_dispatcher_remove_view(app->view_dispatcher, TagTinkerViewNumlock);
    view_dispatcher_remove_view(app->view_dispatcher, TagTinkerViewTransmit);
    view_dispatcher_remove_view(app->view_dispatcher, TagTinkerViewAbout);

    submenu_free(app->submenu);
    variable_item_list_free(app->var_item_list);
    text_input_free(app->text_input);
    popup_free(app->popup);
    widget_free(app->widget);
    numlock_input_free(app->numlock);

    view_dispatcher_free(app->view_dispatcher);
    scene_manager_free(app->scene_manager);

    furi_record_close(RECORD_GUI);
    furi_record_close(RECORD_NOTIFICATION);
    furi_record_close(RECORD_DIALOGS);

    view_free(app->transmit_view);
    view_free(app->about_view);
    furi_thread_free(app->tx_thread);

    free(app);
}

int32_t tagtinker_app_main(void* p) {
    UNUSED(p);
    TagTinkerApp* app = app_alloc();
    scene_manager_next_scene(
        app->scene_manager,
        app->show_startup_warning ? TagTinkerSceneWarning : TagTinkerSceneMainMenu);
    view_dispatcher_run(app->view_dispatcher);
    app_free(app);
    return 0;
}

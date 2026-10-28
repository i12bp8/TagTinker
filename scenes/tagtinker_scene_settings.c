/*
 * Settings scene
 */

#include "../tagtinker_app.h"

enum {
    SettingsItemStartupWarning,
    SettingsItemFrameRepeat,
    SettingsItemIrOutput,
    SettingsItemIr5v,
    SettingsItemClearRecents,
};

static const char* settings_toggle_labels[] = {"Off", "On"};

/* Same choices as the stock Infrared app: built-in LED, an external module
 * on GPIO pin 2 (A7), or detect the module when sending. */
static const char* ir_output_labels[TagTinkerIrOutputSettingCount] = {"Internal", "GPIO A7", "Auto"};

static void startup_warning_changed(VariableItem* item) {
    TagTinkerApp* app = variable_item_get_context(item);
    uint8_t index = variable_item_get_current_value_index(item);

    app->show_startup_warning = (index == 1);
    variable_item_set_current_value_text(item, settings_toggle_labels[index]);

    tagtinker_settings_save(app);
}

static void frame_repeat_changed(VariableItem* item) {
    TagTinkerApp* app = variable_item_get_context(item);
    uint8_t index = variable_item_get_current_value_index(item);

    app->data_frame_repeats = index + 1U;

    char buf[4];
    snprintf(buf, sizeof(buf), "%u", app->data_frame_repeats);
    variable_item_set_current_value_text(item, buf);

    tagtinker_settings_save(app);
}

static void ir_output_changed(VariableItem* item) {
    TagTinkerApp* app = variable_item_get_context(item);
    uint8_t index = variable_item_get_current_value_index(item);

    app->ir_output_setting = index;
    variable_item_set_current_value_text(item, ir_output_labels[index]);

    tagtinker_settings_save(app);
}

static void ir_5v_changed(VariableItem* item) {
    TagTinkerApp* app = variable_item_get_context(item);
    uint8_t index = variable_item_get_current_value_index(item);

    app->ir_5v = (index == 1);
    variable_item_set_current_value_text(item, settings_toggle_labels[index]);

    tagtinker_settings_save(app);
}

static void clear_recents_cb(VariableItem* item) {
    TagTinkerApp* app = variable_item_get_context(item);
    app->recent_count = 0;
    tagtinker_recents_save(app);
    variable_item_set_current_value_text(item, "Cleared!");
}

void tagtinker_scene_settings_on_enter(void* ctx) {
    TagTinkerApp* app = ctx;
    VariableItemList* list = app->var_item_list;

    variable_item_list_reset(list);

    VariableItem* item = variable_item_list_add(
        list, "Startup Warning", 2, startup_warning_changed, app);
    variable_item_set_current_value_index(item, app->show_startup_warning ? 1 : 0);
    variable_item_set_current_value_text(
        item, settings_toggle_labels[app->show_startup_warning ? 1 : 0]);

    item = variable_item_list_add(list, "Frame Repeat", 10, frame_repeat_changed, app);
    variable_item_set_current_value_index(item, app->data_frame_repeats - 1U);
    {
        char buf[4];
        snprintf(buf, sizeof(buf), "%u", app->data_frame_repeats);
        variable_item_set_current_value_text(item, buf);
    }

    item = variable_item_list_add(
        list, "IR Output", TagTinkerIrOutputSettingCount, ir_output_changed, app);
    variable_item_set_current_value_index(item, app->ir_output_setting);
    variable_item_set_current_value_text(item, ir_output_labels[app->ir_output_setting]);

    /* 5V on GPIO pin 1 for modules powered from it. Auto turns it on by
     * itself when a module is detected, like the stock Infrared app. */
    item = variable_item_list_add(list, "5V on GPIO", 2, ir_5v_changed, app);
    variable_item_set_current_value_index(item, app->ir_5v ? 1 : 0);
    variable_item_set_current_value_text(item, settings_toggle_labels[app->ir_5v ? 1 : 0]);

    item = variable_item_list_add(list, "Clear Recents", 0, clear_recents_cb, app);
    variable_item_set_current_value_text(item, "");

    variable_item_list_set_selected_item(list, SettingsItemStartupWarning);
    view_dispatcher_switch_to_view(app->view_dispatcher, TagTinkerViewVarItemList);
}

bool tagtinker_scene_settings_on_event(void* ctx, SceneManagerEvent event) {
    UNUSED(ctx);
    UNUSED(event);
    return false;
}

void tagtinker_scene_settings_on_exit(void* ctx) {
    TagTinkerApp* app = ctx;
    variable_item_list_reset(app->var_item_list);
}

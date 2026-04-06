/*
 * Settings scene
 */

#include "../tagtinker_app.h"

enum {
    SettingsItemStartupWarning,
};

static const char* settings_toggle_labels[] = {"Off", "On"};

static void startup_warning_changed(VariableItem* item) {
    TagTinkerApp* app = variable_item_get_context(item);
    uint8_t index = variable_item_get_current_value_index(item);

    app->show_startup_warning = (index == 1);
    variable_item_set_current_value_text(item, settings_toggle_labels[index]);

    if(!tagtinker_settings_save(app)) {
        FURI_LOG_W(TAGTINKER_TAG, "Failed to save settings");
    }
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

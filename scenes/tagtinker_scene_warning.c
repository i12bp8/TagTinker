/*
 * Startup warning scene
 */

#include "../tagtinker_app.h"

enum {
    TagTinkerStartupWarningContinue,
};

static const char* startup_warning_text =
    "\ec\e#TagTinker - Research Tool\n"
    "\n"
    "This is an educational research tool for infrared electronic shelf label "
    "(ESL) protocols.\n"
    "It implements publicly documented signaling for tags commonly used in "
    "retail (often referred to as Pricer-style ESLs).\n"
    "Use ONLY on tags you personally own or have explicit permission to test.\n"
    "Using this tool on retail store systems without authorization may violate "
    "laws on fraud or interference with business operations. You are solely "
    "responsible for your actions. Misuse is not endorsed.\n"
    "\n"
    "\ecPress OK to continue.";

static void startup_warning_button_cb(GuiButtonType result, InputType type, void* context) {
    if(type != InputTypeShort || result != GuiButtonTypeCenter) return;

    TagTinkerApp* app = context;
    view_dispatcher_send_custom_event(
        app->view_dispatcher, TagTinkerStartupWarningContinue);
}

void tagtinker_scene_warning_on_enter(void* ctx) {
    TagTinkerApp* app = ctx;

    widget_reset(app->widget);
    widget_add_text_scroll_element(app->widget, 0, 0, 128, 52, startup_warning_text);
    widget_add_button_element(
        app->widget, GuiButtonTypeCenter, "OK", startup_warning_button_cb, app);

    view_dispatcher_switch_to_view(app->view_dispatcher, TagTinkerViewWidget);
}

bool tagtinker_scene_warning_on_event(void* ctx, SceneManagerEvent event) {
    TagTinkerApp* app = ctx;

    if(event.type == SceneManagerEventTypeCustom &&
       event.event == TagTinkerStartupWarningContinue) {
        scene_manager_search_and_switch_to_another_scene(
            app->scene_manager, TagTinkerSceneMainMenu);
        return true;
    }

    return false;
}

void tagtinker_scene_warning_on_exit(void* ctx) {
    TagTinkerApp* app = ctx;
    widget_reset(app->widget);
}

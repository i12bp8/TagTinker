/*
 * USB serial control (issue #21).
 *
 * While TagTinker is open it adds a "tagtinker" command to the Flipper CLI
 * (qFlipper CLI, `ufbt cli`, or any serial terminal on the Flipper's USB
 * port). Sends reuse the normal transmit scene, so the Flipper screen shows
 * what is going on and Back still cancels.
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct TagTinkerApp TagTinkerApp;

/* View dispatcher custom events. Far above the scene event ids. */
#define TAGTINKER_CLI_EVENT_RUN  0x54540001UL
#define TAGTINKER_CLI_EVENT_STOP 0x54540002UL

/* Register the CLI command. Call once the view dispatcher exists. */
void tagtinker_cli_register(TagTinkerApp* app);

/* Remove the command and wait for a running one to return. Call before the
 * views and the view dispatcher are freed. */
void tagtinker_cli_unregister(TagTinkerApp* app);

/* GUI thread: handle TAGTINKER_CLI_EVENT_*. Returns false for other events. */
bool tagtinker_cli_handle_custom_event(TagTinkerApp* app, uint32_t event);

/* GUI thread: the transmit scene finished (or was left) - report to the CLI
 * command waiting for it, if any. */
void tagtinker_cli_tx_finished(TagTinkerApp* app, bool ok);

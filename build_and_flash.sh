#!/usr/bin/env bash
# Linux/macOS helper: build the FAP with ufbt and install it on a USB-connected Flipper (close qFlipper first)
set -euo pipefail
cd "$(dirname "$0")"

if [ -x .venv/bin/ufbt ]; then
    UFBT=(.venv/bin/ufbt)
elif command -v ufbt >/dev/null 2>&1; then
    UFBT=(ufbt)
elif python3 -c 'import ufbt' >/dev/null 2>&1; then
    UFBT=(python3 -m ufbt)
else
    echo "ufbt not found. Install it with: python3 -m pip install --upgrade ufbt (or run: make setup)" >&2
    exit 1
fi

fail() {
    echo
    echo "FAILED - see the messages above." >&2
    exit 1
}

echo "=== ufbt update (SDK release) ==="
"${UFBT[@]}" update || echo "(update failed, building with the SDK already installed)"
echo "=== build ==="
"${UFBT[@]}" || fail
echo "=== launch on the Flipper ==="
"${UFBT[@]}" launch || fail
echo
echo "OK: app installed and launched."

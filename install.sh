#!/bin/bash
set -e

# Install script for Open Claude in Chrome extension.
# Registers the native messaging host for Chrome, Edge, Brave and Firefox on
# macOS, Linux, and Windows (run under Git Bash / MSYS2 / Cygwin).
#
# Usage: ./install.sh [extension-id] [extension-id-2] ...
#
# Chromium browsers: pass one extension ID per browser. Each Chromium browser
# assigns a different ID when loading unpacked extensions, so if you use both
# Chrome and Brave, pass both IDs.
#
# Firefox: needs no ID. The extension has a fixed ID (FIREFOX_EXTENSION_ID,
# from extension/manifest.json) and the host is registered for any Firefox
# found. Run with no arguments to register Firefox only.

if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  echo "Usage: ./install.sh [extension-id] [extension-id-2] ..."
  echo ""
  echo "Chromium (Chrome, Brave, Edge, Chromium): pass one extension ID per browser."
  echo "  1. Open chrome://extensions (and/or brave://extensions)"
  echo "  2. Enable Developer Mode"
  echo "  3. Click 'Load unpacked' and select the extension/ directory"
  echo "  4. Copy the extension ID shown under the extension name"
  echo "  5. Repeat for each browser"
  echo "  6. Run: ./install.sh <chrome-id> <brave-id>"
  echo ""
  echo "Firefox: no ID needed. Install the signed build (README: Installing on"
  echo "Firefox), then run ./install.sh (with or without Chromium IDs)."
  exit 0
fi

EXTENSION_IDS=("$@")
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$SCRIPT_DIR/host"
HOST_NAME="com.anthropic.open_claude_in_chrome"
# Must match browser_specific_settings.gecko.id in extension/manifest.json.
FIREFOX_EXTENSION_ID="open-claude-in-chrome@hrideshmg.com"

# Platform detection. Windows is reached when the script runs under Git Bash,
# MSYS2, or Cygwin (uname reports MINGW*/MSYS*/CYGWIN*).
case "$(uname)" in
  Darwin) OS_KIND="mac" ;;
  Linux) OS_KIND="linux" ;;
  MINGW*|MSYS*|CYGWIN*) OS_KIND="windows" ;;
  *) OS_KIND="unknown" ;;
esac

# Verify node is available
if ! command -v node &> /dev/null; then
  echo "Error: node is not installed. Install Node.js first."
  exit 1
fi

# Verify npm dependencies are installed
if [ ! -d "$HOST_DIR/node_modules" ]; then
  echo "Installing npm dependencies..."
  cd "$HOST_DIR" && npm install
  cd "$SCRIPT_DIR"
fi

# The codemode/hybrid servers bundle a Cloudflare Worker (execute_code) that
# imports @cloudflare/codemode; wrangler's build fails if the worker's own
# dependencies aren't installed. Install them here so execute_code works.
WORKER_DIR="$HOST_DIR/codemode/worker"
if [ -f "$WORKER_DIR/package.json" ] && [ ! -d "$WORKER_DIR/node_modules" ]; then
  echo "Installing codemode worker dependencies..."
  cd "$WORKER_DIR" && npm install
  cd "$SCRIPT_DIR"
fi

# Build allowed_origins array from all extension IDs
ORIGINS=""
for i in "${!EXTENSION_IDS[@]}"; do
  if [ $i -gt 0 ]; then ORIGINS="$ORIGINS,"; fi
  ORIGINS="$ORIGINS
    \"chrome-extension://${EXTENSION_IDS[$i]}/\""
done

# JSON-escape backslashes so a Windows path can be embedded in the manifest
# (POSIX paths contain none, so this is a no-op on macOS/Linux).
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g'; }

# Native messaging host manifest. $1 = the host executable path, already
# JSON-escaped for the current platform.
generate_manifest() {
  cat << EOF
{
  "name": "$HOST_NAME",
  "description": "Open Claude in Chrome Native Messaging Host",
  "path": "$1",
  "type": "stdio",
  "allowed_origins": [$ORIGINS
  ]
}
EOF
}

# Firefox's host manifest differs from Chromium's: allowed_extensions (add-on
# IDs) instead of allowed_origins.
generate_firefox_manifest() {
  cat << EOF
{
  "name": "$HOST_NAME",
  "description": "Open Claude in Chrome Native Messaging Host",
  "path": "$1",
  "type": "stdio",
  "allowed_extensions": ["$FIREFOX_EXTENSION_ID"]
}
EOF
}

# ---------------------------------------------------------------------------
# macOS / Linux: a POSIX wrapper script + one manifest file per browser, in
# that browser's NativeMessagingHosts directory.
# ---------------------------------------------------------------------------
create_unix_wrapper() {
  NATIVE_HOST_PATH="$HOST_DIR/native-host-wrapper.sh"
  cat > "$NATIVE_HOST_PATH" << WRAPPER
#!/bin/sh
exec "$(command -v node)" "$HOST_DIR/native-host.js"
WRAPPER
  chmod +x "$NATIVE_HOST_PATH"
  echo "Created native host wrapper: $NATIVE_HOST_PATH"
}

install_host() {
  local browser_name="$1"
  local host_dir="$2"
  local kind="${3:-chromium}"

  # Chromium manifests need at least one extension ID to allow.
  if [ "$kind" = "chromium" ] && [ ${#EXTENSION_IDS[@]} -eq 0 ]; then
    return
  fi

  if [ ! -d "$(dirname "$host_dir")" ]; then
    echo "  Skipping $browser_name (not installed)"
    return
  fi

  mkdir -p "$host_dir"
  if [ "$kind" = "firefox" ]; then
    generate_firefox_manifest "$(json_escape "$NATIVE_HOST_PATH")" > "$host_dir/$HOST_NAME.json"
  else
    generate_manifest "$(json_escape "$NATIVE_HOST_PATH")" > "$host_dir/$HOST_NAME.json"
  fi
  echo "  Installed for $browser_name: $host_dir/$HOST_NAME.json"
}

# ---------------------------------------------------------------------------
# Windows: Chromium browsers locate a native host through a registry value
# under HKCU\Software\<vendor>\NativeMessagingHosts\<name> that points at the
# manifest JSON; the manifest in turn points at an executable the browser can
# launch — a .bat, not a shell script. HKCU keeps this per-user (no admin).
# ---------------------------------------------------------------------------
install_windows() {
  local node_posix node_win host_js_win bat_path bat_win manifest_path

  node_posix="$(command -v node)"
  # Git Bash reports node without the .exe suffix; add it back so the wrapper
  # resolves even when Chrome launches it with a minimal PATH.
  if [ -f "${node_posix}.exe" ]; then node_posix="${node_posix}.exe"; fi
  node_win="$(cygpath -w "$node_posix")"
  host_js_win="$(cygpath -w "$HOST_DIR/native-host.js")"

  # The .bat Chrome launches. CRLF endings; %* forwards Chrome's args (the
  # extension origin + parent-window handle, which the host ignores). cmd.exe
  # hands node the inherited std handles, so Chrome's binary native-messaging
  # stream flows straight to/from node — cmd never sits in the pipe.
  bat_path="$HOST_DIR/native-host-wrapper.bat"
  printf '@echo off\r\n"%s" "%s" %%*\r\n' "$node_win" "$host_js_win" > "$bat_path"
  echo "Created native host wrapper: $bat_path"

  bat_win="$(cygpath -w "$bat_path")"

  echo ""
  echo "Registering native messaging host in the registry (HKCU)..."

  # One Chromium manifest, referenced by every Chromium browser's registry key.
  if [ ${#EXTENSION_IDS[@]} -gt 0 ]; then
    manifest_path="$HOST_DIR/$HOST_NAME.json"
    generate_manifest "$(json_escape "$bat_win")" > "$manifest_path"
    MANIFEST_WIN="$(cygpath -w "$manifest_path")"
    echo "Wrote manifest: $manifest_path"
    win_reg_add "Google Chrome" 'HKCU\Software\Google\Chrome\NativeMessagingHosts'
    win_reg_add "Microsoft Edge" 'HKCU\Software\Microsoft\Edge\NativeMessagingHosts'
    win_reg_add "Brave" 'HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
  fi

  # Firefox reads allowed_extensions, so it gets its own manifest.
  manifest_path="$HOST_DIR/$HOST_NAME.firefox.json"
  generate_firefox_manifest "$(json_escape "$bat_win")" > "$manifest_path"
  MANIFEST_WIN="$(cygpath -w "$manifest_path")"
  echo "Wrote manifest: $manifest_path"
  win_reg_add "Firefox" 'HKCU\Software\Mozilla\NativeMessagingHosts'
}

# Point one browser's registry hive at the manifest. The // on reg's switches
# is the Git-Bash convention that survives MSYS argument munging (// -> /);
# the C:\ manifest path and the HKCU\... key are Windows-form already, so MSYS
# leaves them untouched.
win_reg_add() {
  local browser="$1" hive="$2"
  if reg.exe add "$hive\\$HOST_NAME" //ve //t REG_SZ //d "$MANIFEST_WIN" //f >/dev/null 2>&1; then
    echo "  Registered for $browser"
  else
    echo "  Could not register for $browser"
  fi
}

echo ""
if [ ${#EXTENSION_IDS[@]} -gt 0 ]; then
  echo "Installing native messaging host for Chromium extension(s): ${EXTENSION_IDS[*]}"
else
  echo "No Chromium extension ID given: registering Firefox only."
fi
echo "Firefox extension ID: $FIREFOX_EXTENSION_ID"
echo ""

case "$OS_KIND" in
  mac)
    create_unix_wrapper
    install_host "Google Chrome" \
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    install_host "Microsoft Edge" \
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    install_host "Brave Browser" \
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    install_host "Firefox" \
      "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" firefox
    ;;
  linux)
    create_unix_wrapper
    install_host "Google Chrome" \
      "$HOME/.config/google-chrome/NativeMessagingHosts"
    install_host "Microsoft Edge" \
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    install_host "Brave Browser" \
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    install_host "Chromium" \
      "$HOME/.config/chromium/NativeMessagingHosts"
    # Flatpak browsers are sandboxed: they never read ~/.config, only their
    # own per-app tree, where Flatpak maps ~/.config -> ~/.var/app/<id>/config.
    # install_host skips any browser whose directory isn't there, so these are
    # a no-op on a machine with no Flatpak browser installed.
    install_host "Brave Browser (Flatpak)" \
      "$HOME/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    install_host "Google Chrome (Flatpak)" \
      "$HOME/.var/app/com.google.Chrome/config/google-chrome/NativeMessagingHosts"
    install_host "Microsoft Edge (Flatpak)" \
      "$HOME/.var/app/com.microsoft.Edge/config/microsoft-edge/NativeMessagingHosts"
    install_host "Chromium (Flatpak)" \
      "$HOME/.var/app/org.chromium.Chromium/config/chromium/NativeMessagingHosts"
    install_host "Firefox" \
      "$HOME/.mozilla/native-messaging-hosts" firefox
    install_host "Firefox (Flatpak)" \
      "$HOME/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts" firefox
    # Registering the manifest is necessary but not always sufficient under
    # Flatpak: the sandbox must also be allowed to launch the host wrapper,
    # which lives outside it. Only mention this when a Flatpak browser exists.
    if [ -d "$HOME/.var/app/com.brave.Browser" ] \
      || [ -d "$HOME/.var/app/com.google.Chrome" ] \
      || [ -d "$HOME/.var/app/com.microsoft.Edge" ] \
      || [ -d "$HOME/.var/app/org.chromium.Chromium" ]; then
      echo ""
      echo "  Note: a Flatpak browser was detected. Flatpak sandboxes the browser,"
      echo "  so it also needs permission to run the native host from your home dir:"
      echo "    flatpak override --user --filesystem=home <app-id>"
      echo "  (e.g. com.brave.Browser), then fully restart the browser."
    fi
    ;;
  windows)
    install_windows
    ;;
  *)
    echo "Error: Unsupported platform $(uname)."
    echo "This script supports macOS, Linux, and Windows (via Git Bash/MSYS2/Cygwin)."
    exit 1
    ;;
esac

# Path to mcp-server.js shown in the copy-paste hint, in the current OS's
# native form (cygpath yields a clean C:\...\host\mcp-server.js on Windows).
if [ "$OS_KIND" = "windows" ]; then
  MCP_SERVER_DISPLAY="$(cygpath -w "$HOST_DIR/mcp-server.js")"
else
  MCP_SERVER_DISPLAY="$HOST_DIR/mcp-server.js"
fi

echo ""
echo "Done! Next steps:"
echo ""
echo "  1. Restart your browser (close all windows and reopen)"
echo "  2. Add the MCP server to Claude Code:"
echo ""
echo "     claude mcp add open-claude-in-chrome -- node \"$MCP_SERVER_DISPLAY\""
echo ""
echo "  3. Start a new Claude Code session and test:"
echo ""
echo '     Ask Claude: "Navigate to reddit.com and take a screenshot"'
echo ""

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/helper/apple-messages-helper.swift"
APP_NAME="${APPLE_MESSAGES_MCP_HOST_APP_NAME:-Apple Messages MCP Host}"
BUNDLE_ID="${APPLE_MESSAGES_MCP_HOST_BUNDLE_ID:-com.motionsmith.apple-messages-mcp.host}"
APP_DIR="${APPLE_MESSAGES_MCP_HOST_APP_DIR:-$ROOT/bin/$APP_NAME.app}"
EXECUTABLE="$APP_DIR/Contents/MacOS/apple-messages-helper"
PLIST="$APP_DIR/Contents/Info.plist"
TEMPLATE="$ROOT/scripts/apple-messages-helper.Info.plist"

if [ "$(uname -s)" != "Darwin" ]; then
  echo 'Apple Messages helper compilation requires macOS.' >&2
  exit 1
fi

mkdir -p "$(dirname "$EXECUTABLE")"
swiftc -framework Contacts "$SOURCE" -o "$EXECUTABLE"
chmod +x "$EXECUTABLE"
sed \
  -e "s/com.motionsmith.apple-messages-mcp.host/$BUNDLE_ID/g" \
  -e "s/Apple Messages MCP Host/$APP_NAME/g" \
  "$TEMPLATE" > "$PLIST"
codesign --force --sign "${APPLE_MESSAGES_MCP_CODESIGN_IDENTITY:--}" "$EXECUTABLE"
codesign --force --sign "${APPLE_MESSAGES_MCP_CODESIGN_IDENTITY:--}" "$APP_DIR"
printf 'Built %s\n' "$APP_DIR"

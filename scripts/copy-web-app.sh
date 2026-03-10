#!/bin/bash
# Copy web-application/ from retold-remote into this project's web-app/ directory.
# The bridge script (retold-native-bridge.js/css) and modified index.html are NOT
# overwritten if they already exist — only retold-remote's assets are synced.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RETOLD_REMOTE_DIR="$(dirname "$PROJECT_DIR")/retold-remote"
WEB_APP_DIR="$PROJECT_DIR/web-app"

if [ ! -d "$RETOLD_REMOTE_DIR/web-application" ]; then
	echo "Error: retold-remote web-application/ not found at $RETOLD_REMOTE_DIR/web-application"
	echo "Make sure retold-remote is built first (cd retold-remote && npm run build)"
	exit 1
fi

echo "Copying retold-remote web assets..."

# Copy JS bundles
cp "$RETOLD_REMOTE_DIR/web-application/retold-remote.js" "$WEB_APP_DIR/"
cp "$RETOLD_REMOTE_DIR/web-application/retold-remote.min.js" "$WEB_APP_DIR/"
cp "$RETOLD_REMOTE_DIR/web-application/retold-remote.js.map" "$WEB_APP_DIR/" 2>/dev/null
cp "$RETOLD_REMOTE_DIR/web-application/retold-remote.min.js.map" "$WEB_APP_DIR/" 2>/dev/null

# Copy codejar
cp "$RETOLD_REMOTE_DIR/web-application/codejar.js" "$WEB_APP_DIR/"

# Copy JS libraries
mkdir -p "$WEB_APP_DIR/js"
cp "$RETOLD_REMOTE_DIR/web-application/js/"* "$WEB_APP_DIR/js/"

# Copy CSS
mkdir -p "$WEB_APP_DIR/css"
cp "$RETOLD_REMOTE_DIR/web-application/css/"* "$WEB_APP_DIR/css/"

# Copy docs
mkdir -p "$WEB_APP_DIR/docs"
cp "$RETOLD_REMOTE_DIR/web-application/docs/"* "$WEB_APP_DIR/docs/" 2>/dev/null

# Copy docs.html
cp "$RETOLD_REMOTE_DIR/web-application/docs.html" "$WEB_APP_DIR/" 2>/dev/null

echo "Done. Web assets copied to $WEB_APP_DIR/"
echo "Note: index.html, retold-native-bridge.js, and retold-native-bridge.css are NOT overwritten."

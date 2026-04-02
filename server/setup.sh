#!/usr/bin/env bash
#
# Oppi server setup — install deps, build, and start.
#
# Usage:
#   bash setup.sh              # install + build + start foreground
#   bash setup.sh --install    # install as background service (macOS launchd)
#
set -euo pipefail

cd "$(dirname "$0")"

# Pick runtime: bun > node
if command -v bun &>/dev/null; then
  RT=bun
  echo "Using Bun $(bun --version)"
elif command -v node &>/dev/null; then
  RT=node
  echo "Using Node.js $(node --version)"
else
  echo "Error: Install Bun (https://bun.sh) or Node.js 20+"
  exit 1
fi

# Install + build
echo "Installing dependencies..."
if [[ "$RT" == "bun" ]]; then
  bun install --ignore-scripts
else
  npm install --ignore-scripts
fi

echo "Building..."
"$RT" node_modules/.bin/tsc 2>/dev/null || npx tsc
chmod +x dist/src/cli.js

# Start
if [[ "${1:-}" == "--install" ]]; then
  echo ""
  "$RT" dist/src/cli.js server install
else
  echo ""
  "$RT" dist/src/cli.js serve "$@"
fi

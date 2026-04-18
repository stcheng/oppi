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
  NODE_VERSION="$(node --version)"
  NODE_MAJOR="${NODE_VERSION#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"

  if [[ "$NODE_MAJOR" -lt 22 ]]; then
    echo "Error: Node.js 22+ required (found $NODE_VERSION)."
    echo "Install Node.js 22+ or Bun (https://bun.sh)."
    exit 1
  fi

  RT=node
  echo "Using Node.js $NODE_VERSION"
else
  echo "Error: Install Bun (https://bun.sh) or Node.js 22+"
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

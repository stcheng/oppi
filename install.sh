#!/usr/bin/env bash
#
# Oppi installer (repo-root wrapper + curl-pipe bootstrap)
#
# Supports two modes:
# 1) Run from repo root: delegates to server/setup.sh
# 2) Run via curl|bash: clones/updates repo, then runs server/setup.sh
#
# Usage:
#   bash install.sh            # install deps, build, start foreground
#   bash install.sh --install  # install as macOS LaunchAgent service
#
# Optional env vars (curl|bash mode):
#   OPPI_REPO_URL      (default: https://github.com/duh17/oppi.git)
#   OPPI_REF           (default: main)
#   OPPI_INSTALL_DIR   (default: $HOME/oppi)

set -euo pipefail

log() {
  echo "[oppi-install] $*"
}

die() {
  echo "[oppi-install] Error: $*" >&2
  exit 1
}

run_setup() {
  local root_dir="$1"
  shift
  local setup_script="$root_dir/server/setup.sh"

  [[ -f "$setup_script" ]] || die "missing $setup_script"
  exec bash "$setup_script" "$@"
}

# Local repo mode (script file exists on disk inside repo)
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/server/setup.sh" ]]; then
  run_setup "$SCRIPT_DIR" "$@"
fi

# curl|bash mode (script is not running from repo root)
REPO_URL="${OPPI_REPO_URL:-https://github.com/duh17/oppi.git}"
REPO_REF="${OPPI_REF:-main}"
INSTALL_DIR="${OPPI_INSTALL_DIR:-$HOME/oppi}"

command -v git >/dev/null 2>&1 || die "git is required for bootstrap mode"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "Found existing repo at $INSTALL_DIR"
  log "Updating to ref '$REPO_REF' from $REPO_URL"
  git -C "$INSTALL_DIR" fetch --depth 1 "$REPO_URL" "$REPO_REF"
  git -C "$INSTALL_DIR" checkout -q FETCH_HEAD
elif [[ -e "$INSTALL_DIR" ]]; then
  die "install dir exists and is not a git repo: $INSTALL_DIR (set OPPI_INSTALL_DIR to another path)"
else
  log "Cloning $REPO_URL ($REPO_REF) to $INSTALL_DIR"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
fi

run_setup "$INSTALL_DIR" "$@"

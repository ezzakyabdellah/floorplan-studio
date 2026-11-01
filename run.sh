#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export PATH="$HOME/.cargo/bin:$PATH"
if command -v cygpath >/dev/null 2>&1 && [ -n "${USERPROFILE:-}" ]; then
  export PATH="$(cygpath -u "$USERPROFILE")/.cargo/bin:$PATH"
fi
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required. Install them from https://nodejs.org/." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Cargo was not found. Install Rust from https://rustup.rs/ and try again." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing npm dependencies..."
  npm install
fi

exec npm run tauri dev

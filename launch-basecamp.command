#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Basecamp desktop launcher"
echo "Repo: $SCRIPT_DIR"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting Basecamp desktop app..."
npm run desktop

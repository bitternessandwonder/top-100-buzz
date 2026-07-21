#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js is not installed."
  echo "Install Node.js and run this file again."
  echo
  read -r -p "Press Enter to close..."
  exit 1
fi

(sleep 1; open "http://localhost:3000") &
node server.js

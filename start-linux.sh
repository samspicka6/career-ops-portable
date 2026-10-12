#!/bin/sh
# Start Career-Ops on Linux: installs what it needs on the first run, then
# opens the app in your browser. Needs Node.js 18+ (your package manager or
# https://nodejs.org). Same as `npm start`.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Career-Ops needs Node.js 18 or newer. Install it (https://nodejs.org or your package manager) and run this again."
  exit 1
fi
exec node app/launch.mjs "$@"

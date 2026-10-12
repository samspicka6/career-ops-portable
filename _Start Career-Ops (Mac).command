#!/bin/bash
# Double-click this file in Finder to start Career-Ops.
# It checks for Node.js (and offers to install it), installs what Career-Ops
# needs on the first run, then opens the app in your browser.
# Keep the Terminal window open while you use Career-Ops.

cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

clear
echo "=============================================="
echo "  Career-Ops"
echo "=============================================="
echo

node_ok() {
  command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" -ge 18 ] 2>/dev/null
}

if ! node_ok; then
  echo "Career-Ops needs Node.js (free, from nodejs.org), and this Mac doesn't have it yet."
  echo
  read -r -p "Download and open the Node.js installer now? [Y/n] " answer
  if [[ "$answer" =~ ^[Nn] ]]; then
    echo "OK. Install Node.js from https://nodejs.org, then double-click this file again."
    open "https://nodejs.org/en/download"
    read -r -p "Press Enter to close this window." _
    exit 1
  fi
  echo "Finding the newest Node.js installer..."
  PKG=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk '/\.pkg$/ {print $2; exit}')
  if [ -z "$PKG" ]; then
    echo "Couldn't reach nodejs.org. Opening the download page instead."
    open "https://nodejs.org/en/download"
    read -r -p "Install Node.js, then press Enter to continue. " _
  else
    DEST="$TMPDIR/$PKG"
    echo "Downloading $PKG..."
    if curl -fL --progress-bar "https://nodejs.org/dist/latest-v24.x/$PKG" -o "$DEST"; then
      open "$DEST"
      echo
      echo "The Node.js installer is open. Click through it (Continue, Agree, Install),"
      read -r -p "and when it says the installation was successful, press Enter here. " _
    else
      open "https://nodejs.org/en/download"
      read -r -p "Download failed. Install Node.js from the page that opened, then press Enter. " _
    fi
  fi
  export PATH="/usr/local/bin:$PATH"
  if ! node_ok; then
    echo
    echo "Node.js still isn't available. Close this window and double-click this file again."
    read -r -p "Press Enter to close this window." _
    exit 1
  fi
fi

node app/launch.mjs
status=$?
if [ $status -ne 0 ]; then
  echo
  read -r -p "Career-Ops stopped with a problem (see above). Press Enter to close this window." _
fi
exit $status

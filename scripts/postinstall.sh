#!/bin/sh
# node-pty's prebuilt spawn-helper can be extracted without the exec bit
# (seen with darwin-x64), which makes every pty.spawn fail with posix_spawnp.
# npm runs this from the repo root; guard the glob so a missing path is not
# an error (Linux/Windows layouts differ).
for helper in node_modules/node-pty/prebuilds/*/spawn-helper; do
  if [ -f "$helper" ]; then
    chmod +x "$helper"
  fi
done

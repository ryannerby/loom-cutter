#!/bin/bash
# Double-click in Finder to launch Loom Cutter. Opens in Terminal because
# macOS won't let the .app launcher exec scripts on an external volume
# without Full Disk Access granted explicitly.

cd "$(dirname "$0")"
exec ./scripts/start.sh --prod

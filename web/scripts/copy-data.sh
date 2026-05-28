#!/usr/bin/env bash
set -euo pipefail

SRC="$(cd "$(dirname "$0")/../.." && pwd)/data/json"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/data"
mkdir -p "$DEST"

for f in categories tools rankings rankings_sub tool_rankings prompts \
         prompts_detail prompt_top_tools matches matches_featured models \
         tools_detail; do
  cp "$SRC/$f.json" "$DEST/$f.json"
done

echo "Copied data → public/data/"

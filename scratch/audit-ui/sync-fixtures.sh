#!/bin/bash
# Copy the audits the extension has checkpointed to disk into the dev harness.
set -e
SRC="$HOME/.config/open-claude-in-chrome/audits"
DEST="$(cd "$(dirname "$0")" && pwd)/fixtures"
mkdir -p "$DEST"
rm -f "$DEST"/*.json
if [ ! -d "$SRC" ]; then echo '{"files":[]}' > "$DEST/index.json"; echo "no audits yet at $SRC"; exit 0; fi
files=()
for d in "$SRC"/*/; do
  id="$(basename "$d")"
  [ -f "$d/audit.json" ] || continue
  cp "$d/audit.json" "$DEST/$id.json"
  files+=("\"$id.json\"")
done
printf '{"files":[%s]}' "$(IFS=,; echo "${files[*]}")" > "$DEST/index.json"
echo "synced ${#files[@]} audit(s) into $DEST"

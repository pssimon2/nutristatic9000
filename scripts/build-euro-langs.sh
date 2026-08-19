#!/bin/bash
# Build + deploy additional Latin-script Wikipedia indexes:
#   fi Finnish, no Norwegian (Bokmål), da Danish, eo Esperanto, ro Romanian,
#   hu Hungarian, sk Slovak, hr Croatian, sl Slovenian.
# For each: download the latest pages-articles dump, build the index via
# build-wiki-par.sh (diacritic fold), build the .idxz sidecar, upload the
# index + sidecar to the deploy target, then delete the dump/intermediates.
# Meant to run detached; logs to data/euro-langs.log.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/data"
MAIN_LOG=euro-langs.log
log() { echo "$(date '+%F %T') $*" >> "$MAIN_LOG"; }
FILTER="sed -f $ROOT/tools/latin-fold.sed"
DEPLOY="${NUTRISTATIC_DEPLOY:?set NUTRISTATIC_DEPLOY to an rsync destination, user@host:/path}"
WORKERS="${WORKERS:-16}"

LANGS="${LANGS:-fi no da eo ro hu sk hr sl}"
log "=== euro-langs build started: $LANGS -> $DEPLOY ==="

for lang in $LANGS; do
  dump="${lang}wiki.xml.bz2"
  out="${lang}wiki-merged.index"
  url="https://dumps.wikimedia.org/${lang}wiki/latest/${lang}wiki-latest-pages-articles.xml.bz2"

  if [ ! -s "$out" ]; then
    log "$lang: downloading dump"
    if ! curl -fsSL --retry 5 --retry-delay 10 -C - -o "$dump" "$url" 2>>"$MAIN_LOG"; then
      log "ERROR: $lang download failed"; continue
    fi
    log "$lang: dump $(du -h "$dump" | cut -f1); building ($WORKERS workers)"
    rm -f "${lang}wiki-p"*.index "${lang}wiki-s1-"*.index 2>/dev/null
    if ! NAME="${lang}wiki" LOG="${lang}wiki-build.log" WORKERS="$WORKERS" NICE='nice -n 5' \
         DATA_DIR="$ROOT/data" \
         bash "$ROOT/scripts/build-wiki-par.sh" "${lang}wiki" "$dump" "$out" "$FILTER"; then
      log "ERROR: $lang build failed (see ${lang}wiki-build.log)"; continue
    fi
  fi

  log "$lang: index $(du -h "$out" | cut -f1); compressing sidecar"
  if ! npx tsx "$ROOT/cli/compress-index.ts" "$out" 2>>"$MAIN_LOG"; then
    log "ERROR: $lang sidecar failed"; continue
  fi

  sz=$(stat -c%s "$out")
  if rsync -a --partial --inplace "$out" "$DEPLOY/${lang}-wiki.index" &&
     rsync -a --partial --inplace "$out.idxz" "$DEPLOY/${lang}-wiki.index.idxz"; then
    log "SUCCESS: $lang uploaded (index $sz bytes + $(du -h "$out.idxz" | cut -f1) sidecar)"
  else
    log "ERROR: $lang upload failed"; continue
  fi

  # Reclaim disk: keep the index + sidecar, drop the dump and intermediates.
  rm -f "$dump" "${lang}wiki-p"*.index "${lang}wiki-s1-"*.index 2>/dev/null
done
log "=== euro-langs ALL DONE ==="

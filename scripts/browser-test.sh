#!/bin/sh
# Run the browser suite against the built site, served at the /9000/ path it is
# deployed under. Starts the server, waits for it, and always takes it down —
# running the two by hand leaks a server per run.
#
# usage: sh scripts/browser-test.sh   (after `npm run build`)
set -e
PORT=${PORT:-4517}
BASE="http://localhost:$PORT/9000/"

if [ ! -f web/dist/index.html ]; then
  echo "web/dist is empty — run 'npm run build' first" >&2
  exit 2
fi

node scripts/serve-subpath.mjs web/dist /9000/ "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT INT TERM

i=0
while [ $i -lt 50 ]; do
  if curl -sf -o /dev/null "$BASE"; then break; fi
  i=$((i + 1))
  sleep 0.2
done

node scripts/browser-test.mjs "$BASE"

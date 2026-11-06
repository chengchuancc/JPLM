#!/bin/sh
set -eu
PLM_APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PLM_APP_DIR"
if [ ! -f dist/index.html ]; then
  echo '请先执行 npm ci && npm run build，或使用已包含 dist 的部署包。' >&2
  exit 1
fi
exec python3 server/app.py "$@"

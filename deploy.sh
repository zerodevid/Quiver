#!/bin/zsh
# Build the UI (React + HeroUI), then ship it to the Singapore VPS and restart.
# config.json, .env, data/, and logs/ are DELIBERATELY not shipped: config & .env hold the access token & API keys,
# data holds the block cursor — if pushed, the cursor goes backward and old actions get re-evaluated.
# config.example.json IS shipped: it is the template the setup wizard reads (src/setup.js),
# so a new instance born from deploy.sh alone can still be set up through the browser.
#
# One VPS can host several instances. Instance name = folder name on the server = PM2 process name.
#   ./deploy.sh            → ~/lpcopy  (pm2: lpcopy)
#   ./deploy.sh lpcopy2    → ~/lpcopy2 (pm2: lpcopy2)
set -e
cd "$(dirname "$0")"
NAME=${1:-lpcopy}
HOST=${DEPLOY_HOST:-singapore}
# The dashboard URL is never written in the repo — taken from .env (LPCOPY_DASHBOARD_URL, or LPCOPY_DASHBOARD_URL_<NAME>).
if [[ -z "$LPCOPY_DASHBOARD_URL" && -f .env ]]; then
  LPCOPY_DASHBOARD_URL=$(sed -n "s/^LPCOPY_DASHBOARD_URL_${NAME:u}=//p" .env | tail -1)
  [[ -z "$LPCOPY_DASHBOARD_URL" && "$NAME" == lpcopy ]] && LPCOPY_DASHBOARD_URL=$(sed -n 's/^LPCOPY_DASHBOARD_URL=//p' .env | tail -1)
fi
echo "build tampilan…"
(cd web && npx vite build --logLevel warn)
rsync -az --exclude node_modules --exclude data --exclude logs --exclude config.json \
  src test public package.json README.md lp ecosystem.config.cjs deploy.sh .env.example config.example.json "$HOST:~/$NAME/"
ssh "$HOST" "mkdir -p ~/$NAME/web"
# Upload assets first; old tabs still need chunks from the previous build.
# index is published last, after every file it references is available.
ssh "$HOST" "mkdir -p ~/$NAME/web/dist"
rsync -az --exclude index.html web/dist/ "$HOST:~/$NAME/web/dist/"
rsync -az web/dist/index.html "$HOST:~/$NAME/web/dist/"
ssh "$HOST" "cd ~/$NAME && npm install --omit=dev --silent 2>/dev/null; if pm2 describe $NAME >/dev/null 2>&1; then pm2 restart ecosystem.config.cjs --only $NAME >/dev/null && pm2 save >/dev/null && echo 'pm2: $NAME di-restart'; else pm2 start ecosystem.config.cjs >/dev/null && pm2 save >/dev/null && echo 'pm2: $NAME dimulai (baru)'; fi"
echo "terkirim. dasbor: ${LPCOPY_DASHBOARD_URL:-(isi LPCOPY_DASHBOARD_URL di .env)}"

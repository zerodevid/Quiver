#!/bin/zsh
# Build tampilan (React + HeroUI) lalu kirim ke VPS Singapore dan restart.
# config.json, .env, data/, dan logs/ SENGAJA tidak ikut: config & .env berisi token akses & API key,
# data berisi kursor blok — kalau ikut ter-push, kursor mundur dan aksi lama dinilai ulang.
#
# Satu VPS bisa menampung beberapa instance. Nama instance = nama folder di server = nama proses PM2.
#   ./deploy.sh            → ~/lpcopy  (pm2: lpcopy)
#   ./deploy.sh lpcopy2    → ~/lpcopy2 (pm2: lpcopy2)
set -e
cd "$(dirname "$0")"
NAME=${1:-lpcopy}
HOST=${DEPLOY_HOST:-singapore}
# URL dasbor tidak pernah ditulis di repo — ambil dari .env (LPCOPY_DASHBOARD_URL, atau LPCOPY_DASHBOARD_URL_<NAMA>).
if [[ -z "$LPCOPY_DASHBOARD_URL" && -f .env ]]; then
  LPCOPY_DASHBOARD_URL=$(sed -n "s/^LPCOPY_DASHBOARD_URL_${NAME:u}=//p" .env | tail -1)
  [[ -z "$LPCOPY_DASHBOARD_URL" && "$NAME" == lpcopy ]] && LPCOPY_DASHBOARD_URL=$(sed -n 's/^LPCOPY_DASHBOARD_URL=//p' .env | tail -1)
fi
echo "build tampilan…"
(cd web && npx vite build --logLevel warn)
rsync -az --exclude node_modules --exclude data --exclude logs --exclude config.json \
  src test public package.json README.md lp ecosystem.config.cjs deploy.sh .env.example "$HOST:~/$NAME/"
ssh "$HOST" "mkdir -p ~/$NAME/web"
rsync -az --delete web/dist "$HOST:~/$NAME/web/"
ssh "$HOST" "cd ~/$NAME && npm install --omit=dev --silent 2>/dev/null; if pm2 describe $NAME >/dev/null 2>&1; then pm2 restart $NAME >/dev/null && echo 'pm2: $NAME di-restart'; else pm2 start ecosystem.config.cjs >/dev/null && pm2 save >/dev/null && echo 'pm2: $NAME dimulai (baru)'; fi"
echo "terkirim. dasbor: ${LPCOPY_DASHBOARD_URL:-(isi LPCOPY_DASHBOARD_URL di .env)}"

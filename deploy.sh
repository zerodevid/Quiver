#!/bin/zsh
# Build tampilan (React + HeroUI) lalu kirim ke VPS Singapore dan restart.
# config.json, .env, data/, dan logs/ SENGAJA tidak ikut: config & .env berisi token akses & API key,
# data berisi kursor blok — kalau ikut ter-push, kursor mundur dan aksi lama dinilai ulang.
set -e
cd "$(dirname "$0")"
echo "build tampilan…"
(cd web && npx vite build --logLevel warn)
rsync -az --exclude node_modules --exclude data --exclude logs --exclude config.json \
  src test public package.json README.md lp ecosystem.config.cjs deploy.sh .env.example singapore:~/lpcopy/
ssh singapore 'mkdir -p ~/lpcopy/web'
rsync -az --delete web/dist singapore:~/lpcopy/web/
ssh singapore 'cd ~/lpcopy && npm install --omit=dev --silent 2>/dev/null; pm2 restart lpcopy >/dev/null && echo "pm2: lpcopy di-restart"'
echo "terkirim. dasbor: $LPCOPY_DASHBOARD_URL"

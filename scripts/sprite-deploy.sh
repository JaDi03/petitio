#!/usr/bin/env sh
# Deploy Petitio to a Sprite from the public repo.
# Usage: scripts/sprite-deploy.sh <sprite-name> [git-ref]
# Needs the sprite CLI logged in (sprite login). Run from any folder.
set -eu

SPRITE="${1:?usage: scripts/sprite-deploy.sh <sprite-name> [git-ref]}"
REF="${2:-main}"
REPO="${PETITIO_REPO:-https://github.com/JaDi03/petitio.git}"

run() { sprite exec --no-stdin -s "$SPRITE" -- sh -c "$1"; }

echo "==> code ($REF)"
run "set -e
  [ -d \$HOME/petitio/.git ] || git clone --quiet '$REPO' \$HOME/petitio
  cd \$HOME/petitio && git fetch --quiet origin && git checkout --quiet -B deploy 'origin/$REF'
  cd \$HOME/petitio && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile --silent && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm -s build"

echo "==> settings"
run "set -e
  mkdir -p \$HOME/petitio-data && chmod 700 \$HOME/petitio-data
  ENV=\$HOME/petitio-data/.env
  [ -f \$ENV ] || cp \$HOME/petitio/.env.example \$ENV
  chmod 600 \$ENV
  if grep -q '^TELEGRAM_WEBHOOK_SECRET=generated-by-the-deploy-script' \$ENV; then
    SECRET=\$(node -e \"process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))\")
    sed -i \"s/^TELEGRAM_WEBHOOK_SECRET=.*/TELEGRAM_WEBHOOK_SECRET=\$SECRET/\" \$ENV
    echo 'generated TELEGRAM_WEBHOOK_SECRET'
  fi"

echo "==> service"
run "set -e
  sprite-env services delete petitio >/dev/null 2>&1 || true
  sprite-env services create petitio --cmd node \
    --args \"--env-file=\$HOME/petitio-data/.env,\$HOME/petitio/dist/server/main.js\" \
    --dir \$HOME/petitio --http-port 8080 --no-stream >/dev/null
  echo service started"

cat <<EOF

Next, once per Sprite:
  1. Fill the values in ~/petitio-data/.env on the Sprite (sprite console -s $SPRITE).
  2. Paste the AgentMail signing secret into AGENTMAIL_WEBHOOK_SECRET in that file.
  3. Make the URL public: sprite url update --auth public -s $SPRITE
  4. Register Telegram: sprite exec -s $SPRITE -- sh -c 'cd ~/petitio && node --env-file=\$HOME/petitio-data/.env scripts/telegram-webhook.mjs'
  5. Restart after editing settings: scripts/sprite-deploy.sh $SPRITE $REF
EOF

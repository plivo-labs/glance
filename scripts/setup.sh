#!/usr/bin/env bash
# Glance one-shot setup: secrets -> remote migrate -> deploy -> wire URLs -> print first-run link.
#
# Scope (by design): this does NOT provision D1/KV/R2 bindings — the "Deploy to Cloudflare"
# button (or the manual `wrangler ... create` steps in the README) does that. This script
# assumes the bindings already exist in wrangler.jsonc / wrangler.content.jsonc and takes it
# from there: generate the secrets, run migrations, deploy both workers, wire the live
# workers.dev URLs into config, and print the URL + bootstrap token to finish setup.
#
# Idempotent: re-running is safe. Existing secrets are NOT overwritten (regenerating
# SESSION_SECRET would invalidate every live session), migrations already applied are
# skipped, and URL wiring only touches the YOUR-SUBDOMAIN sentinel.
#
# Usage:
#   scripts/setup.sh
#   BOOTSTRAP_TOKEN=$(openssl rand -hex 32) scripts/setup.sh   # pin a known token
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$ROOT/packages/api"
cd "$API"

note() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!  %s\033[0m\n' "$*"; }

command -v wrangler >/dev/null || { echo "wrangler not found — install with 'bun add -g wrangler'"; exit 1; }
command -v openssl  >/dev/null || { echo "openssl not found"; exit 1; }

note "Checking Cloudflare auth"
wrangler whoami >/dev/null 2>&1 || wrangler login

CONTENT="--config wrangler.content.jsonc"

deploy_url() { # deploy and echo the first workers.dev URL from the output
  local out
  out="$(wrangler deploy "$@" 2>&1)"
  echo "$out" >&2
  echo "$out" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1
}

# Deploy FIRST: the workers boot fine without any secrets, and `wrangler secret put`
# requires the worker to already exist. This also gives us the live workers.dev URLs.
note "Building the web app"
(cd "$ROOT" && bun run build:web)
note "Deploying main worker"
APP_URL="$(deploy_url)"
note "Deploying content worker"
# shellcheck disable=SC2086
CONTENT_URL="$(deploy_url $CONTENT)"

# --- secrets: set each ONCE as a single shared value across both workers ---
# `wrangler secret list` prints a JSON array of {"name":...}; grep the name, no jq needed.
# Critical: CONTENT_TOKEN_SECRET is used to SIGN gated tokens on the main worker and VERIFY
# them on the content worker, so both workers MUST carry the identical value. We set a given
# secret only when BOTH workers lack it (clean first run) — otherwise we can't read it back
# to guarantee a match, so we keep what's there and warn on a partial state.
has_secret() { wrangler secret list "${@:2}" 2>/dev/null | grep -q "\"$1\""; }
put_both() { # name value
  printf '%s' "$2" | wrangler secret put "$1" >/dev/null
  # shellcheck disable=SC2086
  printf '%s' "$2" | wrangler secret put "$1" $CONTENT >/dev/null
}

note "Setting shared HMAC secrets across both workers (only on a clean first run)"
for name in SESSION_SECRET CONTENT_TOKEN_SECRET; do
  # shellcheck disable=SC2086
  if has_secret "$name" || has_secret "$name" $CONTENT; then
    # shellcheck disable=SC2086
    if has_secret "$name" && has_secret "$name" $CONTENT; then
      echo "   keep $name (already set on both)"
    else
      warn "$name is set on only one worker — leaving both. Re-sync manually so they MATCH:"
      warn "   S=\$(openssl rand -hex 32); echo \$S | wrangler secret put $name; echo \$S | wrangler secret put $name $CONTENT"
    fi
  else
    put_both "$name" "$(openssl rand -hex 32)"
    echo "   set $name on both workers"
  fi
done

note "Setting BOOTSTRAP_TOKEN on the main worker (first-run admin gate)"
BOOTSTRAP_PRINTED=""
if has_secret BOOTSTRAP_TOKEN; then
  warn "BOOTSTRAP_TOKEN already set — leaving it. (Secrets can't be read back; reuse the"
  warn "token you saved earlier, or rotate with: wrangler secret put BOOTSTRAP_TOKEN)"
else
  TOKEN="${BOOTSTRAP_TOKEN:-$(openssl rand -hex 32)}"
  printf '%s' "$TOKEN" | wrangler secret put BOOTSTRAP_TOKEN >/dev/null
  BOOTSTRAP_PRINTED="$TOKEN"
  echo "   set BOOTSTRAP_TOKEN"
fi

# Google OAuth is OPTIONAL — Glance runs bootstrap-only without it. Wire it later with:
#   wrangler secret put GOOGLE_CLIENT_ID && wrangler secret put GOOGLE_CLIENT_SECRET

note "Applying D1 migrations to the remote database"
wrangler d1 migrations apply glance-db --remote

# --- wire live URLs into config (single sentinel replace — safe, see PLAN Step 11) ---
# APP_URL is kept an explicit var (NOT request-derived): the bootstrap same-origin/CSRF
# check and cookie `secure` flag must not trust a spoofable Host header.
SUBDOMAIN=""
if [[ "$APP_URL" =~ ^https://[^.]+\.([^.]+)\.workers\.dev$ ]]; then SUBDOMAIN="${BASH_REMATCH[1]}"; fi
if [[ -n "$SUBDOMAIN" ]] && grep -rq 'YOUR-SUBDOMAIN' wrangler.jsonc wrangler.content.jsonc "$ROOT/packages/web/public/_headers"; then
  note "Wiring workers.dev subdomain '$SUBDOMAIN' into config + CSP, then redeploying"
  # macOS/BSD and GNU sed differ on -i; write to a temp and move for portability.
  for f in wrangler.jsonc wrangler.content.jsonc "$ROOT/packages/web/public/_headers"; do
    sed "s/YOUR-SUBDOMAIN/$SUBDOMAIN/g" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  done
  (cd "$ROOT" && bun run build:web)
  wrangler deploy >/dev/null
  wrangler deploy --config wrangler.content.jsonc >/dev/null
else
  warn "Skipped URL wiring (no YOUR-SUBDOMAIN sentinel left, or URL not parseable)."
  warn "Ensure APP_URL/CONTENT_URL in both wrangler configs and _headers frame-src are correct."
fi

note "Done."
echo "   App:     ${APP_URL:-<your worker URL>}"
echo "   Content: ${CONTENT_URL:-<your content worker URL>}"
if [[ -n "$BOOTSTRAP_PRINTED" ]]; then
  echo
  echo "   First-run setup token (store it somewhere safe — shown ONCE):"
  echo "       $BOOTSTRAP_PRINTED"
  echo
  echo "   Finish setup: open ${APP_URL:-<app>}/login and paste the token into 'Complete setup'."
  echo "   It claims SUPERADMIN_EMAIL ($(grep -oE '"SUPERADMIN_EMAIL"[^,]*' wrangler.jsonc | head -1)) as the first admin."
fi

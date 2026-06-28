#!/usr/bin/env bash
# Glance one-shot setup: provision -> deploy -> secrets -> migrate -> wire URLs -> print link.
#
# Does the WHOLE self-host from a fresh Cloudflare account. After `wrangler login` this script:
#   1. provisions the D1 database, KV namespace, and R2 bucket (create-or-reuse by name) and
#      wires their IDs into wrangler.jsonc / wrangler.content.jsonc;
#   2. strips the YOUR_ACCOUNT_ID placeholder so wrangler resolves the account from your login;
#   3. deploys both workers, sets the shared HMAC secrets + bootstrap token, runs the remote
#      D1 migration, wires the live workers.dev URLs into config, and prints the URL + token.
#
# Idempotent: re-running is safe. Resources are reused, never duplicated; existing secrets are
# NOT overwritten (regenerating SESSION_SECRET would invalidate every live session); migrations
# already applied are skipped; ID/URL wiring only touches the YOUR_* sentinels.
#
# Prereqs: `bun install` done, `wrangler login` (or CLOUDFLARE_API_TOKEN in env), and R2 enabled
# on the account (dash.cloudflare.com -> R2, accept terms). Multiple CF accounts on your login?
# export CLOUDFLARE_ACCOUNT_ID first so wrangler knows which one to use.
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

# --- provision bindings (create-or-reuse by name) and wire their IDs into both configs ---
# Gated on the YOUR_* sentinels: a config already carrying a real ID is left untouched, so
# re-runs never reprovision. Each resource is looked up by name first and only created if absent.
# This MUST run before the first deploy — wrangler rejects a binding that points at a placeholder.
UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
HEX32='[0-9a-f]{32}'

wire() { # sentinel value file...
  local sentinel="$1" value="$2"; shift 2
  for f in "$@"; do
    sed "s|$sentinel|$value|g" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  done
}

# account_id: the template ships a YOUR_ACCOUNT_ID placeholder. Drop the whole line so wrangler
# resolves the account from `wrangler login` (or CLOUDFLARE_ACCOUNT_ID) instead of the bad literal.
for f in wrangler.jsonc wrangler.content.jsonc; do
  if grep -q 'YOUR_ACCOUNT_ID' "$f"; then
    grep -v 'YOUR_ACCOUNT_ID' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  fi
done

note "Provisioning D1 database (glance-db)"
if grep -q 'YOUR_D1_DATABASE_ID' wrangler.jsonc; then
  D1_ID="$(wrangler d1 info glance-db 2>/dev/null | grep -oiE "$UUID" | head -1 || true)"   # reuse if it exists
  if [[ -z "$D1_ID" ]]; then
    D1_ID="$(wrangler d1 create glance-db 2>&1 | tee /dev/stderr | grep -oiE "$UUID" | head -1 || true)"
  fi
  [[ -n "$D1_ID" ]] || { echo "Could not determine D1 database_id — aborting."; exit 1; }
  wire YOUR_D1_DATABASE_ID "$D1_ID" wrangler.jsonc wrangler.content.jsonc   # both share one DB
  echo "   glance-db → $D1_ID"
else
  echo "   already wired — skipping"
fi

note "Provisioning KV namespace (GLANCE_SESSIONS)"
if grep -q 'YOUR_KV_NAMESPACE_ID' wrangler.jsonc; then
  KV_ID="$(wrangler kv namespace list 2>/dev/null | grep -B3 'GLANCE_SESSIONS' | grep -oE "$HEX32" | head -1 || true)"
  if [[ -z "$KV_ID" ]]; then
    KV_ID="$(wrangler kv namespace create GLANCE_SESSIONS 2>&1 | tee /dev/stderr | grep -oE "$HEX32" | head -1 || true)"
  fi
  [[ -n "$KV_ID" ]] || { echo "Could not determine KV namespace id — aborting."; exit 1; }
  wire YOUR_KV_NAMESPACE_ID "$KV_ID" wrangler.jsonc   # content worker has no KV
  echo "   GLANCE_SESSIONS → $KV_ID"
else
  echo "   already wired — skipping"
fi

note "Provisioning R2 bucket (glance-files)"
R2_OUT="$(wrangler r2 bucket create glance-files 2>&1 || true)"
echo "$R2_OUT" >&2
if echo "$R2_OUT" | grep -qiE 'created|already (exists|owned by you)'; then
  echo "   glance-files ready"
else
  warn "R2 bucket not confirmed. If R2 isn't enabled, turn it on at dash.cloudflare.com -> R2"
  warn "(accept the terms), then re-run. Multiple accounts? export CLOUDFLARE_ACCOUNT_ID first."
  exit 1
fi

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
  # reuse the sentinel-replace helper (temp+mv for macOS/BSD vs GNU sed portability).
  wire YOUR-SUBDOMAIN "$SUBDOMAIN" wrangler.jsonc wrangler.content.jsonc "$ROOT/packages/web/public/_headers"
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

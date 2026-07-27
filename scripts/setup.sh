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
# wrangler is a workspace devDependency, NOT a global install — put the pinned local copy on PATH
# so every call below resolves after a plain `bun install`, with no `bun add -g` and no bunx prefix.
export PATH="$ROOT/node_modules/.bin:$PATH"
cd "$API"

note() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!  %s\033[0m\n' "$*"; }

command -v wrangler >/dev/null || { echo "wrangler not found — run 'bun install' in the repo root first"; exit 1; }
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

# --- identity: superadmin email + allowed Google domain (MUST be wired before the FIRST deploy) ---
# Both are plain `vars`, so they ship inside the worker bundle. Deploying with the sentinels intact
# makes bootstrap claim the literal `you@yourcompany.com` as the first superadmin
# (routes/auth.ts `bootstrapSuperadminByEmail`), and the operator's real Google login later lands as
# a plain member (`findOrCreateUser` never promotes) — recoverable only by deleting that row from D1.
# CI already does this substitution from Actions Variables (.github/workflows/deploy.yml); this is
# the same wiring for the local one-shot path.
note "Wiring superadmin identity"
if grep -q 'you@yourcompany.com' wrangler.jsonc; then
  EMAIL="${SUPERADMIN_EMAIL:-}"
  if [[ -z "$EMAIL" ]]; then
    if [[ ! -t 0 ]]; then
      echo "SUPERADMIN_EMAIL is unset and stdin is not a terminal."
      echo "Re-run as: SUPERADMIN_EMAIL=you@yourcompany.com scripts/setup.sh"
      exit 1
    fi
    read -rp "  Superadmin email (the account that will own this instance): " EMAIL
  fi
  [[ "$EMAIL" == *@*.* ]] || { echo "Not an email address: '$EMAIL' — aborting."; exit 1; }
  # ALLOWED_HD gates Google Workspace logins; default it to the superadmin's own domain.
  HD="${ALLOWED_HD:-${EMAIL#*@}}"
  # ORDER MATTERS: the email sentinel CONTAINS the domain sentinel, so substituting the domain
  # first would rewrite `you@yourcompany.com` into `you@<hd>` and silently corrupt the email.
  # Same ordering, and the same reason, as the sed chain in deploy.yml.
  wire you@yourcompany.com "$EMAIL" wrangler.jsonc
  wire yourcompany.com "$HD" wrangler.jsonc
  echo "   superadmin → $EMAIL"
  echo "   allowed Google domain → $HD"
else
  echo "   already wired — skipping"
fi
if grep -q 'yourcompany.com' wrangler.jsonc; then
  echo "Identity sentinels survived substitution — aborting rather than deploying a dead admin."
  exit 1
fi

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

# --- secrets: generated ONCE, on a clean first run, and never rotated afterwards ---
# `wrangler secret list` prints a JSON array of {"name":...}; grep the name, no jq needed.
# Each secret goes only on the worker(s) that actually read it: SESSION_SECRET on the main worker,
# CONTENT_TOKEN_SECRET on both (it is SIGNED on main and VERIFIED on content, so the two MUST carry
# the identical value). A shared secret is written only when BOTH workers lack it — secrets can't be
# read back, so a partial state can't be checked for a match and is treated as fatal, not warned past.
# Returns 0 if secret $1 is present on the target worker, 1 if it is GENUINELY absent. If the
# underlying `wrangler secret list` call itself fails (network/auth/transient), it ABORTS the whole
# script rather than reporting "absent" — misreading a transient failure as absent would trip the
# clean-first-run branch below and rotate live SESSION_SECRET/CONTENT_TOKEN_SECRET with fresh
# openssl, silently invalidating every session and gated token. ($1 = secret name, $2.. = worker
# selector flags, e.g. $CONTENT.)
has_secret() {
  local name="$1"; shift
  local out rc=0
  out="$(wrangler secret list "$@" 2>&1)" || rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "$out" >&2
    echo "   wrangler secret list failed (exit $rc) — aborting so live secrets are NOT rotated." >&2
    exit 1
  fi
  grep -q "\"$name\"" <<<"$out"
}
put_both() { # name value
  printf '%s' "$2" | wrangler secret put "$1" >/dev/null
  # shellcheck disable=SC2086
  printf '%s' "$2" | wrangler secret put "$1" $CONTENT >/dev/null
}

# SESSION_SECRET signs app cookies + KV session tokens and is read ONLY by the main worker
# (lib/session.ts and routes/auth.ts; content.ts imports neither). Setting it on the content
# worker too would buy nothing and double the partial-state surface below — so, main only.
note "Setting SESSION_SECRET on the main worker (only on a clean first run)"
if has_secret SESSION_SECRET; then
  echo "   keep SESSION_SECRET (already set)"
else
  printf '%s' "$(openssl rand -hex 32)" | wrangler secret put SESSION_SECRET >/dev/null
  echo "   set SESSION_SECRET"
fi

# CONTENT_TOKEN_SECRET SIGNS gated content URLs on the main worker and VERIFIES them on the
# content worker, so both MUST carry the identical value. Secrets cannot be read back, so a
# half-written pair can't be repaired or even detected by comparison — and a mismatch means every
# gated link 403s while the workers look healthy. Fail LOUD rather than print "Done" over it.
note "Setting CONTENT_TOKEN_SECRET across both workers (only on a clean first run)"
# shellcheck disable=SC2086
if has_secret CONTENT_TOKEN_SECRET && has_secret CONTENT_TOKEN_SECRET $CONTENT; then
  echo "   keep CONTENT_TOKEN_SECRET (already set on both)"
# shellcheck disable=SC2086
elif has_secret CONTENT_TOKEN_SECRET || has_secret CONTENT_TOKEN_SECRET $CONTENT; then
  warn "CONTENT_TOKEN_SECRET is set on only ONE worker — every gated link would fail to verify."
  warn "Re-sync it manually so both MATCH, then re-run this script:"
  warn "   S=\$(openssl rand -hex 32)"
  warn "   printf %s \"\$S\" | wrangler secret put CONTENT_TOKEN_SECRET"
  warn "   printf %s \"\$S\" | wrangler secret put CONTENT_TOKEN_SECRET $CONTENT"
  exit 1
else
  put_both CONTENT_TOKEN_SECRET "$(openssl rand -hex 32)"
  echo "   set CONTENT_TOKEN_SECRET on both workers"
fi

note "Setting BOOTSTRAP_TOKEN on the main worker (first-run admin gate)"
BOOTSTRAP_PRINTED=""
if has_secret BOOTSTRAP_TOKEN; then
  warn "BOOTSTRAP_TOKEN already set — leaving it (secrets can't be read back)."
  warn "Lost it? Rotating is safe while no superadmin exists yet, and re-opens setup:"
  warn "   T=\$(openssl rand -hex 32); echo \"\$T\"; printf %s \"\$T\" | wrangler secret put BOOTSTRAP_TOKEN"
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

# --- D1 read replication (issue #79): reads route to the nearest replica via the Sessions API
# the workers use; billing is unchanged (still rows_read/rows_written). A DB-level setting with
# no wrangler command — REST only, so the OAuth login can't authenticate it. Best-effort here;
# CI (deploy.yml) also ensures it on every deploy.
note "Enabling D1 read replication (glance-db)"
if wrangler d1 info glance-db --json 2>/dev/null | grep -q '"mode": *"auto"'; then
  echo "   already enabled — skipping"
elif [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  ACCT="${CLOUDFLARE_ACCOUNT_ID:-$(wrangler whoami 2>/dev/null | grep -oE "$HEX32" | head -1 || true)}"
  DBID="$(grep '"database_id"' wrangler.jsonc | grep -oiE "$UUID" | head -1 || true)"
  if [[ -n "$ACCT" && -n "$DBID" ]] && curl -sS -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCT/d1/database/$DBID" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
      -d '{"read_replication":{"mode":"auto"}}' | grep -q '"success": *true'; then
    echo "   read replication → auto"
  else
    warn "Could not enable read replication via the API — enable it in the dashboard:"
    warn "   dash.cloudflare.com → Storage & Databases → D1 → glance-db → Settings"
  fi
else
  warn "Needs a REST call (no wrangler command). Enable it in the dashboard (D1 → glance-db →"
  warn "Settings) or export CLOUDFLARE_API_TOKEN (D1:Edit) and re-run."
fi

# --- wire live URLs into config (single sentinel replace — safe, see PLAN Step 11) ---
# APP_URL is kept an explicit var (NOT request-derived): the bootstrap same-origin/CSRF
# check and cookie `secure` flag must not trust a spoofable Host header.
SUBDOMAIN=""
if [[ "$APP_URL" =~ ^https://[^.]+\.([^.]+)\.workers\.dev$ ]]; then SUBDOMAIN="${BASH_REMATCH[1]}"; fi
if grep -rq 'YOUR-SUBDOMAIN' wrangler.jsonc wrangler.content.jsonc "$ROOT/packages/web/public/_headers"; then
  # The sentinel is still there, so this MUST succeed — shipping it means the content worker's
  # `frame-ancestors` and the SPA's `_headers` frame-src both pin a host that doesn't exist, and
  # every viewer iframe is blocked. An unparseable URL here is fatal, not a warning.
  if [[ -z "$SUBDOMAIN" ]]; then
    warn "Could not parse a workers.dev subdomain from: ${APP_URL:-<no URL captured>}"
    warn "Set APP_URL/CONTENT_URL in both wrangler configs and _headers frame-src by hand, then re-run."
    exit 1
  fi
  note "Wiring workers.dev subdomain '$SUBDOMAIN' into config + CSP, then redeploying"
  # reuse the sentinel-replace helper (temp+mv for macOS/BSD vs GNU sed portability).
  wire YOUR-SUBDOMAIN "$SUBDOMAIN" wrangler.jsonc wrangler.content.jsonc "$ROOT/packages/web/public/_headers"
  (cd "$ROOT" && bun run build:web)
  wrangler deploy >/dev/null
  wrangler deploy --config wrangler.content.jsonc >/dev/null
else
  echo "   URLs already wired — skipping"
fi

# --- final gate: no sentinel may survive a "successful" run ---
# Each one is a silent half-configuration (dead admin, unroutable binding, blocked iframe), and
# every path above is meant to have replaced or removed it. Cheap to assert, expensive to debug.
SENTINELS='YOUR_ACCOUNT_ID|YOUR_D1_DATABASE_ID|YOUR_KV_NAMESPACE_ID|YOUR-SUBDOMAIN|yourcompany.com'
if grep -rEl "$SENTINELS" wrangler.jsonc wrangler.content.jsonc "$ROOT/packages/web/public/_headers" >/dev/null; then
  warn "Placeholder sentinels still present after setup — this deploy is half-configured:"
  grep -rEn "$SENTINELS" wrangler.jsonc wrangler.content.jsonc "$ROOT/packages/web/public/_headers" >&2 || true
  exit 1
fi

note "Verifying the deploy"
if CONFIG="$(curl -fsS "${APP_URL}/api/config" 2>/dev/null)"; then
  echo "   ${APP_URL}/api/config → $CONFIG"
else
  warn "Could not reach ${APP_URL}/api/config yet — a fresh workers.dev route can take a moment."
  warn "Re-check with: curl -fsS ${APP_URL}/api/config"
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

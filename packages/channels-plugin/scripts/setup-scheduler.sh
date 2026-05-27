#!/usr/bin/env bash
# setup-scheduler.sh — one-shot migration + env-var setup for the F1/F2
# scheduler subsystem.
#
# What it does (idempotent — safe to run repeatedly):
#   1. Validates BOT_OWNER_ID looks like a Discord snowflake (digits).
#   2. Ensures $PAPERCUP_HOME exists with mode 0700.
#   3. Upserts BOT_OWNER_ID into dispatcher/.env (creating the file from
#      .env.example when missing).
#   4. Optionally runs `npm run register` to push the new /cron, /queue,
#      /scheduler, /limit-handler slash commands to Discord.
#
# It does NOT touch scheduler.db — the dispatcher creates the schema on first
# boot via CREATE TABLE IF NOT EXISTS. It does NOT start papercup; the dispatch
# step is left to the operator.
#
# Usage:
#   scripts/setup-scheduler.sh --owner <discord-user-id>
#                              [--home <path>]
#                              [--register]
#                              [--dry-run]
#
# Examples:
#   scripts/setup-scheduler.sh --owner 1452485937756901519
#   scripts/setup-scheduler.sh --owner 1452485937756901519 --home /var/lib/papercup
#   scripts/setup-scheduler.sh --owner 1452485937756901519 --register

set -euo pipefail

BOT_OWNER_ID=""
PAPERCUP_HOME_ARG=""
RUN_REGISTER=0
DRY_RUN=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
    cat <<EOF
Usage: $0 --owner <discord-user-id> [--home <path>] [--register] [--dry-run]

Required:
  --owner <id>     Bot owner Discord user-id (snowflake, digits only).

Optional:
  --home <path>    \$PAPERCUP_HOME override. Default: \$HOME/.papercup-channels
  --register       Run \`npm run register\` after setup to push slash commands.
                   Requires DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID
                   to already be set in dispatcher/.env.
  --dry-run        Print actions without writing files or running commands.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --owner)
            BOT_OWNER_ID="${2:-}"
            shift 2
            ;;
        --home)
            PAPERCUP_HOME_ARG="${2:-}"
            shift 2
            ;;
        --register)
            RUN_REGISTER=1
            shift
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown arg: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [[ -z "$BOT_OWNER_ID" ]]; then
    echo "error: --owner is required" >&2
    usage >&2
    exit 2
fi

if ! [[ "$BOT_OWNER_ID" =~ ^[0-9]{15,21}$ ]]; then
    echo "error: --owner must be a Discord snowflake (15-21 digits); got: $BOT_OWNER_ID" >&2
    exit 2
fi

PAPERCUP_HOME="${PAPERCUP_HOME_ARG:-${PAPERCUP_HOME:-$HOME/.papercup-channels}}"
DISPATCHER_DIR="$PKG_ROOT/dispatcher"
ENV_FILE="$DISPATCHER_DIR/.env"
ENV_EXAMPLE="$PKG_ROOT/.env.example"

echo "papercup-channels scheduler setup"
echo "  package root:    $PKG_ROOT"
echo "  papercup home:   $PAPERCUP_HOME"
echo "  dispatcher .env: $ENV_FILE"
echo "  bot owner id:    $BOT_OWNER_ID"
[[ $DRY_RUN -eq 1 ]] && echo "  mode:            DRY RUN (no writes)"
echo

# --- 1. ensure $PAPERCUP_HOME exists with 0700 ----------------------------
if [[ ! -d "$PAPERCUP_HOME" ]]; then
    echo "-> creating $PAPERCUP_HOME (mode 0700)"
    [[ $DRY_RUN -eq 0 ]] && install -d -m 0700 "$PAPERCUP_HOME"
else
    current_mode="$(stat -c '%a' "$PAPERCUP_HOME" 2>/dev/null || stat -f '%Lp' "$PAPERCUP_HOME")"
    if [[ "$current_mode" != "700" ]]; then
        echo "-> tightening $PAPERCUP_HOME mode from $current_mode to 0700"
        [[ $DRY_RUN -eq 0 ]] && chmod 0700 "$PAPERCUP_HOME"
    else
        echo "ok: $PAPERCUP_HOME already exists with mode 0700"
    fi
fi

# --- 2. ensure dispatcher/.env exists -------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
    if [[ ! -f "$ENV_EXAMPLE" ]]; then
        echo "error: neither $ENV_FILE nor $ENV_EXAMPLE exists" >&2
        exit 1
    fi
    echo "-> creating $ENV_FILE from $ENV_EXAMPLE"
    [[ $DRY_RUN -eq 0 ]] && cp "$ENV_EXAMPLE" "$ENV_FILE" && chmod 0600 "$ENV_FILE"
else
    echo "ok: $ENV_FILE exists"
fi

# --- 3. upsert BOT_OWNER_ID into dispatcher/.env --------------------------
upsert_env_var() {
    local var_name="$1"
    local var_value="$2"
    local file="$3"

    if [[ $DRY_RUN -eq 1 ]]; then
        if grep -qE "^[[:space:]]*${var_name}=" "$file" 2>/dev/null; then
            echo "-> would update $var_name in $file"
        else
            echo "-> would append $var_name to $file"
        fi
        return 0
    fi

    local tmp
    tmp="$(mktemp "${file}.XXXXXX")"
    chmod 0600 "$tmp"
    if grep -qE "^[[:space:]]*${var_name}=" "$file" 2>/dev/null; then
        # Replace existing line (commented or active).
        sed -E "s|^[[:space:]]*#?[[:space:]]*${var_name}=.*|${var_name}=${var_value}|" "$file" > "$tmp"
        mv "$tmp" "$file"
        echo "-> updated $var_name in $file"
    else
        cp "$file" "$tmp"
        printf '\n# Set by scripts/setup-scheduler.sh\n%s=%s\n' "$var_name" "$var_value" >> "$tmp"
        mv "$tmp" "$file"
        echo "-> appended $var_name to $file"
    fi
}

upsert_env_var "BOT_OWNER_ID" "$BOT_OWNER_ID" "$ENV_FILE"

if [[ -n "$PAPERCUP_HOME_ARG" ]]; then
    upsert_env_var "PAPERCUP_HOME" "$PAPERCUP_HOME" "$ENV_FILE"
fi

# --- 4. scheduler.db note --------------------------------------------------
DB_PATH="$PAPERCUP_HOME/scheduler.db"
if [[ -f "$DB_PATH" ]]; then
    echo "ok: scheduler.db already present at $DB_PATH (schema will auto-upgrade on dispatcher boot)"
else
    echo "info: scheduler.db will be created at $DB_PATH on first dispatcher boot"
fi

# --- 5. optional: register slash commands ---------------------------------
if [[ $RUN_REGISTER -eq 1 ]]; then
    echo
    echo "-> running: npm run register (cwd: $DISPATCHER_DIR)"
    if [[ $DRY_RUN -eq 0 ]]; then
        (cd "$DISPATCHER_DIR" && npm run register)
    fi
fi

echo
echo "scheduler setup complete."
if [[ $RUN_REGISTER -eq 0 ]]; then
    echo "  Next: cd $DISPATCHER_DIR && npm run register   # push slash commands"
fi
echo "  Then: cd $DISPATCHER_DIR && npm start              # boot the dispatcher"

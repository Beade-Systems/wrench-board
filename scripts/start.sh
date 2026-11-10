#!/usr/bin/env bash
# Start uvicorn with auto-bootstrap of Managed Agents resources on first run.
#
# When DIAGNOSTIC_MODE is unset or set to "managed" (default) and
# managed_ids.json is absent, this prints a one-screen warning, waits 5
# seconds for the operator to Ctrl+C, then runs
# scripts/bootstrap_managed_agent.py to materialise the environment + the
# four tier-scoped agents on the operator's Anthropic account. The IDs are
# persisted locally in managed_ids.json (gitignored). On subsequent starts
# the file is present so we go straight to uvicorn.
#
# To skip Managed Agents entirely (e.g. when the beta is unavailable on the
# operator's account), invoke `make demo-fallback` instead — it sets
# DIAGNOSTIC_MODE=direct and never reads managed_ids.json.
set -euo pipefail

cd "$(dirname "$0")/.."

# Read a KEY from the process env first, then from .env (no sourcing — .env
# values are never executed). Prints the raw value, quotes stripped.
env_or_dotenv() {
    local key="$1" val="${!1:-}"
    if [ -z "$val" ] && [ -f .env ]; then
        val="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" .env | tail -n1 | cut -d= -f2- || true)"
        val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
        val="$(printf '%s' "$val" | tr -d '[:space:]')"
    fi
    printf '%s' "$val"
}

MODE="$(env_or_dotenv DIAGNOSTIC_MODE)"
MODE="${MODE:-managed}"
API_KEY="$(env_or_dotenv ANTHROPIC_API_KEY)"
IDS_FILE="managed_ids.json"
PORT="${PORT:-8000}"
# Bind interface — defaults to 127.0.0.1 so the dev server is local-only.
# Override with `HOST=0.0.0.0` (or `make run HOST=0.0.0.0`) for LAN access.
HOST="${HOST:-127.0.0.1}"
PYTHON=".venv/bin/python"
UVICORN=".venv/bin/uvicorn"

if [ "$MODE" != "direct" ] && [ ! -f "$IDS_FILE" ] && [ -z "$API_KEY" ]; then
    # Bootstrap would only sleep 5 s and then exit on the missing key, taking
    # the server down with it. Start anyway: pure-data endpoints work, and the
    # app logs the missing-key warning itself.
    echo "ANTHROPIC_API_KEY not set — skipping Managed Agents bootstrap." >&2
elif [ "$MODE" != "direct" ] && [ ! -f "$IDS_FILE" ]; then
    cat <<'EOF'

  Managed Agents bootstrap required
  ─────────────────────────────────
  No managed_ids.json found. About to create on your
  Anthropic account:

    - 1 environment
    - 4 agents: fast (Haiku 4.5), normal (Sonnet 4.6),
      deep (Opus 4.8), curator (Sonnet 4.6)

  Idle resources (no cost until used). The IDs are persisted
  locally in managed_ids.json (gitignored).

  To skip and use the direct (Messages API) fallback instead,
  Ctrl+C now and run: make demo-fallback

  Auto-bootstrapping in 5 seconds...

EOF
    sleep 5
    "$PYTHON" scripts/bootstrap_managed_agent.py
    echo
    echo "Bootstrap complete. Starting uvicorn..."
    echo
fi

# Watch only the backend package: edits under memory/, board_assets/, web/,
# tests/ or scripts/ never require a server restart.
exec "$UVICORN" api.main:app --reload --reload-dir api --host "$HOST" --port "$PORT"

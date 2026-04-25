#!/usr/bin/env bash
# smoke.sh — boots server, tests /api/health and /api/parse, checks no key in logs
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-5188}"
LOG="$ROOT/smoke.log"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── Step 1: Check prerequisites ──────────────────────────────────────────────
echo "[smoke] Checking prerequisites..."

if ! command -v node &>/dev/null; then
  echo "FAIL: node not found" >&2; exit 1
fi

NODE_VER=$(node --version | sed 's/v//')
MAJOR="${NODE_VER%%.*}"
if [[ $MAJOR -lt 20 ]]; then
  echo "FAIL: Node ≥20 required, got $NODE_VER" >&2; exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "FAIL: python3 not found — install Python 3.10+" >&2; exit 1
fi

# ── Step 2: npm install ────────────────────────────────────────────────────
echo "[smoke] Installing dependencies..."
npm install --silent 2>&1

# ── Step 3: Static key scan ────────────────────────────────────────────────
# Scan for real key patterns (≥20 chars after prefix) in source files.
# Excludes README (examples like sk-ant-...) and test fixtures (short mock values).
echo "[smoke] Scanning for hardcoded API keys in source files..."
SCAN_HITS=$(grep -rE 'sk-ant-[A-Za-z0-9_-]{20,}' \
    --include="*.js" --include="*.json" \
    --exclude-dir=node_modules \
    --exclude="test-bridge.js" \
    . 2>/dev/null || true)
if [[ -n "$SCAN_HITS" ]]; then
  echo "FAIL: Found real-looking sk-ant-... key in source files:" >&2
  echo "$SCAN_HITS" >&2
  exit 1
fi
echo "  ✓ No hardcoded keys found"

# ── Step 4: Start server ───────────────────────────────────────────────────
echo "[smoke] Starting server on port $PORT..."
PORT=$PORT node server/server.js > "$LOG" 2>&1 &
SERVER_PID=$!

# Wait for server to be ready (up to 10s)
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "FAIL: Server process died. Log:" >&2
    cat "$LOG" >&2
    exit 1
  fi
  sleep 0.5
  if [[ $i -eq 20 ]]; then
    echo "FAIL: Server did not start within 10s" >&2
    cat "$LOG" >&2
    exit 1
  fi
done
echo "  ✓ Server started"

# ── Step 5: /api/health ─────────────────────────────────────────────────
echo "[smoke] Testing /api/health..."
HEALTH=$(curl -sf "http://127.0.0.1:$PORT/api/health")
echo "  health: $HEALTH"
if ! echo "$HEALTH" | grep -q '"ok":true'; then
  echo "FAIL: /api/health did not return ok:true" >&2; exit 1
fi
echo "  ✓ /api/health OK"

# ── Step 6: /api/parse with plaintext fixture ──────────────────────────
echo "[smoke] Testing /api/parse with plaintext fixture..."
FIXTURE="$ROOT/fixtures/plaintext.txt"
FIXTURE_TEXT=$(cat "$FIXTURE")
PARSE_BODY=$(printf '{"kind":"text-paste","input":%s}' "$(echo "$FIXTURE_TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")

PARSE_RESULT=$(curl -sf -X POST "http://127.0.0.1:$PORT/api/parse" \
  -H "Content-Type: application/json" \
  -d "$PARSE_BODY")

echo "  parse result (truncated): ${PARSE_RESULT:0:200}"

if ! echo "$PARSE_RESULT" | grep -q '"ok":true'; then
  echo "FAIL: /api/parse did not return ok:true" >&2
  echo "Full result: $PARSE_RESULT" >&2
  exit 1
fi

# Check canonical JSON has expected top-level keys
for KEY in name experiences education skills _source; do
  if ! echo "$PARSE_RESULT" | grep -q "\"$KEY\""; then
    echo "FAIL: /api/parse result missing key: $KEY" >&2; exit 1
  fi
done
echo "  ✓ /api/parse OK with all canonical keys"

# ── Step 7: /api/render ─────────────────────────────────────────────────
echo "[smoke] Testing /api/render..."
# Extract data from parse result
DATA=$(echo "$PARSE_RESULT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d["data"]))')
RENDER_BODY=$(python3 -c "import json; print(json.dumps({'data': json.loads('$DATA'), 'template': 'modern-minimal', 'privacy_decision': 'keep'}))" 2>/dev/null || echo '')

if [[ -z "$RENDER_BODY" ]]; then
  # Simpler approach
  RENDER_BODY=$(echo "$PARSE_RESULT" | python3 -c '
import json,sys
r = json.load(sys.stdin)
payload = {"data": r["data"], "template": "modern-minimal", "privacy_decision": "keep"}
print(json.dumps(payload))
')
fi

RENDER_RESULT=$(curl -sf -X POST "http://127.0.0.1:$PORT/api/render" \
  -H "Content-Type: application/json" \
  -d "$RENDER_BODY")

HTML_LEN=$(echo "$RENDER_RESULT" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(len(r.get("html","")))')
echo "  rendered HTML length: $HTML_LEN bytes"

if [[ "$HTML_LEN" -lt 5000 ]]; then
  echo "FAIL: rendered HTML is <5KB ($HTML_LEN bytes)" >&2; exit 1
fi

if ! echo "$RENDER_RESULT" | python3 -c 'import json,sys; r=json.load(sys.stdin); assert "<!DOCTYPE" in r.get("html","")' 2>/dev/null; then
  echo "FAIL: rendered HTML does not contain <!DOCTYPE" >&2; exit 1
fi
echo "  ✓ /api/render OK (${HTML_LEN} bytes)"

# ── Step 8: Check logs for key leakage ───────────────────────────────────
echo "[smoke] Checking server log for API key patterns..."
if grep -E 'sk-ant-[A-Za-z0-9_-]+' "$LOG" 2>/dev/null; then
  echo "FAIL: Found sk-ant-... pattern in server log" >&2; exit 1
fi
echo "  ✓ No API key patterns in server log"

# ── Step 9: Check templates exist ────────────────────────────────────────
echo "[smoke] Checking templates..."
for TPL in modern-minimal colorful academic-serif; do
  if [[ ! -f "$ROOT/templates/$TPL.html" ]]; then
    echo "FAIL: templates/$TPL.html not found" >&2; exit 1
  fi
  LINE_COUNT=$(wc -l < "$ROOT/templates/$TPL.html")
  echo "  $TPL.html: $LINE_COUNT lines"
done
echo "  ✓ All 3 templates present"

# ── Done ─────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════"
echo "Smoke test PASSED ✓"
echo "════════════════════════════════"

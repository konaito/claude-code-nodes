#!/bin/bash
# 127.0.0.1 のノードを curl で一通り叩く。使い方: scripts/smoke.sh [port] [cwd]
set -euo pipefail
PORT=${1:-4322}
CWD=${2:-$(mktemp -d)}
B=http://127.0.0.1:$PORT
echo "== host"; curl -sS "$B/api/host"; echo
echo "== create"; ID=$(curl -sS -X POST "$B/api/sessions" -H 'content-type: application/json' -d "{\"cwd\":\"$CWD\",\"prompt\":\"reply with the single word ok\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'); echo "$ID"
echo "== events (first frames)"; curl -sS -N --max-time 60 "$B/api/sessions/$ID/events?after=0" | grep -m1 -A1 '^event: result' || true
echo "== sessions"; curl -sS "$B/api/sessions" | python3 -c 'import sys,json;[print(s["kind"], s["state"], s["id"], s.get("parent")) for s in json.load(sys.stdin)]'
echo "== send"; curl -sS -X POST "$B/api/sessions/$ID/messages" -H 'content-type: application/json' -d '{"text":"reply with the single word pong"}'; echo
echo "== messages"; curl -sS "$B/api/sessions/$ID/messages?after=0" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d["messages"]),"events, next",d.get("next"))'
echo "== delete"; curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE "$B/api/sessions/$ID"

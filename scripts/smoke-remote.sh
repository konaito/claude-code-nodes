#!/bin/bash
# 外（Cloudflare 経由）からノードを一通り叩く。使い方: scripts/smoke-remote.sh <host> [cwd]
# 認証は ~/.config/cc/cc.json のサービストークン。トークンは argv に出さず、curl の -H をプロセス置換で渡す
set -euo pipefail
HOST=${1:?host}
CWD=${2:-/tmp}
CFG=${CC_CONFIG:-$HOME/.config/cc/cc.json}
B="https://$HOST"
hdr() { python3 - "$CFG" <<'PY'
import json,sys
c=json.load(open(sys.argv[1]))["serviceToken"]
print(f"CF-Access-Client-Id: {c['clientId']}")
print(f"CF-Access-Client-Secret: {c['clientSecret']}")
PY
}
HDR=$(mktemp); hdr > "$HDR"; trap 'rm -f "$HDR"' EXIT
c() { curl -sS -H "@$HDR" "$@"; }
echo "== no auth"; curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' "$B/api/host"
echo "== host"; c "$B/api/host"; echo
echo "== peers"; c "$B/api/peers"; echo
echo "== create"; ID=$(c -X POST "$B/api/sessions" -H 'content-type: application/json' -H 'x-cc-from: agent:smoke' -d "{\"cwd\":\"$CWD\",\"prompt\":\"reply with the single word ok\",\"permissionMode\":\"default\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'); echo "$ID"
echo "== events (until result)"; c -N --max-time 90 "$B/api/sessions/$ID/events?after=0" | grep -m1 '^event: result' || true
echo "== sessions"; c "$B/api/sessions" | python3 -c 'import sys,json;[print(s["kind"], s["state"], s["id"][:8], s.get("parent")) for s in json.load(sys.stdin)[:6]]'
echo "== send (asks for a Write)"; c -X POST "$B/api/sessions/$ID/messages" -H 'content-type: application/json' -d '{"text":"Use the Write tool to create a file named smoke.txt in the current directory containing exactly: hello"}'; echo
echo "== wait permission"; c -N --max-time 90 "$B/api/sessions/$ID/events?after=0" | grep -m1 '^event: permission_request' || true
RID=$(c "$B/api/sessions/$ID" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["pending"][0]["requestId"] if d["pending"] else "")'); echo "pending: $RID"
if [ -n "$RID" ]; then echo "== allow"; c -X POST "$B/api/sessions/$ID/permissions/$RID" -H 'content-type: application/json' -d '{"behavior":"allow"}'; echo; fi
echo "== wait result"; c -N --max-time 90 "$B/api/sessions/$ID/events?after=0" | grep -m2 '^event: result' | tail -1 || true
echo "== interrupt"; c -X POST "$B/api/sessions/$ID/messages" -H 'content-type: application/json' -d '{"text":"Count from 1 to 300, one number per line, no tools."}' >/dev/null; sleep 2; c -X POST "$B/api/sessions/$ID/interrupt" -H 'content-type: application/json' -d '{}'; echo
echo "== delete"; c -o /dev/null -w '%{http_code}\n' -X DELETE "$B/api/sessions/$ID"

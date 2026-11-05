// 新しい機械で `curl -fsSL <入口>/install | sh` として動くインストーラ。参加トークンは /dev/tty（無ければ標準入力）から1回読み、引数と環境変数には出さない
export function installerScript(o: { entry: string; cliName: string }): string {
  return `#!/bin/sh
# cc のインストーラ。bun と cloudflared を入れ、実行物を ~/.local/share/cc/app に置き、参加トークンで設定と常駐を作る
set -eu
ENTRY="${o.entry}"
TARBALL="${o.entry}/install/cc.tar.gz"
CLI="${o.cliName}"
APP="$HOME/.local/share/cc/app"
BIN="$HOME/.local/bin"
mkdir -p "$HOME/.local/share/cc" "$BIN"

# 参加トークン。端末から1回だけ読む。パイプで渡されたときは標準入力。末尾に改行が無いと read が非ゼロを返すので set -e で止めない
# token-read-begin
TOKEN=""
if [ -r /dev/tty ] && [ -w /dev/tty ] && (exec < /dev/tty) 2>/dev/null; then
  printf '参加トークン: ' > /dev/tty
  IFS= read -r TOKEN < /dev/tty || :
else
  IFS= read -r TOKEN || :
fi
[ -n "$TOKEN" ] || { echo "参加トークンが空" >&2; exit 1; }
# token-read-end

OS=$(uname -s)
case "$(uname -m)" in
  arm64|aarch64) GOARCH=arm64 ;;
  x86_64|amd64) GOARCH=amd64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
export PATH="$HOME/.bun/bin:$BIN:/opt/homebrew/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  if [ "$OS" = Darwin ]; then
    if command -v brew >/dev/null 2>&1; then
      brew install cloudflared
    else
      curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$GOARCH.tgz" | tar xz -C "$BIN"
    fi
  else
    curl -fsSL -o "$BIN/cloudflared" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$GOARCH"
    chmod +x "$BIN/cloudflared"
  fi
fi

rm -rf "$APP.new"
mkdir -p "$APP.new"
curl -fsSL "$TARBALL" | tar xz -C "$APP.new"
(cd "$APP.new" && bun install --frozen-lockfile --production)
rm -rf "$APP.old"
if [ -d "$APP" ]; then mv "$APP" "$APP.old"; fi
mv "$APP.new" "$APP"
rm -rf "$APP.old"

cd "$APP"
printf '%s' "$TOKEN" | bun run src/cli/cc.ts install
echo "done: $CLI は $BIN/$CLI"
`;
}

# cc-web

1台の機械の Claude Code を 127.0.0.1 の HTTP と SSE で開放するノード。設計は docs/superpowers/specs/、計画は docs/superpowers/plans/ にある。

開発は `~/Documents/cc-web` で行う。試験は `bun test`。本物の claude を使う試験は `CC_LIVE=1 bun test test/live.test.ts` を VM で回す。

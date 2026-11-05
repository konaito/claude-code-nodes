# 試作4の結果（2台目の参加、中継、親子）

2026-11-06。対象はcc-webのfeat/application（Task 13）。前段は`docs/results/2026-11-06-application-vm.md`。

## 親子（VMの上で、自分のノードに対して）

MacのリゾルバがDNSの負のキャッシュを持っていた間に、VMで`cc`を自分のノードに向けて通した（`CLAUDE_CODE_SESSION_ID=deadbeef-…`を親のidとして与えた）。

| 命令 | 結果 |
| --- | --- |
| `cc peers` | `konaito-pro inactive`、`vm healthy (self)` |
| `cc new ~/work "Reply with the single word ready, then wait." --as lead --mode default` | `vm/273d6abb-…` |
| `cc read <対象> --wait 60` | `ready`、`state=idle pending=0 seq=11` |
| `cc run <対象> "Use the Write tool to create cli.txt …"` | `[tool] Write /home/konaito/work/cli.txt`、`[permission] Write … requestId=e8b96a5a-…`、`state=waiting_permission pending=1 seq=26`（終了コード3） |
| `cc show <対象>` | `state: waiting_permission`、`permissionMode: default`、`parent: agent:vm/deadbeef/lead`、`pending: e8b96a5a-… Write /home/konaito/work/cli.txt` |
| `cc allow <対象>` | `allow e8b96a5a-…`（pendingが1件なのでrequestIdを省けた） |
| `cc read <対象>` | `I created /home/konaito/work/cli.txt containing exactly hi.`、`state=idle pending=0 seq=40`。ファイルは2バイトでできていた |
| `cc ls --mine` | `vm/273d6abb node idle /home/konaito/work agent:vm/deadbeef/lead`の1行 |
| `cc stop <対象>` | 止まった |

直したこと。
- `bin/cc`が`~/.local/bin/cc`のsymlinkから呼ばれると`$0`のdirnameで実体を見失っていた。symlinkをたどるようにし、試験を足した。
- `cc ls`は落ちている相手（inactive、down）を呼ばず`<peer>  (inactive)`の1行にし、JSONでない誤り（Cloudflareの530のページ）はタグを落として60文字に縮めた。

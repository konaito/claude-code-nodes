// 実行物の配布。ノードは自分のソースを tar.gz にして BUNDLE_PATH（names.ts）で配る（入口ノードが配布元になる）
import { existsSync } from "node:fs";
import { join } from "node:path";

export const BUNDLE_PATHS = ["src", "skills", "bin", "package.json", "bun.lock", "tsconfig.json", "README.md"];

export function bundle(appRoot: string): ReadableStream<Uint8Array> {
  const paths = BUNDLE_PATHS.filter((p) => existsSync(join(appRoot, p)));
  const proc = Bun.spawn(["tar", "czf", "-", "-C", appRoot, ...paths], { stdout: "pipe", stderr: "ignore" });
  return proc.stdout;
}

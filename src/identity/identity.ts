// 呼び手を決める境界。プロトコルは x-cc-from と x-cc-via のヘッダだけを見る。誰がこのヘッダを置いてよいかはアプリケーション（AccessIdentity）が決める
export type CallerKind = "user" | "node" | "local"; // user は Access の email、node はノード用サービストークン、local は同じ機械
export type Caller = { id: string; via?: string; kind?: CallerKind }; // id は email か "agent:<名前>" か "local"
export interface Identity { callerOf(req: Request): Promise<Caller> } // 断るときは AccessDenied を投げる

export class AccessDenied extends Error {
  constructor(public status: 401 | 403, message: string) { super(message); this.name = "AccessDenied"; }
}

export class HeaderIdentity implements Identity {
  async callerOf(req: Request): Promise<Caller> {
    const id = req.headers.get("x-cc-from")?.trim();
    const via = req.headers.get("x-cc-via")?.trim();
    if (!id) return { id: "local", kind: "local" };
    return via ? { id, via, kind: "local" } : { id, kind: "local" };
  }
}

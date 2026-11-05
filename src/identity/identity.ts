// 呼び手を決める境界。プロトコルは x-cc-from と x-cc-via のヘッダだけを見る。誰がこのヘッダを置いてよいかはアプリケーション（Access）が決める
export type Caller = { id: string; via?: string }; // id は email か "agent:<名前>" か "local"
export interface Identity { callerOf(req: Request): Caller }

export class HeaderIdentity implements Identity {
  callerOf(req: Request): Caller {
    const id = req.headers.get("x-cc-from")?.trim();
    const via = req.headers.get("x-cc-via")?.trim();
    if (!id) return { id: "local" };
    return via ? { id, via } : { id };
  }
}

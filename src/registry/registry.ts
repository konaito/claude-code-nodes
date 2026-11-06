// 登録簿の境界。仲間のノードの一覧。本物は Cloudflare のトンネル一覧（cloudflare.ts）、試験と単独のノードは固定の一覧
export type PeerStatus = "healthy" | "degraded" | "down" | "inactive";
export type Peer = { name: string; url: string; status: PeerStatus; self: boolean };
export interface Registry { peers(): Promise<Peer[]> }

export class StaticRegistry implements Registry {
  constructor(private list: Peer[]) {}
  async peers(): Promise<Peer[]> { return this.list.map((p) => ({ ...p })); }
}

export class RegistryError extends Error {
  constructor(public status: number, msg: string) { super(msg); this.name = "RegistryError"; }
}

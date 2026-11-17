// 引き継ぎ（succeed）で止めた前任の、終わりの理由。exitReason がこれで始まれば、後継に引き継がれて止まった。
// 理由には後継の id を入れる。一覧、詳細、通知、send の 409 が、ここから後継を読む（src/api/sessions.ts の succeed）
export const SUCCEEDED_PREFIX = "succeeded:";
export const succeededReason = (successorId: string) => `${SUCCEEDED_PREFIX} continued as ${successorId}`;
export function successorOf(reason: string | undefined): string | undefined {
  const m = reason ? /^succeeded: continued as ([0-9a-f][0-9a-f-]{7,35})/i.exec(reason) : null;
  return m ? m[1] : undefined;
}

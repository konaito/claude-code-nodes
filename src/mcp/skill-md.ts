// /skill.md の本文。正本は <appRoot>/skills/<PUBLIC_SKILL_NAME>/SKILL.md で、{{ORIGIN}} を要求の入口（https://<host>）に置き換えて配る
import { join } from "node:path";
import { PUBLIC_SKILL_NAME } from "../names";

export const skillMdPath = (appRoot: string) => join(appRoot, "skills", PUBLIC_SKILL_NAME, "SKILL.md");

export async function skillMd(appRoot: string, origin: string): Promise<string> {
  const text = await Bun.file(skillMdPath(appRoot)).text();
  return text.replaceAll("{{ORIGIN}}", origin);
}

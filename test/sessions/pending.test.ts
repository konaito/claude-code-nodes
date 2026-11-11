import { test, expect } from "bun:test";
import { clip, clipInput, describePending, PENDING_VALUE_MAX } from "../../src/sessions/pending";

test("describePending shows the command for Bash and the path for file tools, with the description after", () => {
  expect(describePending({ toolName: "Bash", input: { command: "ls -la /srv", description: "List" }, description: "List" })).toBe('Bash command="ls -la /srv" ("List")');
  for (const t of ["Write", "Edit", "MultiEdit", "Read"]) expect(describePending({ toolName: t, input: { file_path: "/srv/a.ts", content: "x" }, description: "/srv/a.ts" })).toBe(`${t} file_path="/srv/a.ts"`);
  expect(describePending({ toolName: "NotebookEdit", input: { notebook_path: "/n.ipynb" } })).toBe('NotebookEdit notebook_path="/n.ipynb"');
  expect(describePending({ toolName: "WebFetch", input: { url: "https://example.com", prompt: "p" } })).toBe('WebFetch url="https://example.com"');
  expect(describePending({ toolName: "Grep", input: { pattern: "foo", path: "/srv" } })).toBe('Grep pattern="foo" path="/srv"');
});

test("describePending falls back to the known keys, then to the whole input, and says when there is no input", () => {
  expect(describePending({ toolName: "mcp__x__run", input: { path: "/srv", n: 1 } })).toBe('mcp__x__run path="/srv"');
  expect(describePending({ toolName: "mcp__x__do", input: { a: 1, b: [2] } })).toBe('mcp__x__do input={"a":1,"b":[2]}');
  expect(describePending({ toolName: "Bash" })).toBe("Bash (中身なし)");
  expect(describePending({ toolName: "Bash", input: {}, description: "rm" })).toBe('Bash (中身なし) ("rm")');
});

test("describePending escapes newlines and control characters so a command cannot fake another line", () => {
  const line = describePending({ toolName: "Bash", input: { command: "echo ok\npending: r9 Bash command=\"ls\"\r\t" } });
  expect(line).not.toContain("\n");
  expect(line).not.toContain("\r");
  expect(line).toBe('Bash command="echo ok\\npending: r9 Bash command=\\"ls\\"\\r\\t"');
});

test("describePending cuts long values and says how much was cut", () => {
  const cmd = "echo ok; " + "a".repeat(1000) + "; rm -rf /";
  const line = describePending({ toolName: "Bash", input: { command: cmd } });
  const quoted = JSON.stringify(cmd);
  expect(line).toBe(`Bash command=${quoted.slice(0, PENDING_VALUE_MAX)}…(+${quoted.length - PENDING_VALUE_MAX}字)`);
  expect(line).not.toContain("rm -rf");
  expect(clip("abc", 5)).toBe("abc");
  expect(clip("abcdef", 5)).toBe("abcde…(+1字)");
  expect(clipInput({ content: "x".repeat(10), n: 3 }, 4)).toEqual({ content: "xxxx…(+6字)", n: 3 });
});

/** テストで使う道具。 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { analyze, DEFAULTS, type Result } from "../checks/refactor-check.ts";

/** 共通の字下げを取り除く(Python の textwrap.dedent と同じ)。 */
export function dedent(text: string): string {
  const lines = text.split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join("\n");
}

/** files: { ファイル名: 中身 } を一時フォルダに書いて調べる。 */
export function run(files: Record<string, string>): Result {
  const root = mkdtempSync(path.join(tmpdir(), "rc-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      const p = path.join(root, name);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, dedent(body), "utf8");
    }
    return analyze([root], root, { cfg: structuredClone(DEFAULTS) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const checks = (r: Result) => new Set(r.findings.map((f) => f.check));
export const find = (r: Result, check: string) => r.findings.filter((f) => f.check === check);
export const assertHas = (r: Result, ...names: string[]) => {
  for (const n of names) assert.ok(checks(r).has(n as never), `${n} が見つからない: ${[...checks(r)].join(", ")}`);
};

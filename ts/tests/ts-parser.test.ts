import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { find, run } from "./helpers.ts";

describe("typescript の構文解析でだけ正確に数えられるもの", () => {
  test("文字列やテンプレートの中の {} や if に惑わされない", () => {
    const r = run({ "a.ts": `
      export function render(items: string[]): string {
        const tpl = \`\${items.map((x) => \`<li>\${x}</li>\`).join("")}\`;
        return tpl;
      }
    ` });
    assert.deepEqual(find(r, "deep-nesting"), []);
    assert.deepEqual(find(r, "complexity"), []);
  });

  test("入れ子の関数の分岐は外の関数に数えない", () => {
    const inner = Array.from({ length: 12 }, (_, i) => `    if (x === ${i}) return ${i};`).join("\n");
    const r = run({ "a.ts": `export function outer(xs: number[]) {\n  return xs.map((x) => {\n${inner}\n    return 0;\n  });\n}\n` });
    assert.deepEqual(find(r, "complexity").map((f) => f.name), ["(無名関数)"]);
  });

  test("any は構文木で見つける(正規表現の中の any は数えない)", () => {
    const r = run({ "a.ts": `
      export const RE = /<any>/;
      export function f(xs: Array<any>) {
        return xs;
      }
    ` });
    assert.deepEqual(find(r, "type-escape").map((f) => f.line), [3]);
  });

  test("正規表現・テンプレート・JSX の中の // はコメントとして扱わない", () => {
    const r = run({
      "a.ts": `
        export const pattern = /[//] @ts-ignore/;
        export const url = \`https://example.invalid/\${pattern.source} // TODO 文字列\`;
      `,
      "b.tsx": `
        export function Link() {
          return <p>it's a // TODO in text: @ts-ignore</p>;
        }
      `,
    });
    assert.deepEqual(find(r, "type-escape"), []);
    assert.deepEqual(find(r, "todo"), []);
  });

  test("本物のコメントは、構文解析のときも見つける", () => {
    const r = run({ "a.ts": `
      const re = /a\\/b/; // TODO: あとで直す
      // @ts-ignore
      export const x: number = re.source as unknown as number;
      /* FIXME: まとめて直す */
    ` });
    assert.deepEqual(find(r, "todo").map((f) => f.line), [2, 5]);
    assert.deepEqual(find(r, "type-escape").map((f) => f.line), [3]);
  });

  test("const はファイルの一番外にあっても指摘しない", () => {
    const r = run({ "a.ts": `
      export const LIMIT = 10;
      export let counter = 0;
    ` });
    assert.deepEqual(find(r, "global-state").map((f) => f.line), [3]);
  });
});

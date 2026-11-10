import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { analyze, DEFAULTS, type Result } from "../checks/refactor-check.ts";

/** 共通の字下げを取り除く(Python の textwrap.dedent と同じ)。 */
function dedent(text: string): string {
  const lines = text.split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join("\n");
}

/** files: { ファイル名: 中身 } を一時フォルダに書いて調べる。 */
function run(files: Record<string, string>): Result {
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

const checks = (r: Result) => new Set(r.findings.map((f) => f.check));
const find = (r: Result, check: string) => r.findings.filter((f) => f.check === check);
const assertHas = (r: Result, ...names: string[]) => {
  for (const n of names) assert.ok(checks(r).has(n as never), `${n} が見つからない: ${[...checks(r)].join(", ")}`);
};

describe("Python", () => {
  test("問題のないコードは skip", () => {
    const r = run({ "ok.py": `
      def add(a, b):
          return a + b
    ` });
    assert.equal(r.verdict, "skip");
    assert.deepEqual(r.findings, []);
  });

  test("長すぎる関数", () => {
    const body = "def big():\n" + Array.from({ length: 60 }, (_, i) => `    x${i} = 0\n`).join("");
    const r = run({ "a.py": body });
    assert.equal(find(r, "long-function")[0].name, "big");
    assert.equal(r.verdict, "suggest");
  });

  test("入れ子は elif を数えない", () => {
    const r = run({ "a.py": `
      def deep(a):
          for x in a:
              if x:
                  while x:
                      if x > 5:
                          return x

      def flat(a):
          if a == 5:
              return 5
          elif a == 6:
              return 6
          elif a == 7:
              return 7
          elif a == 8:
              return 8
          else:
              return 9
    ` });
    assert.deepEqual(find(r, "deep-nesting").map((f) => f.name), ["deep"]);
    assert.deepEqual(find(r, "branch-chain").map((f) => f.name), ["flat"]);
  });

  test("引数の数と true/false の引数", () => {
    const r = run({ "a.py": `
      class C:
          def many(self, a, b, c, d, e):
              return a

      def save(data, notify=False):
          return data
    ` });
    assert.equal(find(r, "long-params")[0].name, "many");
    assert.match(find(r, "flag-param")[0].message, /notify/);
  });

  test("キーワード専用の引数も数える", () => {
    const r = run({ "a.py": `
      def f(*, a, b, c, d, e, notify=False):
          return a
    ` });
    assert.equal(find(r, "long-params")[0].name, "f");
    assert.match(find(r, "flag-param")[0].message, /notify/);
  });

  test("空の except は high", () => {
    const r = run({ "a.py": `
      def load():
          try:
              return open("x").read()
          except Exception:
              pass
    ` });
    assert.equal(find(r, "swallowed-error")[0].severity, "high");
    assert.equal(r.verdict, "act");
    assert.ok(r.next_steps.some((s) => s.startsWith("P01")));
  });

  test("説明のない数字と定数", () => {
    const r = run({ "a.py": `
      SECONDS_PER_DAY = 86400

      def days(seconds):
          return seconds / 86400
    ` });
    assert.deepEqual(find(r, "magic-number").map((f) => f.line), [5]);
  });

  test("文字列とコメントの中の数字は数えない", () => {
    const r = run({ "a.py": `
      def label():
          # 12345 件まで
          return "code 98765"
    ` });
    assert.deepEqual(find(r, "magic-number"), []);
  });

  test("コメントの検出", () => {
    const r = run({ "a.py": `
      def f(items):
          # TODO: あとで直す
          # total = 0
          # for x in items:
          #     total += x
          return items  # type: ignore
    ` });
    assertHas(r, "todo", "commented-code", "type-escape");
  });

  test("秘密の値", () => {
    const r = run({ "a.py": `
      API_KEY = "abcd1234efgh5678ijkl"
      PASSWORD = "your-password-here"
    ` });
    assert.deepEqual(find(r, "secret").map((f) => f.line), [2]);
  });

  test("ignore の印", () => {
    const r = run({ "a.py": `
      def load():
          try:
              return 1
          except Exception:  # refactor-check: ignore
              pass
    ` });
    assert.deepEqual(find(r, "swallowed-error"), []);
  });

  test("global と長い条件", () => {
    const r = run({ "a.py": `
      count = 0

      def bump(a, b, c, d):
          global count
          if a and b or c and d:
              count += 1
    ` });
    assertHas(r, "global-state", "long-condition");
  });

  test("複数行の引数と文字列の中のコロン", () => {
    const r = run({ "a.py": `
      def many(
          a,
          b: str = "x:y",
          c=1,
          d=2,
          e=3,
      ):
          text = """
          if x:
              pass
          """
          return a
    ` });
    assert.equal(find(r, "long-params")[0].name, "many");
    assert.deepEqual(find(r, "deep-nesting"), []);
  });
});

// JS/TS は typescript の構文解析と、見つからないときの推測の両方で確かめる
for (const mode of ["typescript", "heuristic"] as const) {
  describe(`波かっこの言語 (${mode})`, () => {
    const runMode = (files: Record<string, string>) => {
      if (mode === "heuristic") process.env.REFACTOR_CHECK_NO_TS = "1";
      try {
        const r = run(files);
        assert.equal(r.js_ts_parser, mode);
        return r;
      } finally {
        delete process.env.REFACTOR_CHECK_NO_TS;
      }
    };

    test("TypeScript の関数", () => {
      const r = runMode({ "a.ts": `
        export function many(a: string, b: number, c: number, d: number, e: number): string {
          return a;
        }

        const save = async (data: Item, notify: boolean): Promise<void> => {
          console.log(data);
        };

        class Service {
          run(items: Item[]) {
            for (const x of items) {
              if (x.ok) {
                while (x.next) {
                  if (x.value > 0) {
                    return x;
                  }
                }
              }
            }
          }
        }
      ` });
      assert.equal(find(r, "long-params")[0].name, "many");
      assert.equal(find(r, "flag-param")[0].name, "save");
      assert.equal(find(r, "deep-nesting")[0].name, "run");
      assertHas(r, "debug-output");
    });

    test("オブジェクトの {} は入れ子に数えない", () => {
      const r = runMode({ "a.js": `
        function build() {
          return { a: { b: { c: { d: { e: 1 } } } } };
        }
      ` });
      assert.deepEqual(find(r, "deep-nesting"), []);
    });

    test("空の catch と any", () => {
      const r = runMode({ "a.ts": `
        let cache = {};

        function load(x: any) {
          try {
            return JSON.parse(x);
          } catch (e) {
            // 何もしない
          }
          return a.getB().getC().getD();
        }
      ` });
      assertHas(r, "swallowed-error", "type-escape", "global-state", "call-chain");
      assert.equal(r.verdict, "act");
    });

    test("promise の空の catch", () => {
      const r = runMode({ "a.ts": `
        export async function send() {
          await fetch("/x").catch(() => {});
        }
      ` });
      assert.equal(find(r, "swallowed-error").length, 1);
    });

    test("Go はかっこなしの if も入れ子に数える", () => {
      const r = runMode({ "a.go": `
        func Run(items []Item) error {
            for _, x := range items {
                if x.Ok {
                    for x.Next() {
                        if x.Value > 0 {
                            return nil
                        }
                    }
                }
            }
            return nil
        }
      ` });
      assert.equal(find(r, "deep-nesting")[0].name, "Run");
    });

    test("else if の列", () => {
      const r = runMode({ "a.js": `
        function label(kind) {
          if (kind === "a") { return 5; }
          else if (kind === "b") { return 6; }
          else if (kind === "c") { return 7; }
          else if (kind === "d") { return 8; }
          else { return 9; }
        }
      ` });
      assert.equal(find(r, "branch-chain")[0].name, "label");
    });
  });
}

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

  test("const はファイルの一番外にあっても指摘しない", () => {
    const r = run({ "a.ts": `
      export const LIMIT = 10;
      export let counter = 0;
    ` });
    assert.deepEqual(find(r, "global-state").map((f) => f.line), [3]);
  });
});

describe("ファイルをまたぐ検出", () => {
  const block = (name: string) => `
    def ${name}(order):
        subtotal = order.price * order.quantity
        discount = subtotal * order.discount_rate
        taxed = (subtotal - discount) * order.tax_rate
        shipping = order.weight * order.shipping_rate
        total = subtotal - discount + taxed + shipping
        order.total = round(total)
        return order
  `;

  test("ファイルをまたぐ重複", () => {
    const r = run({ "a.py": block("one"), "b.py": block("two") });
    const dup = find(r, "duplicate");
    assert.equal(dup.length, 1);
    assert.equal(dup[0].file, "b.py");
    assert.match(dup[0].message, /a\.py/);
  });

  test("テストを見つけ、テストの中は緩める", () => {
    const r = run({
      "app.py": "def add(a, b):\n    return a + b\n",
      "tests/test_app.py": "def test_add():\n    assert 12345 == 12345\n    print(777)\n",
    });
    assert.equal(r.preflight.test_files, 1);
    assert.deepEqual(r.findings, []);
  });
});

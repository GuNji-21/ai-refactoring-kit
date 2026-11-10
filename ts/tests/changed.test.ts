import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { GitError, git } from "../checks/core.ts";
import { analyze, DEFAULTS } from "../checks/refactor-check.ts";

const SWALLOWS_ERROR = "def load():\n    try:\n        return 1\n    except Exception:\n        pass\n";
const CLEAN = "def add(a, b):\n    return a + b\n";

describe("--changed(git で変更したファイルだけを調べる)", () => {
  let root = "";
  const gitRun = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: root });
  const write = (name: string, body: string) => {
    const p = path.join(root, name);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body, "utf8");
  };
  const commitAll = () => {
    gitRun("add", "-A");
    gitRun("commit", "-q", "-m", "commit");
  };
  const changed = (overrides: Partial<typeof DEFAULTS> = {}) =>
    analyze([], root, { changed: true, cfg: { ...structuredClone(DEFAULTS), ...overrides } });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "rc-git-"));
    gitRun("init", "-q", ".");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("日本語の名前の未追跡ファイル", () => {
    write("base.py", CLEAN);
    commitAll();
    write("処理.py", SWALLOWS_ERROR);
    const r = changed();
    assert.equal(r.verdict, "act");
    assert.equal(r.findings[0].file, "処理.py");
  });

  test("日本語の名前の編集したファイル", () => {
    write("処理.py", CLEAN);
    commitAll();
    write("処理.py", SWALLOWS_ERROR);
    assert.equal(changed().verdict, "act");
  });

  test("最初のコミットの前に追加したファイル", () => {
    write("app.py", SWALLOWS_ERROR);
    gitRun("add", "app.py");
    const r = changed();
    assert.equal(r.files_checked, 1);
    assert.equal(r.verdict, "act");
  });

  test("変更していないファイルは報告しない", () => {
    write("old.py", SWALLOWS_ERROR);
    commitAll();
    write("new.py", CLEAN);
    const r = changed();
    assert.equal(r.files_checked, 1);
    assert.equal(r.verdict, "skip");
  });

  test("exclude は変更したファイルにも効く", () => {
    write("base.py", CLEAN);
    commitAll();
    write("generated/out.py", SWALLOWS_ERROR);
    const r = changed({ exclude: ["generated/"] });
    assert.equal(r.files_checked, 0);
    assert.equal(r.verdict, "skip");
  });

  const staged = () => analyze([], root, { staged: true, cfg: structuredClone(DEFAULTS) });

  test("--staged: 作業中のファイルを戻しても、ステージした中身を調べる", () => {
    write("app.py", CLEAN);
    commitAll();
    write("app.py", SWALLOWS_ERROR);
    gitRun("add", "app.py");
    write("app.py", CLEAN); // 作業中のファイルだけ元に戻す。コミットされるのは問題のある中身
    assert.equal(changed().verdict, "skip");
    const r = staged();
    assert.equal(r.files_checked, 1);
    assert.equal(r.verdict, "act");
  });

  test("--staged: ステージしていない変更は調べない", () => {
    write("app.py", CLEAN);
    commitAll();
    write("app.py", SWALLOWS_ERROR);
    const r = staged();
    assert.equal(r.files_checked, 0);
    assert.equal(r.verdict, "skip");
  });

  test("--staged: 作業中のファイルを消しても、ステージした中身を調べる", () => {
    write("処理.ts", "export function f() {\n  try { g(); } catch (e) {}\n}\n");
    gitRun("add", "処理.ts");
    rmSync(path.join(root, "処理.ts"));
    const r = staged();
    assert.equal(r.verdict, "act");
    assert.equal(r.findings[0].file, "処理.ts");
  });

  test("--staged: 削除をステージしたファイルは調べない", () => {
    write("app.py", SWALLOWS_ERROR);
    commitAll();
    gitRun("rm", "-q", "app.py");
    assert.equal(staged().files_checked, 0);
  });

  test("git が失敗したらエラーにする", (t) => {
    const outside = mkdtempSync(path.join(tmpdir(), "rc-nogit-"));
    try {
      if (git(outside, "rev-parse", "--git-dir") !== null) {
        t.skip("一時フォルダが git のリポジトリの中にある");
        return;
      }
      assert.throws(() => analyze([], outside, { changed: true, cfg: structuredClone(DEFAULTS) }), GitError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

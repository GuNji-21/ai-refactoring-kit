import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "checks"))

import refactor_check as rc


def run(files):
    """files: {ファイル名: 中身} を一時フォルダに書いて調べる。"""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for name, body in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(textwrap.dedent(body), encoding="utf-8")
        return rc.analyze([str(root)], root, cfg=dict(rc.DEFAULTS))


def checks(result):
    return {f["check"] for f in result["findings"]}


def find(result, check):
    return [f for f in result["findings"] if f["check"] == check]


class PythonChecks(unittest.TestCase):
    def test_clean_code_is_skipped(self):
        result = run({"ok.py": """
            def add(a, b):
                return a + b
        """})
        self.assertEqual(result["verdict"], "skip")
        self.assertEqual(result["findings"], [])

    def test_long_function(self):
        body = "def big():\n" + "".join(f"    x{i} = 0\n" for i in range(60))
        result = run({"a.py": body})
        self.assertEqual(find(result, "long-function")[0]["name"], "big")
        self.assertEqual(result["verdict"], "suggest")

    def test_deep_nesting_ignores_elif(self):
        result = run({"a.py": """
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
        """})
        self.assertEqual([f["name"] for f in find(result, "deep-nesting")], ["deep"])
        self.assertEqual([f["name"] for f in find(result, "branch-chain")], ["flat"])

    def test_params_and_flags(self):
        result = run({"a.py": """
            class C:
                def many(self, a, b, c, d, e):
                    return a

            def save(data, notify=False):
                return data
        """})
        self.assertEqual(find(result, "long-params")[0]["name"], "many")
        self.assertIn("notify", find(result, "flag-param")[0]["message"])

    def test_keyword_only_params_are_counted(self):
        result = run({"a.py": """
            def f(*, a, b, c, d, e, notify=False):
                return a
        """})
        self.assertEqual(find(result, "long-params")[0]["name"], "f")
        self.assertIn("notify", find(result, "flag-param")[0]["message"])

    def test_swallowed_error_is_high(self):
        result = run({"a.py": """
            def load():
                try:
                    return open("x").read()
                except Exception:
                    pass
        """})
        self.assertEqual(find(result, "swallowed-error")[0]["severity"], "high")
        self.assertEqual(result["verdict"], "act")
        self.assertTrue(any(s.startswith("P01") for s in result["next_steps"]))

    def test_magic_number_and_constant(self):
        result = run({"a.py": """
            SECONDS_PER_DAY = 86400

            def days(seconds):
                return seconds / 86400
        """})
        self.assertEqual([f["line"] for f in find(result, "magic-number")], [5])

    def test_numbers_in_strings_and_comments_are_ignored(self):
        result = run({"a.py": """
            def label():
                # 12345 件まで
                return "code 98765"
        """})
        self.assertEqual(find(result, "magic-number"), [])

    def test_comment_checks(self):
        result = run({"a.py": """
            def f(items):
                # TODO: あとで直す
                # total = 0
                # for x in items:
                #     total += x
                return items  # type: ignore
        """})
        self.assertLessEqual({"todo", "commented-code", "type-escape"}, checks(result))

    def test_secret(self):
        result = run({"a.py": """
            API_KEY = "abcd1234efgh5678ijkl"
            PASSWORD = "your-password-here"
        """})
        self.assertEqual([f["line"] for f in find(result, "secret")], [2])

    def test_ignore_mark(self):
        result = run({"a.py": """
            def load():
                try:
                    return 1
                except Exception:  # refactor-check: ignore
                    pass
        """})
        self.assertEqual(find(result, "swallowed-error"), [])

    def test_global_and_condition(self):
        result = run({"a.py": """
            count = 0

            def bump(a, b, c, d):
                global count
                if a and b or c and d:
                    count += 1
        """})
        self.assertLessEqual({"global-state", "long-condition"}, checks(result))


class BraceChecks(unittest.TestCase):
    def test_typescript_functions(self):
        result = run({"a.ts": """
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
        """})
        self.assertEqual(find(result, "long-params")[0]["name"], "many")
        self.assertEqual(find(result, "flag-param")[0]["name"], "save")
        self.assertEqual(find(result, "deep-nesting")[0]["name"], "run")
        self.assertIn("debug-output", checks(result))

    def test_object_literals_are_not_nesting(self):
        result = run({"a.js": """
            function build() {
              return { a: { b: { c: { d: { e: 1 } } } } };
            }
        """})
        self.assertEqual(find(result, "deep-nesting"), [])

    def test_empty_catch_and_any(self):
        result = run({"a.ts": """
            let cache = {};

            function load(x: any) {
              try {
                return JSON.parse(x);
              } catch (e) {
                // 何もしない
              }
              return a.getB().getC().getD();
            }
        """})
        self.assertLessEqual({"swallowed-error", "type-escape", "global-state", "call-chain"}, checks(result))
        self.assertEqual(result["verdict"], "act")

    def test_go_nesting_without_parens(self):
        result = run({"a.go": """
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
        """})
        self.assertEqual(find(result, "deep-nesting")[0]["name"], "Run")

    def test_else_if_chain(self):
        result = run({"a.js": """
            function label(kind) {
              if (kind === "a") { return 5; }
              else if (kind === "b") { return 6; }
              else if (kind === "c") { return 7; }
              else if (kind === "d") { return 8; }
              else { return 9; }
            }
        """})
        self.assertEqual(find(result, "branch-chain")[0]["name"], "label")


class CrossFileChecks(unittest.TestCase):
    BLOCK = """
        def {name}(order):
            subtotal = order.price * order.quantity
            discount = subtotal * order.discount_rate
            taxed = (subtotal - discount) * order.tax_rate
            shipping = order.weight * order.shipping_rate
            total = subtotal - discount + taxed + shipping
            order.total = round(total)
            return order
    """

    def test_duplicate_across_files(self):
        result = run({"a.py": self.BLOCK.format(name="one"), "b.py": self.BLOCK.format(name="two")})
        dup = find(result, "duplicate")
        self.assertEqual(len(dup), 1)
        self.assertEqual(dup[0]["file"], "b.py")
        self.assertIn("a.py", dup[0]["message"])

    def test_tests_are_detected_and_relaxed(self):
        result = run({
            "app.py": "def add(a, b):\n    return a + b\n",
            "tests/test_app.py": "def test_add():\n    assert 12345 == 12345\n    print(777)\n",
        })
        self.assertEqual(result["preflight"]["test_files"], 1)
        self.assertEqual(result["findings"], [])


SWALLOWS_ERROR = "def load():\n    try:\n        return 1\n    except Exception:\n        pass\n"
CLEAN = "def add(a, b):\n    return a + b\n"


class ChangedMode(unittest.TestCase):
    """--changed(git で変更したファイルだけを調べる)の動き。"""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.git("init", "-q", ".")

    def git(self, *args):
        identity = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"]
        subprocess.run(["git", *identity, *args], cwd=self.root, check=True, capture_output=True)

    def write(self, name, body):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")

    def commit_all(self):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "commit")

    def changed(self, **overrides):
        return rc.analyze([], self.root, changed=True, cfg={**rc.DEFAULTS, **overrides})

    def test_untracked_file_with_japanese_name(self):
        self.write("base.py", CLEAN)
        self.commit_all()
        self.write("処理.py", SWALLOWS_ERROR)
        result = self.changed()
        self.assertEqual(result["verdict"], "act")
        self.assertEqual(result["findings"][0]["file"], "処理.py")

    def test_modified_file_with_japanese_name(self):
        self.write("処理.py", CLEAN)
        self.commit_all()
        self.write("処理.py", SWALLOWS_ERROR)
        self.assertEqual(self.changed()["verdict"], "act")

    def test_staged_file_before_first_commit(self):
        self.write("app.py", SWALLOWS_ERROR)
        self.git("add", "app.py")
        result = self.changed()
        self.assertEqual(result["files_checked"], 1)
        self.assertEqual(result["verdict"], "act")

    def test_unchanged_files_are_not_reported(self):
        self.write("old.py", SWALLOWS_ERROR)
        self.commit_all()
        self.write("new.py", CLEAN)
        result = self.changed()
        self.assertEqual(result["files_checked"], 1)
        self.assertEqual(result["verdict"], "skip")

    def test_exclude_applies_to_changed_files(self):
        self.write("base.py", CLEAN)
        self.commit_all()
        self.write("generated/out.py", SWALLOWS_ERROR)
        result = self.changed(exclude=["generated/"])
        self.assertEqual(result["files_checked"], 0)
        self.assertEqual(result["verdict"], "skip")

    def test_git_failure_is_an_error(self):
        with tempfile.TemporaryDirectory() as outside:
            if rc.git(Path(outside), "rev-parse", "--git-dir") is not None:
                self.skipTest("一時フォルダが git のリポジトリの中にある")
            with self.assertRaises(rc.GitError):
                rc.analyze([], Path(outside), changed=True, cfg=dict(rc.DEFAULTS))


if __name__ == "__main__":
    unittest.main()

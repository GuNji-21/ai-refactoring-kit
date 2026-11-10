#!/usr/bin/env python3
"""リファクタリングを始めるべきかどうかを判定する。

コードを調べて、catalog.md の項目に対応する問題を見つけ、
「今すぐ直す(act)」「提案する(suggest)」「直さない(skip)」のどれかを返す。
コードの書き換えは一切しない。

使い方:
    python refactor_check.py [パス ...]      指定したファイルやフォルダを調べる
    python refactor_check.py --changed       git で変更したファイルだけを調べる
    python refactor_check.py --json          AI が読みやすい JSON で出力する

外部ライブラリは不要(Python 3.9 以上)。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from rc_brace import check_brace
from rc_core import GitError, Report, Source, git, git_paths, is_excluded, is_test_path, walk, wanted
from rc_lines import FILE_CHECKS, check_duplicates
from rc_python import check_python
from rc_rules import (CONFIG_FILE, DEFAULTS, MAX_FILE_BYTES, MAX_LINE_CHARS, MINIFIED_SAMPLE_LINES,
                      SEVERITY_ORDER)

# ---------------------------------------------------------------- 判定


def preflight(root: Path, exclude):
    """直し始めてよい状態かどうかを調べる(カタログ P01, P03)。"""
    tests = sum(1 for p in walk(root, exclude) if is_test_path(p.relative_to(root).as_posix()))
    status = git(root, "status", "--porcelain")
    return {
        "test_files": tests,
        "git_repo": status is not None,
        "uncommitted_changes": len(status.splitlines()) if status else 0,
    }


# (この重さの項目が1件でもあれば, 判定, 理由) を重い順に並べたもの
VERDICTS = (
    ("high", "act", "重大な問題があるので、今の作業を進める前に直す価値がある"),
    ("medium", "suggest", "直したほうがよい点がある。ユーザーに見せて、直すかどうかを決めてもらう"),
)
SKIP = ("skip", "リファクタリングを始めるほどの問題はない")


def _verdict(counts):
    for severity, verdict, reason in VERDICTS:
        if counts[severity]:
            return verdict, reason
    return SKIP


def _next_steps(findings, pre):
    """直す順番。先に安全を確かめる手順(P01, P03)を置き、最後にテストの手順(P02)を置く。"""
    steps = []
    if pre["test_files"] == 0:
        steps.append("P01: テストが見つからない。直す前に、今の動きを固定するテストを書く")
    if pre["uncommitted_changes"]:
        steps.append(f"P03: コミットしていない変更が {pre['uncommitted_changes']} 件ある。"
                     "先にコミットして、整理と機能の変更を混ぜない")
    by_id = {}
    for f in findings:
        if f["severity"] != "low":
            by_id.setdefault(f["catalog_id"], f"{f['catalog_id']} {f['title']}: {f['action']}")
    return steps + list(by_id.values()) + ["P02: 1種類直すたびにテストを実行する"]


def decide(findings, pre):
    counts = {s: sum(1 for f in findings if f["severity"] == s) for s in SEVERITY_ORDER}
    verdict, reason = _verdict(counts)
    steps = _next_steps(findings, pre) if verdict != "skip" else []
    return {"verdict": verdict, "reason": reason, "counts": counts, "next_steps": steps}


def load_config(root: Path):
    cfg = dict(DEFAULTS)
    path = root / CONFIG_FILE
    if path.is_file():
        try:
            cfg.update(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError) as e:
            sys.stderr.write(f"{CONFIG_FILE} を読めません: {e}\n")
    return cfg


def changed_files(root: Path, exclude):
    """コミットしていない変更(追加・編集・未追跡)のあるファイル。パスは root から見たもの。"""
    untracked = git_paths(root, "ls-files", "--others", "--exclude-standard")
    if git(root, "rev-parse", "--verify", "--quiet", "HEAD") is None:
        tracked = git_paths(root, "ls-files", "--cached")  # 最初のコミットの前は、追加したものすべてが変更
    else:
        tracked = git_paths(root, "diff", "--name-only", "--relative", "HEAD")
    paths = {(root / name).resolve() for name in tracked + untracked}
    return {p for p in paths if p.is_file() and wanted(p) and not is_excluded(p, exclude)}


def listed_files(paths, exclude):
    found = set()
    for raw in paths or ["."]:
        p = Path(raw).resolve()
        if p.is_dir():
            found.update(x.resolve() for x in walk(p, exclude))
        elif p.is_file() and wanted(p):
            found.add(p)
    return found


def load_sources(files, targets, root: Path):
    sources = []
    for p in sorted(files):
        try:
            if p.stat().st_size > MAX_FILE_BYTES:
                continue
            src = Source(p, root, p in targets)
        except OSError:
            continue
        if not any(len(line) > MAX_LINE_CHARS for line in src.lines[:MINIFIED_SAMPLE_LINES]):
            sources.append(src)  # 1行が極端に長いのは圧縮済みのファイルなので除く
    return sources


def select_files(paths, root: Path, changed, exclude):
    """(問題を報告するファイル, 読み込むファイル) を返す。"""
    if not changed:
        targets = listed_files(paths, exclude)
        return targets, targets
    targets = changed_files(root, exclude)
    return targets, targets | {p.resolve() for p in walk(root, exclude)}  # 重複は全体と比べる


def run_checks(sources, cfg):
    rep = Report(cfg)
    for src in sources:
        if src.is_target:
            (check_python if src.is_py else check_brace)(rep, src)
            for check in FILE_CHECKS:
                check(rep, src)
    check_duplicates(rep, sources)
    return sorted(rep.findings, key=lambda f: (SEVERITY_ORDER[f["severity"]], f["file"], f["line"]))


def analyze(paths, root: Path, changed=False, cfg=None):
    root = root.resolve()
    cfg = cfg or load_config(root)
    targets, files = select_files(paths, root, changed, cfg["exclude"])
    sources = load_sources(files, targets, root)
    findings = run_checks(sources, cfg)
    pre = preflight(root, cfg["exclude"])
    result = decide(findings, pre)
    result.update(files_checked=sum(1 for s in sources if s.is_target), preflight=pre, findings=findings)
    return result


# ---------------------------------------------------------------- 出力

VERDICT_LABEL = {"act": "ACT(今すぐ直す)", "suggest": "SUGGEST(提案する)", "skip": "SKIP(直さない)"}


def _header_lines(result):
    pre, counts = result["preflight"], result["counts"]
    tests = f"{pre['test_files']} ファイル" if pre["test_files"] else "なし"
    uncommitted = f"{pre['uncommitted_changes']} 件" if pre["git_repo"] else "不明(git 管理外)"
    return [
        "== リファクタリング判定 ==",
        f"調べたファイル: {result['files_checked']}",
        f"事前確認: テスト {tests} / コミットしていない変更 {uncommitted}",
        f"判定: {VERDICT_LABEL[result['verdict']]}  high {counts['high']} / medium {counts['medium']} / low {counts['low']}",
        f"理由: {result['reason']}",
    ]


def _finding_lines(findings, show_all):
    shown = [f for f in findings if show_all or f["severity"] != "low"]
    lines = [""] if shown else []
    for f in shown:
        lines.append(f"[{f['severity']}] {f['file']}:{f['line']}  {f['catalog_id']} {f['title']}")
        lines.append(f"        {f['message']}")
    hidden = len(findings) - len(shown)
    if hidden:
        lines.append(f"\nlow が {hidden} 件ある(--all で表示)")
    return lines


def _step_lines(steps):
    if not steps:
        return []
    return ["\n次にやること:"] + [f"  {i}. {s}" for i, s in enumerate(steps, 1)]


def render(result, show_all=False):
    lines = _header_lines(result) + _finding_lines(result["findings"], show_all) + _step_lines(result["next_steps"])
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description="リファクタリングを始めるべきかどうかを判定する")
    parser.add_argument("paths", nargs="*", help="調べるファイルやフォルダ(省略すると今のフォルダ)")
    parser.add_argument("--changed", action="store_true", help="git で変更したファイルだけを調べる")
    parser.add_argument("--root", default=".", help="プロジェクトの一番上のフォルダ")
    parser.add_argument("--json", action="store_true", help="JSON で出力する")
    parser.add_argument("--all", action="store_true", help="low の項目も表示する")
    parser.add_argument("--fail-on", choices=["never", "act", "suggest"], default="never",
                        help="この判定以上なら終了コード 1 を返す(CI やフック用)")
    args = parser.parse_args(argv)

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    root = Path(args.root)
    if args.changed and git(root, "rev-parse", "--git-dir") is None:
        sys.stderr.write("--changed は git のリポジトリの中でだけ使えます\n")
        return 2

    try:
        result = analyze(args.paths, root, changed=args.changed)
    except GitError as e:
        sys.stderr.write(f"変更したファイルを調べられません: {e}\n")
        return 2
    sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n" if args.json
                     else render(result, args.all))

    rank = {"skip": 0, "suggest": 1, "act": 2}
    if args.fail_on != "never" and rank[result["verdict"]] >= rank[args.fail_on]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

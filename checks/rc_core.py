"""ファイルの読み込みと、見つけた問題の記録。"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from rc_rules import BRACE_EXT, CATALOG, IGNORE_MARK, PY_EXT, RE_PY_CLI, SKIP_DIRS

# ---------------------------------------------------------------- 読み込み


def _blank(s):
    return "".join("\n" if ch == "\n" else " " for ch in s)


def _quote_at(text, i, is_py):
    """i の位置から文字列が始まるなら、その引用符を返す。"""
    c = text[i]
    if c in "\"'":
        return c * 3 if is_py and text.startswith(c * 3, i) else c
    return c if c == "`" and not is_py else ""


def _string_end(text, i, quote):
    """閉じる引用符の位置を返す(閉じていなければ行末か文末)。"""
    multiline = len(quote) == 3 or quote == "`"
    j, n = i + len(quote), len(text)
    while j < n and not text.startswith(quote, j):
        if text[j] == "\n" and not multiline:
            break
        j += 2 if text[j] == "\\" else 1
    return min(j, n)


def _end_of(text, i, marker, keep):
    """i 以降で marker が現れる位置を返す。keep が真なら marker の後ろまで含める。"""
    j = text.find(marker, i)
    if j == -1:
        return len(text)
    return j + len(marker) if keep else j


def _starts_line_comment(text, i, is_py):
    return text[i] == "#" if is_py else text.startswith("//", i)


def sanitize(text: str, is_py: bool):
    """文字列の中身とコメントを空白に置き換える(長さと行数は変えない)。

    戻り値: (置き換えた後のコード, コメントの一覧 [(行番号, 本文, 行コメントか)])
    """
    out, comments = [], []
    i, line = 0, 1
    while i < len(text):
        quote = _quote_at(text, i, is_py)
        if quote:
            j = _string_end(text, i, quote)
            tail = quote if text.startswith(quote, j) else ""
            piece = quote + _blank(text[i + len(quote):j]) + tail
            j += len(tail)
        elif _starts_line_comment(text, i, is_py):
            j = _end_of(text, i, "\n", keep=False)
            comments.append((line, text[i:j].lstrip("#/ ").rstrip(), True))
            piece = " " * (j - i)
        elif not is_py and text.startswith("/*", i):
            j = _end_of(text, i + 2, "*/", keep=True)
            comments += [(line + k, part.strip("/* \t"), False) for k, part in enumerate(text[i:j].split("\n"))]
            piece = _blank(text[i:j])
        else:
            j, piece = i + 1, text[i]
        out.append(piece)
        line += piece.count("\n")
        i = j
    return "".join(out), comments


def is_test_path(rel: str) -> bool:
    parts = rel.replace("\\", "/").lower().split("/")
    name = parts[-1]
    if any(p in ("test", "tests", "__tests__", "spec", "specs") for p in parts[:-1]):
        return True
    return (name.startswith("test_") or "_test." in name or ".test." in name
            or ".spec." in name or name.startswith("test."))


class Source:
    def __init__(self, path: Path, root: Path, is_target: bool):
        self.path = path
        try:
            self.rel = path.relative_to(root).as_posix()
        except ValueError:
            self.rel = path.as_posix()
        self.is_target = is_target
        self.ext = path.suffix.lower()
        self.is_py = self.ext in PY_EXT
        self.is_test = is_test_path(self.rel)
        self.text = path.read_text(encoding="utf-8", errors="replace")
        self.lines = self.text.split("\n")
        self.code, self.comments = sanitize(self.text, self.is_py)
        self.code_lines = self.code.split("\n")
        self.is_cli = self.is_py and bool(RE_PY_CLI.search(self.text))


def wanted(path: Path) -> bool:
    return path.suffix.lower() in (PY_EXT | BRACE_EXT)


def walk(root: Path, exclude):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            p = Path(dirpath) / name
            if wanted(p) and not any(x in p.as_posix() for x in exclude):
                yield p


def git(root: Path, *args):
    try:
        r = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


# ---------------------------------------------------------------- 検出


class Report:
    def __init__(self, cfg):
        self.cfg = cfg
        self.findings = []
        self.chain = re.compile(r"(?:\.[\w$]+\(\s*\)){%d,}" % (cfg["max_chain_calls"] + 1))

    def add(self, check, severity, at, message, *, name=""):
        """at は (ファイル, 行番号)。"""
        src, line = at
        raw = src.lines[line - 1] if 0 < line <= len(src.lines) else ""
        if IGNORE_MARK in raw:
            return
        cid, title, action = CATALOG[check]
        self.findings.append({
            "check": check, "catalog_id": cid, "title": title, "severity": severity,
            "file": src.rel, "line": line, "name": name, "message": message, "action": action,
        })


def level(value, limit):
    """上限を超えたら medium、2倍を超えたら high。"""
    return "high" if value > limit * 2 else "medium"


# (検出名, 関数の情報のキー, 設定のキー, 文, 2倍を超えたら high にするか)
FUNCTION_METRICS = (
    ("long-function", "length", "max_function_lines", "が {v} 行ある(目安 {m} 行まで)", True),
    ("deep-nesting", "depth", "max_nesting", "の入れ子が {v} 段ある(目安 {m} 段まで)", True),
    ("complexity", "complexity", "max_complexity", "の分岐が {v} 個ある(目安 {m} 個まで)", True),
    ("long-params", "params", "max_params", "の引数が {v} 個ある(目安 {m} 個まで)", False),
    ("branch-chain", "branches", "max_branches", "に {v} 分岐の if-else の列がある(目安 {m} 分岐まで)", False),
)


def check_function_metrics(rep, src, fn):
    """fn: name, line, length, params, depth, complexity, branches, flags を持つ辞書。"""
    label = f"関数 {fn['name']}"
    for check, key, limit_key, sentence, can_be_high in FUNCTION_METRICS:
        value, limit = fn[key], rep.cfg[limit_key]
        if value > limit:
            severity = level(value, limit) if can_be_high else "medium"
            rep.add(check, severity, (src, fn["line"]), f"{label} " + sentence.format(v=value, m=limit), name=fn["name"])
    if fn["flags"] and not src.is_test:
        rep.add("flag-param", "low", (src, fn["line"]),
                f"{label} が true/false の引数({', '.join(fn['flags'])})で動きを切り替えている", name=fn["name"])

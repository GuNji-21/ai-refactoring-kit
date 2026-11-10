"""波かっこを使う言語(JS/TS/Java/Go/C#/Kotlin)の検出。文字の並びから推測する。"""
import re

from rc_core import check_function_metrics
from rc_rules import (CONTEXT_CHARS, CONTROL_WORDS, FUNC_WORDS, RE_BRANCH_TOKEN, RE_ELSE_IF,
                      RE_EMPTY_CATCH, RE_EMPTY_PROMISE_CATCH, RE_FLAG_PARAM, RE_TOP_LEVEL_MUTABLE)

# ---- 波かっこの言語(JS/TS/Java/Go/C#/Kotlin。文字の並びから推測する)


def _split_params(text):
    parts, depth, current = [], 0, []
    for ch in text:
        if ch in "([{<":
            depth += 1
        elif ch in ")]}>":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return [p.strip() for p in parts if p.strip()]


def _matching_open(text, close):
    depth = 0
    for i in range(close, -1, -1):
        if text[i] == ")":
            depth += 1
        elif text[i] == "(":
            depth -= 1
            if depth == 0:
                return i
    return -1


RE_ARROW_PARENS = re.compile(r"\)\s*(?::\s*[^=(){};]+)?$")
RE_LAST_WORD = re.compile(r"[\w$]+$")
RE_ARROW_NAME = re.compile(r"([\w$]+)\s*(?::[^=,;(){}\n]*)?[:=]\s*(?:async\s*)?$")
RE_FUNCTION_NAME = re.compile(r"([\w$]+)\s*[:=]\s*(?:async\s+)?$")
RE_BLOCK_KEYWORD_END = re.compile(r"\b(?:else|try|do|finally)$")
RE_CONTROL_LINE = re.compile(r"\s*(?:\}\s*else\s+)?(if|for|while|switch|select)\b(.*)")
RE_INLINE_FUNCTION = re.compile(r"\bfunction\b|\bfunc\s*\(|=>")
RE_PARENS_BEFORE_BRACE = re.compile(
    r"\)\s*(?::\s*[^=(){};]+|throws\s+[\w.,\s]+|\([^()]*\)|[\w.*\[\]<>,\s]+)?$")
RE_WORD_BEFORE_PARENS = re.compile(r"([\w$]+)\s*(?:<[^<>]*>)?$")
NOT_FUNCTION_WORDS = ("return", "new", "await", "typeof")
ANONYMOUS = "(無名関数)"

# '{' の種類: (種類, 名前, 引数の文字列, 見出しの開始位置)
OTHER = ("other", "", "", 0)
CONTROL = ("control", "", "", 0)


def _name_from(head, regex):
    """`name = ` や `name: ` の形で付けられた名前を取り出す。"""
    found = regex.search(head)
    return found.group(1) if found else ANONYMOUS


def _classify_arrow(pre, start):
    """`(a, b) => {` や `x => {` の形。"""
    before = pre[:-len("=>")].rstrip()
    parens = RE_ARROW_PARENS.search(before)
    if parens:
        open_at = _matching_open(before, parens.start())
        params = before[open_at + 1:parens.start()]
    else:
        single = RE_LAST_WORD.search(before)
        open_at = single.start() if single else -1
        params = single.group(0) if single else ""
    if open_at < 0:
        return OTHER
    return ("func", _name_from(before[:open_at], RE_ARROW_NAME), params, start + open_at)


def _is_control(pre):
    """`else {` `try {` や、かっこを使わない `if x {`(Go など)の形。"""
    if RE_BLOCK_KEYWORD_END.search(pre):
        return True
    keyword = RE_CONTROL_LINE.match(pre.rsplit("\n", 1)[-1])
    return bool(keyword) and not RE_INLINE_FUNCTION.search(keyword.group(2))


def _classify_parens(pre, start):
    """`名前(...) {` の形。名前が if などなら制御構文、それ以外は関数。"""
    parens = RE_PARENS_BEFORE_BRACE.search(pre)
    open_at = _matching_open(pre, parens.start()) if parens else -1
    if open_at < 0:
        return OTHER
    head = pre[:open_at].rstrip()
    found = RE_WORD_BEFORE_PARENS.search(head)
    word = found.group(1) if found else ""
    if word in CONTROL_WORDS:
        return CONTROL
    if not word or word in NOT_FUNCTION_WORDS:
        return OTHER
    name = _name_from(head[:found.start()], RE_FUNCTION_NAME) if word in FUNC_WORDS else word
    return ("func", name, pre[open_at + 1:parens.start()], start + open_at)


def _classify_brace(code, pos):
    """pos にある '{' が、関数・制御構文・その他のどれの始まりかを返す。"""
    start = max(0, pos - CONTEXT_CHARS)
    pre = code[start:pos].rstrip()
    if pre.endswith("=>"):
        return _classify_arrow(pre, start)
    if _is_control(pre):
        return CONTROL
    return _classify_parens(pre, start)


def _enclosing_function(stack):
    """いちばん内側の関数と、そこから数えた制御構文の数を返す。"""
    controls = 0
    for entry in reversed(stack):
        if entry["kind"] == "func":
            return entry, controls
        if entry["kind"] == "control":
            controls += 1
    return None, controls


def _open_brace(code, pos, line, stack):
    kind, name, params, head_at = _classify_brace(code, pos)
    entry = {"kind": kind}
    if kind == "func":
        entry.update(name=name, params=_split_params(params), start=pos, depth=0, children=[],
                     line=line - code.count("\n", head_at, pos))
    elif kind == "control":
        func, controls = _enclosing_function(stack)
        if func:
            func["depth"] = max(func["depth"], controls + 1)
    stack.append(entry)


def _close_brace(pos, line, stack, funcs):
    entry = stack.pop()
    if entry["kind"] != "func":
        return
    entry.update(end=pos, end_line=line)
    funcs.append(entry)
    parent, _ = _enclosing_function(stack)
    if parent:
        parent["children"].append(entry)


def scan_braces(code):
    """関数の一覧と、各行の先頭での入れ子の深さを返す。"""
    funcs, stack, depth_at_line = [], [], [0]
    line = 1
    for pos, ch in enumerate(code):
        if ch == "\n":
            line += 1
            depth_at_line.append(len(stack))
        elif ch == "{":
            _open_brace(code, pos, line, stack)
        elif ch == "}" and stack:
            _close_brace(pos, line, stack, funcs)
    return funcs, depth_at_line


def _own_count(regex, code, f):
    """関数 f の中の出現数。入れ子の関数のぶんは除く。"""
    total = len(regex.findall(code, f["start"], f["end"]))
    return total - sum(len(regex.findall(code, c["start"], c["end"])) for c in f["children"])


def _flag_names(params):
    return [re.split(r"[\s:=?]", p)[0] or p for p in params if RE_FLAG_PARAM.search(p)]


def _branches(else_ifs):
    """else if の数から、if-else の列の分岐の数を出す(最初の if と最後の else を足す)。"""
    return else_ifs + len(("if", "else")) if else_ifs else 0


def _check_functions(rep, src, funcs):
    for f in funcs:
        check_function_metrics(rep, src, {
            "name": f["name"], "line": f["line"], "length": f["end_line"] - f["line"] + 1,
            "params": len(f["params"]), "depth": f["depth"],
            "complexity": 1 + _own_count(RE_BRANCH_TOKEN, src.code, f),
            "branches": _branches(_own_count(RE_ELSE_IF, src.code, f)),
            "flags": _flag_names(f["params"]),
        })


def _check_empty_catch(rep, src):
    for regex in (RE_EMPTY_CATCH, RE_EMPTY_PROMISE_CATCH):
        for found in regex.finditer(src.code):
            rep.add("swallowed-error", "high", (src, src.code.count("\n", 0, found.start()) + 1),
                    "catch の中が空で、エラーが起きても何も残らない")


def _check_top_level_mutable(rep, src, depth_at_line):
    for i, line in enumerate(src.code_lines):
        if depth_at_line[i] == 0 and RE_TOP_LEVEL_MUTABLE.match(line):
            rep.add("global-state", "medium", (src, i + 1),
                    "ファイルの一番外側に、書き換えられる変数(let / var)がある")


def check_brace(rep, src):
    funcs, depth_at_line = scan_braces(src.code)
    _check_functions(rep, src, funcs)
    _check_empty_catch(rep, src)
    _check_top_level_mutable(rep, src, depth_at_line)

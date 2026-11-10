"""行ごとの検出と、ファイルをまたぐ重複の検出。どの言語でも共通。"""
import re

from rc_core import level
from rc_rules import (IGNORE_MARK, RE_ANY_PY, RE_ANY_TS, RE_COMMENTED_CODE, RE_CONST_DEF, RE_DEBUG_BRACE,
                      RE_DEBUG_PY, RE_IMPORT, RE_LOGICAL_BRACE, RE_LOGICAL_PY, RE_NUMBER, RE_SECRET,
                      RE_SECRET_PLACEHOLDER, RE_SUPPRESS, RE_TODO, TS_EXT)

# ---- 行ごとの検出(どの言語でも共通)


def check_file_length(rep, src):
    limit = rep.cfg["max_file_lines"]
    total = len(src.lines) - (1 if src.lines and src.lines[-1] == "" else 0)
    if total > limit:
        rep.add("long-file", level(total, limit), (src, 1), f"ファイルが {total} 行ある(目安 {limit} 行まで)")


def _rule_condition(rep, src, n, code):
    limit = rep.cfg["max_condition_operators"]
    count = len((RE_LOGICAL_PY if src.is_py else RE_LOGICAL_BRACE).findall(code))
    if count > limit:
        rep.add("long-condition", "medium" if count > limit * 2 else "low", (src, n),
                f"1行の条件に and / or が {count} 個ある")


def _rule_chain(rep, src, n, code):
    if rep.chain.search(code):
        rep.add("call-chain", "low", (src, n), "オブジェクトの中身を何段もたどって呼び出している")


def _rule_any(rep, src, n, code):
    regex = RE_ANY_PY if src.is_py else RE_ANY_TS if src.ext in TS_EXT else None
    if regex and regex.search(code):
        rep.add("type-escape", "medium", (src, n), "何でも入る型(any)で型の確認を止めている")


def _rule_debug(rep, src, n, code):
    if src.is_test or (src.is_cli and "print(" in code):
        return
    if (RE_DEBUG_PY if src.is_py else RE_DEBUG_BRACE).search(code):
        rep.add("debug-output", "low", (src, n), "確認用の出力が残っている")


def _rule_secret(rep, src, n, code):
    found = None if src.is_test else RE_SECRET.search(src.lines[n - 1])
    if found and not RE_SECRET_PLACEHOLDER.search(found.group(1)):
        rep.add("secret", "high", (src, n), "鍵やパスワードらしい値がコードに直接書かれている")


LINE_RULES = (_rule_condition, _rule_chain, _rule_any, _rule_debug, _rule_secret)


def check_code_lines(rep, src):
    for i, code in enumerate(src.code_lines):
        if code.strip():
            for rule in LINE_RULES:
                rule(rep, src, i + 1, code)


def _unexplained_numbers(src, i, allowed):
    code = src.code_lines[i]
    if RE_CONST_DEF.match(code) or RE_IMPORT.match(code) or IGNORE_MARK in src.lines[i]:
        return []
    return [x for x in RE_NUMBER.findall(code) if x not in allowed]


def check_magic_numbers(rep, src):
    if src.is_test:
        return
    allowed, limit = set(rep.cfg["allowed_numbers"]), rep.cfg["max_magic_per_file"]
    found = ((i + 1, _unexplained_numbers(src, i, allowed)) for i in range(len(src.code_lines)))
    hits = [(n, numbers) for n, numbers in found if numbers]
    for n, numbers in hits[:limit]:
        rep.add("magic-number", "low", (src, n),
                f"説明のない数字 {', '.join(dict.fromkeys(numbers))} が直接書かれている")
    if len(hits) > limit:
        rep.add("magic-number", "low", (src, hits[limit][0]), f"説明のない数字がほかに {len(hits) - limit} 行ある")


def check_comments(rep, src):
    for n, body, _ in src.comments:
        todo = RE_TODO.search(body)
        if todo:
            rep.add("todo", "low", (src, n), f"{todo.group(1)} が残っている: {body[:60]}")
        if RE_SUPPRESS.search(body):
            rep.add("type-escape", "medium", (src, n), "型の確認や警告を止めるコメントがある")


def check_commented_code(rep, src):
    code_like = [n for n, body, is_line in src.comments if is_line and RE_COMMENTED_CODE.match(body)]
    run = []
    for n in code_like + [0]:  # 最後の 0 は、残りを書き出すための目印
        if run and n != run[-1] + 1:
            if len(run) >= 2:
                rep.add("commented-code", "low", (src, run[0]), f"コメントにされたコードが {len(run)} 行ある")
            run = []
        run.append(n)


FILE_CHECKS = (check_file_length, check_code_lines, check_magic_numbers, check_comments, check_commented_code)


# ---- 重複(ファイルをまたいで調べる)

MIN_ROW_CHARS = 4      # これより短い行(かっこだけの行など)は比べない
HIGH_DUPLICATE_RATIO = 3   # 最小の行数の何倍から high にするか


def _rows(src):
    """比べる行 [(行番号, 空白をそろえた中身)]。テスト、import、記号だけの行は除く。"""
    if src.is_test:
        return []
    rows = []
    for i, code in enumerate(src.code_lines):
        s = re.sub(r"\s+", " ", code.strip())
        if len(s) >= MIN_ROW_CHARS and not RE_IMPORT.match(s) and re.search(r"\w", s):
            rows.append((i + 1, s))
    return rows


def _index_windows(all_rows, size):
    """size 行のかたまりごとに、現れる場所 [(ファイル番号, かたまり番号)] を集める。"""
    index = {}
    for si, rows in enumerate(all_rows):
        for w in range(len(rows) - size + 1):
            key = "\n".join(s for _, s in rows[w:w + size])
            index.setdefault(key, []).append((si, w))
    return index


def _mark_copies(index, size):
    """2回目以降に現れたかたまりを、最初の場所と結びつける。

    戻り値: {ファイル番号: {かたまり番号: 最初の場所}}
    """
    marked = {}
    for locations in index.values():
        first = locations[0]
        for si, w in locations[1:]:
            overlaps_first = si == first[0] and w - first[1] < size
            if not overlaps_first:
                marked.setdefault(si, {})[w] = first
    return marked


def _runs(numbers):
    """連続する番号をまとめる。[3, 4, 5, 9] -> [(3, 5), (9, 9)]"""
    runs = []
    for n in sorted(numbers):
        if runs and n == runs[-1][1] + 1:
            runs[-1] = (runs[-1][0], n)
        else:
            runs.append((n, n))
    return runs


def check_duplicates(rep, sources):
    size = rep.cfg["duplicate_min_lines"]
    all_rows = [_rows(src) for src in sources]
    marked = _mark_copies(_index_windows(all_rows, size), size)
    for si, windows in marked.items():
        src, rows = sources[si], all_rows[si]
        for begin, end in _runs(windows):
            other_si, other_w = windows[begin]
            other = sources[other_si]
            if src.is_target or other.is_target:
                first_line = rows[begin][0]
                length = rows[end + size - 1][0] - first_line + 1
                rep.add("duplicate", "high" if length >= size * HIGH_DUPLICATE_RATIO else "medium", (src, first_line),
                        f"{length} 行が {other.rel}:{all_rows[other_si][other_w][0]} とほぼ同じ")

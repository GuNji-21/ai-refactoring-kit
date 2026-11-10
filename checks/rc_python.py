"""Python の検出。構文木を使うので正確に数えられる。"""
import ast

from rc_core import check_function_metrics

# ---- Python(構文木を使うので正確)

_PY_FUNC = (ast.FunctionDef, ast.AsyncFunctionDef)
_PY_SCOPE = _PY_FUNC + (ast.ClassDef, ast.Lambda)
_PY_TRY = tuple(t for t in (ast.Try, getattr(ast, "TryStar", None)) if t)
_PY_MATCH = getattr(ast, "Match", None)


def _own_nodes(node):
    """入れ子の関数やクラスの中には入らずに、子孫をたどる。"""
    for child in ast.iter_child_nodes(node):
        if isinstance(child, _PY_SCOPE):
            continue
        yield child
        yield from _own_nodes(child)


def _is_elif(node):
    return len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If)


def _if_blocks(s, depth):
    return [(s.body, depth + 1), (s.orelse, depth if _is_elif(s) else depth + 1)]  # elif は同じ深さ


def _loop_blocks(s, depth):
    return [(s.body, depth + 1), (s.orelse, depth + 1)]


def _try_blocks(s, depth):
    return [(body, depth + 1) for body in (s.body, s.orelse, s.finalbody, *(h.body for h in s.handlers))]


def _with_blocks(s, depth):
    return [(s.body, depth)]  # with は分岐ではないので深さに数えない


def _match_blocks(s, depth):
    return [(case.body, depth + 1) for case in s.cases]


# (文の種類, その文が持つブロックと深さを返す関数)
_BLOCKS = [
    (ast.If, _if_blocks),
    ((ast.For, ast.AsyncFor, ast.While), _loop_blocks),
    (_PY_TRY, _try_blocks),
    ((ast.With, ast.AsyncWith), _with_blocks),
]
if _PY_MATCH:
    _BLOCKS.append((_PY_MATCH, _match_blocks))


def _child_blocks(s, depth):
    for types, blocks in _BLOCKS:
        if isinstance(s, types):
            return blocks(s, depth)
    return []  # 入れ子の関数やクラスの中は、その関数自身の深さとして別に数える


def _py_depth(stmts, depth):
    deepest = depth
    for s in stmts:
        for body, d in _child_blocks(s, depth):
            if body:
                deepest = max(deepest, _py_depth(body, d))
    return deepest


def _py_complexity(func):
    total = 1
    for node in _own_nodes(func):
        if isinstance(node, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.IfExp)):
            total += 1
        elif isinstance(node, ast.BoolOp):
            total += len(node.values) - 1
        elif isinstance(node, ast.comprehension):
            total += 1 + len(node.ifs)
        elif _PY_MATCH and isinstance(node, ast.match_case):
            total += 1
    return total


def _chain_length(node):
    """if から始まる if / elif / else の列の分岐の数。"""
    length = 1
    while _is_elif(node):
        node = node.orelse[0]
        length += 1
    return length + (1 if node.orelse else 0)


def _py_longest_branch_chain(func):
    ifs = [n for n in _own_nodes(func) if isinstance(n, ast.If)]
    continued = {id(n.orelse[0]) for n in ifs if _is_elif(n)}
    return max((_chain_length(n) for n in ifs if id(n) not in continued), default=0)


def _py_function(rep, src, node):
    a = node.args
    positional = [x.arg for x in a.posonlyargs + a.args]
    with_default = positional[len(positional) - len(a.defaults):]
    flags = [name for name, value in zip(with_default, a.defaults)
             if isinstance(value, ast.Constant) and isinstance(value.value, bool)]
    check_function_metrics(rep, src, {
        "name": node.name, "line": node.lineno,
        "length": (node.end_lineno or node.lineno) - node.lineno + 1,
        "params": len([p for p in positional if p not in ("self", "cls")]),
        "depth": _py_depth(node.body, 0), "complexity": _py_complexity(node),
        "branches": _py_longest_branch_chain(node), "flags": flags,
    })


def _is_empty_statement(s):
    return isinstance(s, ast.Pass) or (
        isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and s.value.value is ...)


def _py_except(rep, src, node):
    if not all(_is_empty_statement(s) for s in node.body):
        return
    catches_all = node.type is None or (
        isinstance(node.type, ast.Name) and node.type.id in ("Exception", "BaseException"))
    rep.add("swallowed-error", "high" if catches_all else "medium", (src, node.lineno),
            "except の中が空で、エラーが起きても何も残らない"
            + ("(すべてのエラーを捨てている)" if catches_all else ""))


def _py_global(rep, src, node):
    rep.add("global-state", "medium", (src, node.lineno),
            f"関数の中から共有の変数({', '.join(node.names)})を書き換えている")


PY_HANDLERS = ((_PY_FUNC, _py_function), (ast.ExceptHandler, _py_except), (ast.Global, _py_global))


def check_python(rep, src):
    try:
        tree = ast.parse(src.text)
    except (SyntaxError, ValueError):
        return
    for node in ast.walk(tree):
        for types, handler in PY_HANDLERS:
            if isinstance(node, types):
                handler(rep, src, node)

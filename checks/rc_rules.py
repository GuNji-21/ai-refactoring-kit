"""設定の初期値、カタログとの対応、検出に使う正規表現。"""
import re

# ---------------------------------------------------------------- 設定

DEFAULTS = {
    "max_function_lines": 50,      # R01 関数の行数
    "max_nesting": 3,              # R02 入れ子の深さ
    "max_condition_operators": 2,  # R05 1行の中の && || の数
    "max_complexity": 10,          # R08 関数内の分岐の数
    "max_branches": 4,             # R09 if-else の列の長さ
    "duplicate_min_lines": 6,      # D01 重複とみなす最小の行数
    "max_params": 4,               # F01 引数の数
    "max_chain_calls": 2,          # F11 引数なしの呼び出しの連続
    "max_file_lines": 400,         # M01 ファイルの行数
    "allowed_numbers": ["0", "1", "2", "10", "100", "0.0", "1.0"],  # R04 で許す数字
    "max_magic_per_file": 5,       # R04 1ファイルで報告する上限
    "exclude": [],                 # 調べないパス(部分一致)
}

CONFIG_FILE = ".refactor-check.json"
MAX_FILE_BYTES = 1_000_000      # これより大きいファイルは調べない
MAX_LINE_CHARS = 2000           # これより長い行があれば圧縮済みとみなす
MINIFIED_SAMPLE_LINES = 50      # 圧縮済みかどうかを見る行数
CONTEXT_CHARS = 400             # '{' の手前を何文字さかのぼって見るか
IGNORE_MARK = "refactor-check: ignore"

PY_EXT = {".py"}
TS_EXT = {".ts", ".tsx"}
BRACE_EXT = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".java", ".go", ".cs", ".kt"}
SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", "out", "target", "vendor", "coverage",
    ".venv", "venv", "env", "__pycache__", ".next", ".nuxt", ".tox", ".mypy_cache",
    ".pytest_cache", "site-packages",
}

# 検出名 -> (カタログID, 名前, 直し方)
CATALOG = {
    "long-function": ("R01", "長すぎる関数", "意味のまとまりごとに関数へ切り出す"),
    "deep-nesting": ("R02", "深すぎる入れ子", "当てはまらない条件を先に return する"),
    "magic-number": ("R04", "意味不明な数字", "名前を付けた定数にする"),
    "long-condition": ("R05", "長い条件式", "条件に名前を付けて変数か関数にする"),
    "complexity": ("R08", "分岐が多すぎる関数", "判断のまとまりごとに関数を分ける"),
    "branch-chain": ("R09", "長い if-else の列", "値と結果の対応表に置き換える"),
    "duplicate": ("D01", "同じコードが複数ある", "1つの関数にまとめる"),
    "commented-code": ("D04", "コメントにされたコード", "消す(履歴に残っている)"),
    "debug-output": ("D05", "確認用の出力の消し忘れ", "消すかログの仕組みに置き換える"),
    "todo": ("D06", "放置された TODO", "今やる・課題にする・消すに分ける"),
    "long-params": ("F01", "引数が多すぎる", "関係のある引数をオブジェクトにまとめる"),
    "flag-param": ("F02", "true/false で動きを切り替える引数", "動きごとに関数を分ける"),
    "global-state": ("F06", "どこからでも書き換えられる変数", "引数で渡す形にする"),
    "type-escape": ("F09", "型の確認をすり抜けている", "正しい型を書く"),
    "call-chain": ("F11", "奥の奥まで手を伸ばしている", "手前のオブジェクトにメソッドを作る"),
    "long-file": ("M01", "大きすぎるファイル", "役割ごとにファイルを分ける"),
    "secret": ("M10", "秘密の値がコードに書かれている", "環境変数から読む。公開済みなら鍵を作り直す"),
    "swallowed-error": ("E01", "エラーを黙って捨てている", "ログを残すか、捕まえるのをやめる"),
}

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}

# ---------------------------------------------------------------- 正規表現

CONTROL_WORDS = {"if", "for", "while", "switch", "catch", "with", "foreach", "when",
                 "synchronized", "using", "lock", "select"}
FUNC_WORDS = {"function", "func", "fun"}

RE_NUMBER = re.compile(r"(?<![\w.$])\d+(?:\.\d+)?(?![\w.])")
RE_CONST_DEF = re.compile(
    r"^\s*(?:export\s+)?(?:(?:const|final|static|public|private|protected|readonly|val|var|let)\s+)*"
    r"(?:[\w<>\[\]]+\s+)?[A-Z][A-Z0-9_]+\s*(?::[^=]+)?=(?!=)"
)
RE_IMPORT = re.compile(r"^\s*(?:import|from|using|package|export\s+\*|const\s+\w+\s*=\s*require)\b")
RE_TODO = re.compile(r"\b(TODO|FIXME|HACK|XXX)\b")
RE_SUPPRESS = re.compile(
    r"type:\s*ignore|@ts-ignore|@ts-nocheck|eslint-disable|\bnoqa\b|pylint:\s*disable|\bnolint\b"
)
RE_ANY_TS = re.compile(r":\s*any\b|\bas\s+any\b|<any>")
RE_ANY_PY = re.compile(r":\s*Any\b|->\s*Any\b")
RE_DEBUG_PY = re.compile(r"^\s*(?:print\(|breakpoint\(\)|import\s+pdb\b|pdb\.set_trace\(\))")
RE_DEBUG_BRACE = re.compile(r"\bconsole\.(?:log|debug|trace)\(|^\s*debugger\b|\bSystem\.out\.print")
RE_PY_CLI = re.compile(r"__main__|\bargparse\b|\bclick\b|\btyper\b")
RE_SECRET = re.compile(
    r"(?i)\b\w*(?:password|passwd|secret|api_?key|apikey|access_?key|token)\w*[\"']?\s*[:=]\s*"
    r"[\"']([^\"'\s]{8,})[\"']"
)
RE_SECRET_PLACEHOLDER = re.compile(r"(?i)x{3,}|example|dummy|sample|changeme|your|placeholder|<|\$\{|\*{3,}")
RE_EMPTY_CATCH = re.compile(r"\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}")
RE_EMPTY_PROMISE_CATCH = re.compile(r"\.catch\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*\{\s*\}\s*\)")
RE_TOP_LEVEL_MUTABLE = re.compile(r"^(?:export\s+)?(?:let|var)\s+[\w$]+")
RE_FLAG_PARAM = re.compile(r"\b(?:boolean|bool|Boolean)\b|=\s*(?:true|false)\b")
RE_BRANCH_TOKEN = re.compile(r"\b(?:if|for|while|case|catch)\b|&&|\|\|")
RE_ELSE_IF = re.compile(r"\belse\s+if\b")
RE_LOGICAL_PY = re.compile(r"\b(?:and|or)\b")
RE_LOGICAL_BRACE = re.compile(r"&&|\|\|")
RE_COMMENTED_CODE = re.compile(
    r"^(?:"
    r"def\s+\w+\s*\(|class\s+\w+\s*[:({]|function\s*[\w$]*\s*\(|(?:const|let|var)\s+[\w$]+\s*="
    r"|import\s+[\w{*\"']|from\s+[\w.]+\s+import\b"
    r"|(?:if|for|while|elif|else|try|except)\b.*[:{]$"
    r"|[\w$.\[\]]+\s*[+\-*/]?=\s*\S.*"
    r"|[\w$.]+\(.*\)\s*;?$"
    r"|.*;$|[{}]$"
    r")"
)

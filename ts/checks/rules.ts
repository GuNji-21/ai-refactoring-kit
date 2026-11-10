/** 設定の初期値、カタログとの対応、検出に使う正規表現。 */

// ---------------------------------------------------------------- 設定

export interface Config {
  max_function_lines: number; // R01 関数の行数
  max_nesting: number; // R02 入れ子の深さ
  max_condition_operators: number; // R05 1行の中の && || の数
  max_complexity: number; // R08 関数内の分岐の数
  max_branches: number; // R09 if-else の列の長さ
  duplicate_min_lines: number; // D01 重複とみなす最小の行数
  max_params: number; // F01 引数の数
  max_chain_calls: number; // F11 引数なしの呼び出しの連続
  max_file_lines: number; // M01 ファイルの行数
  allowed_numbers: string[]; // R04 で許す数字
  max_magic_per_file: number; // R04 1ファイルで報告する上限
  exclude: string[]; // 調べないパス(部分一致)
}

export const DEFAULTS: Config = {
  max_function_lines: 50,
  max_nesting: 3,
  max_condition_operators: 2,
  max_complexity: 10,
  max_branches: 4,
  duplicate_min_lines: 6,
  max_params: 4,
  max_chain_calls: 2,
  max_file_lines: 400,
  allowed_numbers: ["0", "1", "2", "10", "100", "0.0", "1.0"],
  max_magic_per_file: 5,
  exclude: [],
};

export const CONFIG_FILE = ".refactor-check.json";
export const MAX_FILE_BYTES = 1_000_000; // これより大きいファイルは調べない
export const MAX_LINE_CHARS = 2000; // これより長い行があれば圧縮済みとみなす
export const MINIFIED_SAMPLE_LINES = 50; // 圧縮済みかどうかを見る行数
export const CONTEXT_CHARS = 400; // '{' の手前を何文字さかのぼって見るか
export const IGNORE_MARK = "refactor-check: ignore";

export const PY_EXT = new Set([".py"]);
export const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);
/** TypeScript の構文解析で調べられる拡張子 */
export const JS_TS_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
export const BRACE_EXT = new Set([...JS_TS_EXT, ".java", ".go", ".cs", ".kt"]);
export const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", "vendor", "coverage",
  ".venv", "venv", "env", "__pycache__", ".next", ".nuxt", ".tox", ".mypy_cache",
  ".pytest_cache", "site-packages",
]);

export type Severity = "high" | "medium" | "low";

// 検出名 -> [カタログID, 名前, 直し方]
export const CATALOG = {
  "long-function": ["R01", "長すぎる関数", "意味のまとまりごとに関数へ切り出す"],
  "deep-nesting": ["R02", "深すぎる入れ子", "当てはまらない条件を先に return する"],
  "magic-number": ["R04", "意味不明な数字", "名前を付けた定数にする"],
  "long-condition": ["R05", "長い条件式", "条件に名前を付けて変数か関数にする"],
  "complexity": ["R08", "分岐が多すぎる関数", "判断のまとまりごとに関数を分ける"],
  "branch-chain": ["R09", "長い if-else の列", "値と結果の対応表に置き換える"],
  "duplicate": ["D01", "同じコードが複数ある", "1つの関数にまとめる"],
  "commented-code": ["D04", "コメントにされたコード", "消す(履歴に残っている)"],
  "debug-output": ["D05", "確認用の出力の消し忘れ", "消すかログの仕組みに置き換える"],
  "todo": ["D06", "放置された TODO", "今やる・課題にする・消すに分ける"],
  "long-params": ["F01", "引数が多すぎる", "関係のある引数をオブジェクトにまとめる"],
  "flag-param": ["F02", "true/false で動きを切り替える引数", "動きごとに関数を分ける"],
  "global-state": ["F06", "どこからでも書き換えられる変数", "引数で渡す形にする"],
  "type-escape": ["F09", "型の確認をすり抜けている", "正しい型を書く"],
  "call-chain": ["F11", "奥の奥まで手を伸ばしている", "手前のオブジェクトにメソッドを作る"],
  "long-file": ["M01", "大きすぎるファイル", "役割ごとにファイルを分ける"],
  "secret": ["M10", "秘密の値がコードに書かれている", "環境変数から読む。公開済みなら鍵を作り直す"],
  "swallowed-error": ["E01", "エラーを黙って捨てている", "ログを残すか、捕まえるのをやめる"],
} as const satisfies Record<string, readonly [string, string, string]>;

export type CheckName = keyof typeof CATALOG;

export const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

// ---------------------------------------------------------------- 正規表現

export const CONTROL_WORDS = new Set(["if", "for", "while", "switch", "catch", "with", "foreach", "when",
  "synchronized", "using", "lock", "select"]);
export const FUNC_WORDS = new Set(["function", "func", "fun"]);

export const RE_NUMBER = /(?<![\w.$])\d+(?:\.\d+)?(?![\w.])/g;
export const RE_CONST_DEF = new RegExp(
  String.raw`^\s*(?:export\s+)?(?:(?:const|final|static|public|private|protected|readonly|val|var|let)\s+)*` +
  String.raw`(?:[\w<>\[\]]+\s+)?[A-Z][A-Z0-9_]+\s*(?::[^=]+)?=(?!=)`,
);
export const RE_IMPORT = /^\s*(?:import|from|using|package|export\s+\*|const\s+\w+\s*=\s*require)\b/;
export const RE_TODO = /\b(TODO|FIXME|HACK|XXX)\b/;
export const RE_SUPPRESS =
  /type:\s*ignore|@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|\bnoqa\b|pylint:\s*disable|\bnolint\b/;
export const RE_ANY_TS = /:\s*any\b|\bas\s+any\b|<any>/;
export const RE_ANY_PY = /:\s*Any\b|->\s*Any\b/;
export const RE_DEBUG_PY = /^\s*(?:print\(|breakpoint\(\)|import\s+pdb\b|pdb\.set_trace\(\))/;
export const RE_DEBUG_BRACE = /\bconsole\.(?:log|debug|trace)\(|^\s*debugger\b|\bSystem\.out\.print/;
export const RE_PY_CLI = /__main__|\bargparse\b|\bclick\b|\btyper\b/;
export const RE_SECRET = new RegExp(
  String.raw`\b\w*(?:password|passwd|secret|api_?key|apikey|access_?key|token)\w*["']?\s*[:=]\s*` +
  String.raw`["']([^"'\s]{8,})["']`,
  "i",
);
export const RE_SECRET_PLACEHOLDER = /x{3,}|example|dummy|sample|changeme|your|placeholder|<|\$\{|\*{3,}/i;
export const RE_EMPTY_CATCH = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
export const RE_EMPTY_PROMISE_CATCH = /\.catch\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*\{\s*\}\s*\)/g;
export const RE_TOP_LEVEL_MUTABLE = /^(?:export\s+)?(?:let|var)\s+[\w$]+/;
export const RE_FLAG_PARAM = /\b(?:boolean|bool|Boolean)\b|=\s*(?:true|false)\b/;
export const RE_BRANCH_TOKEN = /\b(?:if|for|while|case|catch)\b|&&|\|\|/g;
export const RE_ELSE_IF = /\belse\s+if\b/g;
export const RE_LOGICAL_PY = /\b(?:and|or)\b/g;
export const RE_LOGICAL_BRACE = /&&|\|\||\?\?/g;
export const RE_COMMENTED_CODE = new RegExp(
  "^(?:" +
  String.raw`def\s+\w+\s*\(|class\s+\w+\s*[:({]|function\s*[\w$]*\s*\(|(?:const|let|var)\s+[\w$]+\s*=` +
  String.raw`|import\s+[\w{*"']|from\s+[\w.]+\s+import\b` +
  String.raw`|(?:if|for|while|elif|else|try|except)\b.*[:{]$` +
  String.raw`|[\w$.\[\]]+\s*[+\-*/]?=\s*\S.*` +
  String.raw`|[\w$.]+\(.*\)\s*;?$` +
  String.raw`|.*;$|[{}]$` +
  ")",
);

/** 正規表現 re(g 付き)が text に何回現れるか。 */
export function countMatches(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0;
}

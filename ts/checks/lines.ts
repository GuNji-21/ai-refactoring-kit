/** 行ごとの検出と、ファイルをまたぐ重複の検出。どの言語でも共通。 */
import { level, type Report, type Source } from "./core.ts";
import {
  countMatches, IGNORE_MARK, RE_ANY_PY, RE_ANY_TS, RE_COMMENTED_CODE, RE_CONST_DEF, RE_DEBUG_BRACE, RE_DEBUG_PY,
  RE_IMPORT, RE_LOGICAL_BRACE, RE_LOGICAL_PY, RE_NUMBER, RE_SECRET, RE_SECRET_PLACEHOLDER, RE_SUPPRESS, RE_TODO,
  TS_EXT,
} from "./rules.ts";

// ---- 行ごとの検出(どの言語でも共通)

function checkFileLength(rep: Report, src: Source): void {
  const limit = rep.cfg.max_file_lines;
  const total = src.lines.length - (src.lines.at(-1) === "" ? 1 : 0);
  if (total > limit) rep.add("long-file", level(total, limit), [src, 1], `ファイルが ${total} 行ある(目安 ${limit} 行まで)`);
}

type LineRule = (rep: Report, src: Source, n: number, code: string) => void;

const ruleCondition: LineRule = (rep, src, n, code) => {
  const limit = rep.cfg.max_condition_operators;
  const count = countMatches(src.isPy ? RE_LOGICAL_PY : RE_LOGICAL_BRACE, code);
  if (count > limit) {
    rep.add("long-condition", count > limit * 2 ? "medium" : "low", [src, n], `1行の条件に and / or が ${count} 個ある`);
  }
};

const ruleChain: LineRule = (rep, src, n, code) => {
  if (rep.chain.test(code)) rep.add("call-chain", "low", [src, n], "オブジェクトの中身を何段もたどって呼び出している");
};

const ruleAny: LineRule = (rep, src, n, code) => {
  if (src.tsFile) return; // 構文解析したファイルの any は、構文木で見つける(ts-ast.ts)
  const regex = src.isPy ? RE_ANY_PY : TS_EXT.has(src.ext) ? RE_ANY_TS : null;
  if (regex?.test(code)) rep.add("type-escape", "medium", [src, n], "何でも入る型(any)で型の確認を止めている");
};

const ruleDebug: LineRule = (rep, src, n, code) => {
  if (src.isTest || (src.isCli && code.includes("print("))) return;
  if ((src.isPy ? RE_DEBUG_PY : RE_DEBUG_BRACE).test(code)) rep.add("debug-output", "low", [src, n], "確認用の出力が残っている");
};

const ruleSecret: LineRule = (rep, src, n) => {
  const found = src.isTest ? null : RE_SECRET.exec(src.lines[n - 1]);
  if (found && !RE_SECRET_PLACEHOLDER.test(found[1])) {
    rep.add("secret", "high", [src, n], "鍵やパスワードらしい値がコードに直接書かれている");
  }
};

const LINE_RULES = [ruleCondition, ruleChain, ruleAny, ruleDebug, ruleSecret];

function checkCodeLines(rep: Report, src: Source): void {
  src.codeLines.forEach((code, i) => {
    if (code.trim()) for (const rule of LINE_RULES) rule(rep, src, i + 1, code);
  });
}

function unexplainedNumbers(src: Source, i: number, allowed: Set<string>): string[] {
  const code = src.codeLines[i];
  if (RE_CONST_DEF.test(code) || RE_IMPORT.test(code) || src.lines[i].includes(IGNORE_MARK)) return [];
  return (code.match(RE_NUMBER) ?? []).filter((x) => !allowed.has(x));
}

function checkMagicNumbers(rep: Report, src: Source): void {
  if (src.isTest) return;
  const allowed = new Set(rep.cfg.allowed_numbers);
  const limit = rep.cfg.max_magic_per_file;
  const hits = src.codeLines
    .map((_, i) => [i + 1, unexplainedNumbers(src, i, allowed)] as const)
    .filter(([, numbers]) => numbers.length);
  for (const [n, numbers] of hits.slice(0, limit)) {
    rep.add("magic-number", "low", [src, n], `説明のない数字 ${[...new Set(numbers)].join(", ")} が直接書かれている`);
  }
  if (hits.length > limit) {
    rep.add("magic-number", "low", [src, hits[limit][0]], `説明のない数字がほかに ${hits.length - limit} 行ある`);
  }
}

function checkComments(rep: Report, src: Source): void {
  for (const { line, body } of src.comments) {
    const todo = RE_TODO.exec(body);
    if (todo) rep.add("todo", "low", [src, line], `${todo[1]} が残っている: ${body.slice(0, 60)}`);
    if (RE_SUPPRESS.test(body)) rep.add("type-escape", "medium", [src, line], "型の確認や警告を止めるコメントがある");
  }
}

function checkCommentedCode(rep: Report, src: Source): void {
  const codeLike = src.comments.filter((c) => c.isLine && RE_COMMENTED_CODE.test(c.body)).map((c) => c.line);
  let run: number[] = [];
  for (const n of [...codeLike, 0]) { // 最後の 0 は、残りを書き出すための目印
    if (run.length && n !== run[run.length - 1] + 1) {
      if (run.length >= 2) rep.add("commented-code", "low", [src, run[0]], `コメントにされたコードが ${run.length} 行ある`);
      run = [];
    }
    run.push(n);
  }
}

export const FILE_CHECKS = [checkFileLength, checkCodeLines, checkMagicNumbers, checkComments, checkCommentedCode];

// ---- 重複(ファイルをまたいで調べる)

const MIN_ROW_CHARS = 4; // これより短い行(かっこだけの行など)は比べない
const HIGH_DUPLICATE_RATIO = 3; // 最小の行数の何倍から high にするか

type Row = [line: number, text: string];
type Location = [file: number, window: number];

/** 比べる行。テスト、import、記号だけの行は除く。 */
function rows(src: Source): Row[] {
  if (src.isTest) return [];
  const out: Row[] = [];
  src.codeLines.forEach((code, i) => {
    const s = code.trim().replace(/\s+/g, " ");
    if (s.length >= MIN_ROW_CHARS && !RE_IMPORT.test(s) && /[\p{L}\p{N}_]/u.test(s)) out.push([i + 1, s]);
  });
  return out;
}

/** size 行のかたまりごとに、現れる場所を集める。 */
function indexWindows(allRows: Row[][], size: number): Map<string, Location[]> {
  const index = new Map<string, Location[]>();
  allRows.forEach((fileRows, si) => {
    for (let w = 0; w + size <= fileRows.length; w++) {
      const key = fileRows.slice(w, w + size).map(([, s]) => s).join("\n");
      const list = index.get(key);
      if (list) list.push([si, w]);
      else index.set(key, [[si, w]]);
    }
  });
  return index;
}

/** 2回目以降に現れたかたまりを、最初の場所と結びつける。戻り値: ファイル番号 -> かたまり番号 -> 最初の場所 */
function markCopies(index: Map<string, Location[]>, size: number): Map<number, Map<number, Location>> {
  const marked = new Map<number, Map<number, Location>>();
  for (const [first, ...rest] of index.values()) {
    for (const [si, w] of rest) {
      const overlapsFirst = si === first[0] && w - first[1] < size;
      if (overlapsFirst) continue;
      if (!marked.has(si)) marked.set(si, new Map());
      marked.get(si)!.set(w, first);
    }
  }
  return marked;
}

/** 連続する番号をまとめる。[3, 4, 5, 9] -> [[3, 5], [9, 9]] */
function runs(numbers: Iterable<number>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

export function checkDuplicates(rep: Report, sources: Source[]): void {
  const size = rep.cfg.duplicate_min_lines;
  const allRows = sources.map(rows);
  const marked = markCopies(indexWindows(allRows, size), size);
  for (const [si, windows] of marked) {
    const src = sources[si];
    const fileRows = allRows[si];
    for (const [begin, end] of runs(windows.keys())) {
      const [otherSi, otherW] = windows.get(begin)!;
      const other = sources[otherSi];
      if (!src.isTarget && !other.isTarget) continue;
      const firstLine = fileRows[begin][0];
      const length = fileRows[end + size - 1][0] - firstLine + 1;
      rep.add("duplicate", length >= size * HIGH_DUPLICATE_RATIO ? "high" : "medium", [src, firstLine],
        `${length} 行が ${other.rel}:${allRows[otherSi][otherW][0]} とほぼ同じ`);
    }
  }
}

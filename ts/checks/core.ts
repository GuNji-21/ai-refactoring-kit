/** ファイルの読み込みと、見つけた問題の記録。 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type * as TS from "typescript";

import {
  BRACE_EXT, CATALOG, type CheckName, type Config, IGNORE_MARK, JS_TS_EXT, PY_EXT, RE_PY_CLI, type Severity, SKIP_DIRS,
} from "./rules.ts";
import { type Literal, literalRanges, parseTs, type TsModule } from "./ts-parse.ts";

// ---------------------------------------------------------------- 読み込み

export interface Comment {
  line: number;
  body: string;
  isLine: boolean; // 行コメントか(ブロックコメントでないか)
}

function blank(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

/** i の位置から文字列が始まるなら、その引用符を返す。 */
function quoteAt(text: string, i: number, isPy: boolean): string {
  const c = text[i];
  if (c === '"' || c === "'") return isPy && text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
  return c === "`" && !isPy ? c : "";
}

/** 閉じる引用符の位置を返す(閉じていなければ行末か文末)。 */
function stringEnd(text: string, i: number, quote: string): number {
  const multiline = quote.length === 3 || quote === "`";
  let j = i + quote.length;
  const n = text.length;
  while (j < n && !text.startsWith(quote, j)) {
    if (text[j] === "\n" && !multiline) break;
    j += text[j] === "\\" ? 2 : 1;
  }
  return Math.min(j, n);
}

/** i 以降で marker が現れる位置を返す。keep が真なら marker の後ろまで含める。 */
function endOf(text: string, i: number, marker: string, keep: boolean): number {
  const j = text.indexOf(marker, i);
  if (j === -1) return text.length;
  return keep ? j + marker.length : j;
}

function startsLineComment(text: string, i: number, isPy: boolean): boolean {
  return isPy ? text[i] === "#" : text.startsWith("//", i);
}

const trimChars = (s: string, chars: string, side: "both" | "start" = "both"): string => {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  if (side === "both") while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
};

/** i から文字列が始まるなら [終わりの位置, 中身を空白にしたもの] を返す。文字の並びから推測する。 */
function guessedString(text: string, i: number, isPy: boolean): [number, string] | null {
  const quote = quoteAt(text, i, isPy);
  if (!quote) return null;
  const j = stringEnd(text, i, quote);
  const tail = text.startsWith(quote, j) ? quote : "";
  return [j + tail.length, quote + blank(text.slice(i + quote.length, j)) + tail];
}

/** i から構文解析で見つけた文字列などが始まるなら [終わりの位置, 中身を空白にしたもの] を返す。 */
function parsedLiteral(text: string, i: number, literals: Map<number, Literal>): [number, string] | null {
  const lit = literals.get(i);
  if (!lit) return null;
  const inner = Math.max(i + lit.head, lit.end - lit.tail);
  return [lit.end, text.slice(i, i + lit.head) + blank(text.slice(i + lit.head, inner)) + text.slice(inner, lit.end)];
}

/**
 * 文字列の中身とコメントを空白に置き換える(長さと行数は変えない)。
 * literals(構文解析で見つけた文字列・正規表現などの範囲)を渡すと、文字の並びから推測する代わりにそれを使う。
 * 戻り値: [置き換えた後のコード, コメントの一覧]
 */
export function sanitize(text: string, isPy: boolean, literals?: Map<number, Literal>): [string, Comment[]] {
  const out: string[] = [];
  const comments: Comment[] = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const literal = literals ? parsedLiteral(text, i, literals) : guessedString(text, i, isPy);
    let j: number;
    let piece: string;
    if (literal) {
      [j, piece] = literal;
    } else if (startsLineComment(text, i, isPy)) {
      j = endOf(text, i, "\n", false);
      comments.push({ line, body: trimChars(text.slice(i, j), "#/ ", "start").trimEnd(), isLine: true });
      piece = " ".repeat(j - i);
    } else if (!isPy && text.startsWith("/*", i)) {
      j = endOf(text, i + 2, "*/", true);
      text.slice(i, j).split("\n").forEach((part, k) => {
        comments.push({ line: line + k, body: trimChars(part, "/* \t\r"), isLine: false });
      });
      piece = blank(text.slice(i, j));
    } else {
      j = i + 1;
      piece = text[i];
    }
    out.push(piece);
    for (const ch of piece) if (ch === "\n") line++;
    i = j;
  }
  return [out.join(""), comments];
}

export function isTestPath(rel: string): boolean {
  const parts = rel.replaceAll("\\", "/").toLowerCase().split("/");
  const name = parts[parts.length - 1];
  if (parts.slice(0, -1).some((p) => ["test", "tests", "__tests__", "spec", "specs"].includes(p))) return true;
  return name.startsWith("test_") || name.includes("_test.") || name.includes(".test.")
    || name.includes(".spec.") || name.startsWith("test.");
}

/** 引数の並び(かっこの中身)を、一番外側の , で分ける。 */
export function splitParams(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export const toPosix = (p: string): string => p.replaceAll("\\", "/");

export function relPath(p: string, root: string): string {
  const rel = path.relative(root, p);
  return rel.startsWith("..") || path.isAbsolute(rel) ? toPosix(p) : toPosix(rel);
}

export class Source {
  readonly rel: string;
  readonly ext: string;
  readonly isPy: boolean;
  readonly isTest: boolean;
  readonly text: string;
  readonly lines: string[];
  readonly code: string;
  readonly comments: Comment[];
  readonly codeLines: string[];
  readonly isCli: boolean;
  readonly filePath: string;
  readonly isTarget: boolean;
  /** typescript で構文解析した結果。JS/TS で typescript が見つかったときだけある */
  readonly tsFile: TS.SourceFile | undefined;

  /**
   * options.text を渡すと、ファイルの代わりにそれを調べる(--staged でステージした中身を調べるとき)。
   * options.ts を渡すと、JS/TS は構文解析してから文字列やコメントを取り除く。
   */
  constructor(filePath: string, root: string, isTarget: boolean, options: { text?: string; ts?: TsModule | null } = {}) {
    this.filePath = filePath;
    this.isTarget = isTarget;
    this.rel = relPath(filePath, root);
    this.ext = path.extname(filePath).toLowerCase();
    this.isPy = PY_EXT.has(this.ext);
    this.isTest = isTestPath(this.rel);
    this.text = (options.text ?? readFileSync(filePath, "utf8")).replaceAll("\r\n", "\n");
    this.lines = this.text.split("\n");
    const ts = options.ts;
    this.tsFile = ts && JS_TS_EXT.has(this.ext) ? parseTs(ts, filePath, this.text, this.ext) : undefined;
    const literals = ts && this.tsFile ? literalRanges(ts, this.tsFile) : undefined;
    [this.code, this.comments] = sanitize(this.text, this.isPy, literals);
    this.codeLines = this.code.split("\n");
    this.isCli = this.isPy && RE_PY_CLI.test(this.text);
  }
}

export function wanted(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return PY_EXT.has(ext) || BRACE_EXT.has(ext);
}

/** 設定の exclude のどれかを、パスに含んでいるか。 */
export function isExcluded(p: string, exclude: readonly string[]): boolean {
  return exclude.some((x) => toPosix(p).includes(x));
}

export function* walk(root: string, exclude: readonly string[]): Generator<string> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(p, exclude);
    } else if (e.isFile() && wanted(p) && !isExcluded(p, exclude)) {
      yield p;
    }
  }
}

export function git(root: string, ...args: string[]): string | null {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/** git のコマンドが失敗した。 */
export class GitError extends Error {}

/**
 * git が出力したパスの一覧を返す。失敗したら GitError を投げる。
 * -z を付けて NUL 区切りで受け取る。付けないと、日本語などの名前が
 * "\345\207\246..." のように書き換えられて、ファイルを見つけられなくなる。
 */
export function gitPaths(root: string, command: string, ...args: string[]): string[] {
  const out = git(root, command, "-z", ...args);
  if (out === null) throw new GitError(`git ${command} ${args.join(" ")} が失敗しました`);
  return out.split("\0").filter(Boolean);
}

// ---------------------------------------------------------------- 検出

export interface Finding {
  check: CheckName;
  catalog_id: string;
  title: string;
  severity: Severity;
  file: string;
  line: number;
  name: string;
  message: string;
  action: string;
}

export type At = [src: Source, line: number, name?: string];

export class Report {
  readonly findings: Finding[] = [];
  readonly chain: RegExp;
  readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.chain = new RegExp(String.raw`(?:\.[\w$]+\(\s*\)){${cfg.max_chain_calls + 1},}`);
  }

  /** at は [ファイル, 行番号] か [ファイル, 行番号, 関数の名前]。 */
  add(check: CheckName, severity: Severity, at: At, message: string): void {
    const [src, line, name = ""] = at;
    const raw = line > 0 && line <= src.lines.length ? src.lines[line - 1] : "";
    if (raw.includes(IGNORE_MARK)) return;
    const [catalog_id, title, action] = CATALOG[check];
    this.findings.push({ check, catalog_id, title, severity, file: src.rel, line, name, message, action });
  }
}

/** 上限を超えたら medium、2倍を超えたら high。 */
export function level(value: number, limit: number): Severity {
  return value > limit * 2 ? "high" : "medium";
}

export interface FunctionInfo {
  name: string;
  line: number;
  length: number;
  params: number;
  depth: number;
  complexity: number;
  branches: number;
  flags: string[];
}

type MetricKey = "length" | "depth" | "complexity" | "params" | "branches";
type LimitKey = "max_function_lines" | "max_nesting" | "max_complexity" | "max_params" | "max_branches";

// [検出名, 関数の情報のキー, 設定のキー, 文, 2倍を超えたら high にするか]
const FUNCTION_METRICS: ReadonlyArray<[CheckName, MetricKey, LimitKey, string, boolean]> = [
  ["long-function", "length", "max_function_lines", "が {v} 行ある(目安 {m} 行まで)", true],
  ["deep-nesting", "depth", "max_nesting", "の入れ子が {v} 段ある(目安 {m} 段まで)", true],
  ["complexity", "complexity", "max_complexity", "の分岐が {v} 個ある(目安 {m} 個まで)", true],
  ["long-params", "params", "max_params", "の引数が {v} 個ある(目安 {m} 個まで)", false],
  ["branch-chain", "branches", "max_branches", "に {v} 分岐の if-else の列がある(目安 {m} 分岐まで)", false],
];

export function checkFunctionMetrics(rep: Report, src: Source, fn: FunctionInfo): void {
  const label = `関数 ${fn.name}`;
  for (const [check, key, limitKey, sentence, canBeHigh] of FUNCTION_METRICS) {
    const value = fn[key];
    const limit = rep.cfg[limitKey];
    if (value > limit) {
      const severity = canBeHigh ? level(value, limit) : "medium";
      const text = sentence.replace("{v}", String(value)).replace("{m}", String(limit));
      rep.add(check, severity, [src, fn.line, fn.name], `${label} ${text}`);
    }
  }
  if (fn.flags.length && !src.isTest) {
    rep.add("flag-param", "low", [src, fn.line, fn.name],
      `${label} が true/false の引数(${fn.flags.join(", ")})で動きを切り替えている`);
  }
}

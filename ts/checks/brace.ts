/**
 * 波かっこを使う言語(Java/Go/C#/Kotlin)の検出。文字の並びから推測する。
 * JS/TS も typescript が見つからないときはこちらで調べる。
 */
import { checkFunctionMetrics, type Report, type Source, splitParams } from "./core.ts";
import {
  CONTEXT_CHARS, CONTROL_WORDS, countMatches, FUNC_WORDS, RE_BRANCH_TOKEN, RE_ELSE_IF, RE_EMPTY_CATCH,
  RE_EMPTY_PROMISE_CATCH, RE_FLAG_PARAM, RE_TOP_LEVEL_MUTABLE,
} from "./rules.ts";

function matchingOpen(text: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (text[i] === ")") depth++;
    else if (text[i] === "(") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const RE_ARROW_PARENS = /\)\s*(?::\s*[^=(){};]+)?$/;
const RE_LAST_WORD = /[\w$]+$/;
const RE_ARROW_NAME = /([\w$]+)\s*(?::[^=,;(){}\n]*)?[:=]\s*(?:async\s*)?$/;
const RE_FUNCTION_NAME = /([\w$]+)\s*[:=]\s*(?:async\s+)?$/;
const RE_BLOCK_KEYWORD_END = /\b(?:else|try|do|finally)$/;
const RE_CONTROL_LINE = /^\s*(?:\}\s*else\s+)?(if|for|while|switch|select)\b(.*)/;
const RE_INLINE_FUNCTION = /\bfunction\b|\bfunc\s*\(|=>/;
const RE_PARENS_BEFORE_BRACE = /\)\s*(?::\s*[^=(){};]+|throws\s+[\w.,\s]+|\([^()]*\)|[\w.*[\]<>,\s]+)?$/;
const RE_WORD_BEFORE_PARENS = /([\w$]+)\s*(?:<[^<>]*>)?$/;
const NOT_FUNCTION_WORDS = new Set(["return", "new", "await", "typeof"]);
export const ANONYMOUS = "(無名関数)";

// '{' の種類: [種類, 名前, 引数の文字列, 見出しの開始位置]
type Kind = "func" | "control" | "other";
type Classified = [Kind, string, string, number];
const OTHER: Classified = ["other", "", "", 0];
const CONTROL: Classified = ["control", "", "", 0];

/** `name = ` や `name: ` の形で付けられた名前を取り出す。 */
function nameFrom(head: string, regex: RegExp): string {
  return regex.exec(head)?.[1] ?? ANONYMOUS;
}

/** `(a, b) => {` や `x => {` の形。 */
function classifyArrow(pre: string, start: number): Classified {
  const before = pre.slice(0, -"=>".length).trimEnd();
  const parens = RE_ARROW_PARENS.exec(before);
  let openAt: number;
  let params: string;
  if (parens) {
    openAt = matchingOpen(before, parens.index);
    params = before.slice(openAt + 1, parens.index);
  } else {
    const single = RE_LAST_WORD.exec(before);
    openAt = single ? single.index : -1;
    params = single ? single[0] : "";
  }
  if (openAt < 0) return OTHER;
  return ["func", nameFrom(before.slice(0, openAt), RE_ARROW_NAME), params, start + openAt];
}

/** `else {` `try {` や、かっこを使わない `if x {`(Go など)の形。 */
function isControl(pre: string): boolean {
  if (RE_BLOCK_KEYWORD_END.test(pre)) return true;
  const lastLine = pre.slice(pre.lastIndexOf("\n") + 1);
  const keyword = RE_CONTROL_LINE.exec(lastLine);
  return keyword !== null && !RE_INLINE_FUNCTION.test(keyword[2]);
}

/** `名前(...) {` の形。名前が if などなら制御構文、それ以外は関数。 */
function classifyParens(pre: string, start: number): Classified {
  const parens = RE_PARENS_BEFORE_BRACE.exec(pre);
  const openAt = parens ? matchingOpen(pre, parens.index) : -1;
  if (!parens || openAt < 0) return OTHER;
  const head = pre.slice(0, openAt).trimEnd();
  const found = RE_WORD_BEFORE_PARENS.exec(head);
  const word = found ? found[1] : "";
  if (CONTROL_WORDS.has(word)) return CONTROL;
  if (!found || !word || NOT_FUNCTION_WORDS.has(word)) return OTHER;
  const name = FUNC_WORDS.has(word) ? nameFrom(head.slice(0, found.index), RE_FUNCTION_NAME) : word;
  return ["func", name, pre.slice(openAt + 1, parens.index), start + openAt];
}

/** pos にある '{' が、関数・制御構文・その他のどれの始まりかを返す。 */
function classifyBrace(code: string, pos: number): Classified {
  const start = Math.max(0, pos - CONTEXT_CHARS);
  const pre = code.slice(start, pos).trimEnd();
  if (pre.endsWith("=>")) return classifyArrow(pre, start);
  if (isControl(pre)) return CONTROL;
  return classifyParens(pre, start);
}

interface FuncEntry {
  kind: "func";
  name: string;
  params: string[];
  start: number;
  end: number;
  line: number;
  endLine: number;
  depth: number;
  children: FuncEntry[];
}
type Entry = FuncEntry | { kind: "control" | "other" };

/** いちばん内側の関数と、そこから数えた制御構文の数を返す。 */
function enclosingFunction(stack: Entry[]): [FuncEntry | null, number] {
  let controls = 0;
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i];
    if (entry.kind === "func") return [entry, controls];
    if (entry.kind === "control") controls++;
  }
  return [null, controls];
}

function countNewlines(code: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (code[i] === "\n") n++;
  return n;
}

function openBrace(code: string, pos: number, line: number, stack: Entry[]): void {
  const [kind, name, params, headAt] = classifyBrace(code, pos);
  if (kind === "func") {
    stack.push({
      kind, name, params: splitParams(params), start: pos, end: pos, depth: 0, children: [],
      line: line - countNewlines(code, headAt, pos), endLine: line,
    });
    return;
  }
  if (kind === "control") {
    const [func, controls] = enclosingFunction(stack);
    if (func) func.depth = Math.max(func.depth, controls + 1);
  }
  stack.push({ kind });
}

function closeBrace(pos: number, line: number, stack: Entry[], funcs: FuncEntry[]): void {
  const entry = stack.pop();
  if (entry?.kind !== "func") return;
  entry.end = pos;
  entry.endLine = line;
  funcs.push(entry);
  const [parent] = enclosingFunction(stack);
  parent?.children.push(entry);
}

/** 関数の一覧と、各行の先頭での入れ子の深さを返す。 */
export function scanBraces(code: string): [FuncEntry[], number[]] {
  const funcs: FuncEntry[] = [];
  const stack: Entry[] = [];
  const depthAtLine = [0];
  let line = 1;
  for (let pos = 0; pos < code.length; pos++) {
    const ch = code[pos];
    if (ch === "\n") {
      line++;
      depthAtLine.push(stack.length);
    } else if (ch === "{") {
      openBrace(code, pos, line, stack);
    } else if (ch === "}" && stack.length) {
      closeBrace(pos, line, stack, funcs);
    }
  }
  return [funcs, depthAtLine];
}

/** 関数 f の中の出現数。入れ子の関数のぶんは除く。 */
function ownCount(regex: RegExp, code: string, f: FuncEntry): number {
  const total = countMatches(regex, code.slice(f.start, f.end));
  return total - f.children.reduce((sum, c) => sum + countMatches(regex, code.slice(c.start, c.end)), 0);
}

function flagNames(params: string[]): string[] {
  return params.filter((p) => RE_FLAG_PARAM.test(p)).map((p) => p.split(/[\s:=?]/)[0] || p);
}

/** else if の数から、if-else の列の分岐の数を出す(最初の if と最後の else を足す)。 */
function branches(elseIfs: number): number {
  return elseIfs ? elseIfs + 2 : 0;
}

function lineOf(code: string, index: number): number {
  return countNewlines(code, 0, index) + 1;
}

export function checkBrace(rep: Report, src: Source): void {
  const [funcs, depthAtLine] = scanBraces(src.code);
  for (const f of funcs) {
    checkFunctionMetrics(rep, src, {
      name: f.name, line: f.line, length: f.endLine - f.line + 1,
      params: f.params.length, depth: f.depth,
      complexity: 1 + ownCount(RE_BRANCH_TOKEN, src.code, f),
      branches: branches(ownCount(RE_ELSE_IF, src.code, f)),
      flags: flagNames(f.params),
    });
  }
  for (const regex of [RE_EMPTY_CATCH, RE_EMPTY_PROMISE_CATCH]) {
    for (const found of src.code.matchAll(regex)) {
      rep.add("swallowed-error", "high", [src, lineOf(src.code, found.index)],
        "catch の中が空で、エラーが起きても何も残らない");
    }
  }
  src.codeLines.forEach((line, i) => {
    if (depthAtLine[i] === 0 && RE_TOP_LEVEL_MUTABLE.test(line)) {
      rep.add("global-state", "medium", [src, i + 1], "ファイルの一番外側に、書き換えられる変数(let / var)がある");
    }
  });
}

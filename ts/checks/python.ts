/**
 * Python の検出。字下げから関数とブロックの範囲を推測する。
 * (Python 版のキットは構文木を使うが、Node から Python の構文木は作れないので字下げで代用する)
 */
import { checkFunctionMetrics, type Report, type Source, splitParams } from "./core.ts";
import { countMatches } from "./rules.ts";

/** 1つの文。かっこの中や \ で折り返した行は1つにまとめる。 */
interface Stmt {
  line: number; // 始まりの行番号
  endLine: number; // 終わりの行番号
  indent: number;
  text: string; // 前後の空白を除き、折り返しをつないだ中身
}

function logicalLines(codeLines: string[]): Stmt[] {
  const stmts: Stmt[] = [];
  let current: Stmt | null = null;
  let depth = 0;
  codeLines.forEach((raw, i) => {
    const stripped = raw.trim();
    if (!current) {
      if (!stripped) return;
      current = { line: i + 1, endLine: i + 1, indent: raw.length - raw.trimStart().length, text: stripped };
    } else {
      current.text += " " + stripped;
      current.endLine = i + 1;
    }
    for (const ch of raw) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && !raw.trimEnd().endsWith("\\")) {
      stmts.push(current);
      current = null;
    }
  });
  if (current) stmts.push(current);
  return stmts;
}

const RE_DEF = /^(?:async\s+)?def\s+(\w+)\s*\(/;
const RE_CLASS = /^class\b/;
const RE_KEYWORD = /^(?:async\s+)?(if|elif|else|for|while|try|except|finally|with|match|case)\b/;
const RE_BRANCH = /\b(?:if|elif|for|while|except)\b|\b(?:and|or)\b/g;
const RE_GLOBAL = /^global\s+(.+)$/;
const RE_EXCEPT = /^except\b\s*(.*?)\s*(?:as\s+\w+\s*)?:(.*)$/;
/** 入れ子の深さに数えるブロック。with と match は数えない(Python 版と同じ) */
const DEPTH_KEYWORDS = new Set(["if", "elif", "else", "for", "while", "try", "except", "finally", "case"]);

/** stmts[i] が始めるブロックの終わり(含まない)。 */
function blockEnd(stmts: Stmt[], i: number): number {
  let j = i + 1;
  while (j < stmts.length && stmts[j].indent > stmts[i].indent) j++;
  return j;
}

/** `if x: return` のように、コロンの後ろに中身が続いているか。 */
function hasInlineBody(text: string): boolean {
  const colon = text.lastIndexOf(":");
  return colon >= 0 && colon < text.length - 1 && !text.endsWith(":");
}

/** 最初の ( から、対応する ) の手前までを返す。 */
function insideParens(text: string): string {
  const open = text.indexOf("(");
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if ("([{".includes(text[k])) depth++;
    else if (")]}".includes(text[k]) && --depth === 0) return text.slice(open + 1, k);
  }
  return text.slice(open + 1);
}

/** 名前のある引数。キーワード専用の引数(* の後ろ)も含め、*args と **kwargs と区切りの / * は除く(Python 版と同じ) */
function namedParams(params: string[]): string[] {
  return params.filter((p) => p !== "/" && !p.startsWith("*"));
}

const paramName = (p: string) => p.split(/[\s:=]/)[0];

/** 関数の中の文。入れ子の関数やクラスの中身は除く。 */
function ownStatements(stmts: Stmt[], start: number, end: number): Stmt[] {
  const own: Stmt[] = [];
  for (let k = start; k < end; k++) {
    own.push(stmts[k]);
    if (RE_DEF.test(stmts[k].text) || RE_CLASS.test(stmts[k].text)) k = blockEnd(stmts, k) - 1;
  }
  return own;
}

function nestingDepth(own: Stmt[]): number {
  const openers: Array<{ indent: number; counts: boolean }> = [];
  let deepest = 0;
  for (const s of own) {
    while (openers.length && openers[openers.length - 1].indent >= s.indent) openers.pop();
    const current = openers.filter((o) => o.counts).length;
    deepest = Math.max(deepest, current);
    const keyword = RE_KEYWORD.exec(s.text)?.[1];
    if (keyword && s.text.endsWith(":")) {
      openers.push({ indent: s.indent, counts: DEPTH_KEYWORDS.has(keyword) });
    } else if (keyword && DEPTH_KEYWORDS.has(keyword) && hasInlineBody(s.text)) {
      deepest = Math.max(deepest, current + 1);
    }
  }
  return deepest;
}

function complexity(own: Stmt[]): number {
  let total = 1;
  for (const s of own) {
    total += countMatches(RE_BRANCH, s.text);
    if (/^case\b/.test(s.text)) total++;
  }
  return total;
}

/** 同じ深さに並んだ if / elif / else の列のうち、最も長いものの分岐の数。 */
function longestBranchChain(own: Stmt[]): number {
  let longest = 0;
  own.forEach((s, k) => {
    if (!/^if\b/.test(s.text)) return;
    let length = 1;
    for (let j = k + 1; j < own.length && own[j].indent >= s.indent; j++) {
      if (own[j].indent > s.indent) continue;
      if (/^elif\b/.test(own[j].text)) length++;
      else {
        if (/^else\b/.test(own[j].text)) length++;
        break;
      }
    }
    longest = Math.max(longest, length);
  });
  return longest;
}

function checkFunction(rep: Report, src: Source, stmts: Stmt[], i: number): void {
  const def = stmts[i];
  const end = blockEnd(stmts, i);
  const own = ownStatements(stmts, i + 1, end);
  const named = namedParams(splitParams(insideParens(def.text)));
  const flags = named.filter((p) => /=\s*(?:True|False)$/.test(p)).map(paramName);
  checkFunctionMetrics(rep, src, {
    name: RE_DEF.exec(def.text)![1], line: def.line,
    length: stmts[end - 1].endLine - def.line + 1,
    params: named.map(paramName).filter((n) => n !== "self" && n !== "cls").length,
    depth: nestingDepth(own), complexity: complexity(own), branches: longestBranchChain(own), flags,
  });
}

const isEmptyStatement = (text: string) => text === "pass" || text === "...";

function checkExcept(rep: Report, src: Source, stmts: Stmt[], i: number): void {
  const found = RE_EXCEPT.exec(stmts[i].text);
  if (!found) return;
  const inline = found[2].trim();
  const body = inline ? [inline] : stmts.slice(i + 1, blockEnd(stmts, i)).map((s) => s.text);
  if (!body.length || !body.every(isEmptyStatement)) return;
  const caught = found[1].trim();
  const catchesAll = caught === "" || caught === "Exception" || caught === "BaseException";
  rep.add("swallowed-error", catchesAll ? "high" : "medium", [src, stmts[i].line],
    "except の中が空で、エラーが起きても何も残らない" + (catchesAll ? "(すべてのエラーを捨てている)" : ""));
}

export function checkPython(rep: Report, src: Source): void {
  const stmts = logicalLines(src.codeLines);
  stmts.forEach((s, i) => {
    if (RE_DEF.test(s.text)) checkFunction(rep, src, stmts, i);
    else if (s.text.startsWith("except")) checkExcept(rep, src, stmts, i);
    const global = RE_GLOBAL.exec(s.text);
    if (global) {
      const names = global[1].split(",").map((x) => x.trim()).join(", ");
      rep.add("global-state", "medium", [src, s.line], `関数の中から共有の変数(${names})を書き換えている`);
    }
  });
}

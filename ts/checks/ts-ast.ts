/**
 * JavaScript / TypeScript の検出。TypeScript の構文解析を使うので正確に数えられる。
 * typescript が見つからなければ null を返し、呼び出し側は文字の並びからの推測(brace.ts)に切り替える。
 */
import { createRequire } from "node:module";
import path from "node:path";
import type * as TS from "typescript";

import { ANONYMOUS } from "./brace.ts";
import { checkFunctionMetrics, type Report, type Source } from "./core.ts";

export type TsModule = typeof TS;

function tryRequire(base: string): TsModule | null {
  try {
    return createRequire(base)("typescript") as TsModule;
  } catch { // refactor-check: ignore  見つからないのは想定どおり。呼び出し側で次の場所を試す
    return null;
  }
}

/** 調べるプロジェクトの typescript を優先し、なければこのキットの隣のものを使う。 */
export function loadTypeScript(root: string): TsModule | null {
  if (process.env.REFACTOR_CHECK_NO_TS) return null;
  return tryRequire(path.join(root, "package.json")) ?? tryRequire(import.meta.filename);
}

type FunctionNode = TS.SignatureDeclaration & { body?: TS.Node };

/** 1つのファイルを調べるあいだ使うもの。 */
interface Ctx {
  ts: TsModule;
  sf: TS.SourceFile;
  rep: Report;
  src: Source;
}

const lineOf = (c: Ctx, node: TS.Node) => c.sf.getLineAndCharacterOfPosition(node.getStart(c.sf)).line + 1;
const endLineOf = (c: Ctx, node: TS.Node) => c.sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

function isFunction(ts: TsModule, n: TS.Node): n is FunctionNode {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
    || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)
    || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);
}

const isScope = (ts: TsModule, n: TS.Node) => isFunction(ts, n) || ts.isClassLike(n);

/** 入れ子の関数やクラスの中には入らずに、子孫をたどる。 */
function ownNodes(ts: TsModule, node: TS.Node, visit: (n: TS.Node) => void): void {
  node.forEachChild((child) => {
    if (isScope(ts, child)) return;
    visit(child);
    ownNodes(ts, child, visit);
  });
}

// ---------------------------------------------------------------- 関数の名前

function ownName(ts: TsModule, fn: TS.Node): string | null {
  const own = (fn as { name?: TS.Node }).name;
  if (!own) return null;
  return ts.isIdentifier(own) || ts.isPrivateIdentifier(own) || ts.isStringLiteral(own) ? own.text : null;
}

/** `const f = () => {}` や `{ f: function () {} }` の形。 */
function assignedName(ts: TsModule, fn: TS.Node): string | null {
  const parent = fn.parent;
  const named = ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent);
  if (!named || parent.initializer !== fn) return null;
  return ts.isIdentifier(parent.name) ? parent.name.text : null;
}

/** `obj.f = function () {}` の形。 */
function writtenName(ts: TsModule, fn: TS.Node): string | null {
  const parent = fn.parent;
  if (!ts.isBinaryExpression(parent) || parent.right !== fn) return null;
  const left = parent.left;
  if (ts.isIdentifier(left)) return left.text;
  return ts.isPropertyAccessExpression(left) ? left.name.text : null;
}

function functionName(ts: TsModule, fn: TS.Node): string {
  if (ts.isConstructorDeclaration(fn)) return "constructor";
  return ownName(ts, fn) ?? assignedName(ts, fn) ?? writtenName(ts, fn) ?? ANONYMOUS;
}

// ---------------------------------------------------------------- 数える

const isElseIf = (ts: TsModule, n: TS.IfStatement) => n.elseStatement !== undefined && ts.isIfStatement(n.elseStatement);

/** 制御構文の入れ子の深さ。else if は同じ深さとして数える。 */
function depth(ts: TsModule, node: TS.Node, d: number): number {
  let deepest = d;
  const into = (child: TS.Node | undefined, nd: number) => {
    if (child && !isScope(ts, child)) deepest = Math.max(deepest, depth(ts, child, nd));
  };
  if (ts.isIfStatement(node)) {
    into(node.expression, d);
    into(node.thenStatement, d + 1);
    into(node.elseStatement, isElseIf(ts, node) ? d : d + 1);
    return Math.max(deepest, d + 1);
  }
  const opensBlock = ts.isIterationStatement(node, false) || ts.isSwitchStatement(node) || ts.isTryStatement(node);
  node.forEachChild((child) => into(child, opensBlock ? d + 1 : d));
  return opensBlock ? Math.max(deepest, d + 1) : deepest;
}

function isBranch(ts: TsModule, n: TS.Node): boolean {
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    return op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken
      || op === ts.SyntaxKind.QuestionQuestionToken;
  }
  return ts.isIfStatement(n) || ts.isIterationStatement(n, false) || ts.isCatchClause(n)
    || ts.isCaseClause(n) || ts.isConditionalExpression(n);
}

function complexity(ts: TsModule, fn: TS.Node): number {
  let total = 1;
  ownNodes(ts, fn, (n) => {
    if (isBranch(ts, n)) total++;
  });
  return total;
}

/** if から始まる if / else if / else の列のうち、最も長いものの分岐の数。 */
function longestBranchChain(ts: TsModule, fn: TS.Node): number {
  const ifs: TS.IfStatement[] = [];
  ownNodes(ts, fn, (n) => {
    if (ts.isIfStatement(n)) ifs.push(n);
  });
  const continued = new Set<TS.Node | undefined>(ifs.filter((n) => isElseIf(ts, n)).map((n) => n.elseStatement));
  let longest = 0;
  for (const head of ifs.filter((n) => !continued.has(n))) {
    let length = 1;
    let node = head;
    while (isElseIf(ts, node)) {
      node = node.elseStatement as TS.IfStatement;
      length++;
    }
    longest = Math.max(longest, length + (node.elseStatement ? 1 : 0));
  }
  return longest;
}

function isFlag(ts: TsModule, p: TS.ParameterDeclaration): boolean {
  const t = p.type;
  const booleanType = t !== undefined && (t.kind === ts.SyntaxKind.BooleanKeyword
    || (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.text === "Boolean"));
  const kind = p.initializer?.kind;
  return booleanType || kind === ts.SyntaxKind.TrueKeyword || kind === ts.SyntaxKind.FalseKeyword;
}

// ---------------------------------------------------------------- 検出

const SUITE_WORDS = new Set(["describe", "context", "suite"]);

/** `describe("…", () => { … })` のようなテストのまとまり。中のテストを並べる入れ物なので長さは数えない。 */
function isSuiteCallback(ts: TsModule, fn: TS.Node): boolean {
  const call = fn.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(fn as TS.Expression)) return false;
  let callee: TS.Expression = call.expression;
  while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) callee = callee.expression;
  return ts.isIdentifier(callee) && SUITE_WORDS.has(callee.text);
}

function checkFunction(c: Ctx, fn: FunctionNode): void {
  const { ts, sf } = c;
  if (!fn.body || isSuiteCallback(ts, fn)) return; // 宣言だけ(オーバーロードや abstract)とテストのまとまりは数えない
  const params = fn.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === "this"));
  checkFunctionMetrics(c.rep, c.src, {
    name: functionName(ts, fn), line: lineOf(c, fn), length: endLineOf(c, fn) - lineOf(c, fn) + 1,
    params: params.length, depth: depth(ts, fn.body, 0), complexity: complexity(ts, fn),
    branches: longestBranchChain(ts, fn),
    flags: params.filter((p) => isFlag(ts, p)).map((p) => p.name.getText(sf)),
  });
}

const SWALLOWED = "catch の中が空で、エラーが起きても何も残らない";

function isEmptyBlock(ts: TsModule, n: TS.Node | undefined): boolean {
  return n !== undefined && ts.isBlock(n) && n.statements.length === 0;
}

/** promise.catch(() => {}) の形なら、その空の関数を返す。 */
function emptyPromiseHandler(ts: TsModule, node: TS.Node): TS.Node | null {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "catch") return null;
  const handler = node.arguments[0];
  const isHandler = ts.isArrowFunction(handler) || ts.isFunctionExpression(handler);
  return isHandler && isEmptyBlock(ts, handler.body) ? handler : null;
}

function checkCatch(c: Ctx, node: TS.Node): void {
  if (c.ts.isCatchClause(node) && isEmptyBlock(c.ts, node.block)) {
    c.rep.add("swallowed-error", "high", [c.src, lineOf(c, node)], SWALLOWED);
  }
  const handler = emptyPromiseHandler(c.ts, node);
  if (handler) c.rep.add("swallowed-error", "high", [c.src, lineOf(c, handler)], SWALLOWED);
}

function checkTopLevelMutable(c: Ctx): void {
  const { ts, sf } = c;
  const fixed = ts.NodeFlags.Const | (ts.NodeFlags.Using ?? 0) | (ts.NodeFlags.AwaitUsing ?? 0);
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt) || stmt.declarationList.flags & fixed) continue;
    const names = stmt.declarationList.declarations.map((d) => d.name.getText(sf));
    c.rep.add("global-state", "medium", [c.src, lineOf(c, stmt)],
      `ファイルの一番外側に、書き換えられる変数(${names.join(", ")})がある`);
  }
}

/** any を書いた行。1行に何個あっても1件にまとめる。 */
function checkAny(c: Ctx, anyLines: Set<number>): void {
  for (const line of anyLines) {
    c.rep.add("type-escape", "medium", [c.src, line], "何でも入る型(any)で型の確認を止めている");
  }
}

export function checkTs(ts: TsModule, rep: Report, src: Source): void {
  const kinds: Record<string, TS.ScriptKind> = {
    ".tsx": ts.ScriptKind.TSX, ".jsx": ts.ScriptKind.JSX,
    ".js": ts.ScriptKind.JS, ".mjs": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS,
  };
  const sf = ts.createSourceFile(src.filePath, src.text, ts.ScriptTarget.Latest, true, kinds[src.ext] ?? ts.ScriptKind.TS);
  const c: Ctx = { ts, sf, rep, src };
  const anyLines = new Set<number>();
  const visit = (node: TS.Node): void => {
    if (isFunction(ts, node)) checkFunction(c, node);
    if (node.kind === ts.SyntaxKind.AnyKeyword) anyLines.add(lineOf(c, node));
    checkCatch(c, node);
    node.forEachChild(visit);
  };
  visit(sf);
  checkTopLevelMutable(c);
  checkAny(c, anyLines);
}

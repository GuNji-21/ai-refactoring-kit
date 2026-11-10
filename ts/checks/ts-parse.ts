/**
 * typescript の読み込みと、構文解析で文字列・正規表現などの範囲を見つける処理。
 * core.ts(コメントと文字列の除去)と ts-ast.ts(検出)の両方から使う。
 */
import { createRequire } from "node:module";
import path from "node:path";
import type * as TS from "typescript";

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

export function parseTs(ts: TsModule, fileName: string, text: string, ext: string): TS.SourceFile {
  const kinds: Record<string, TS.ScriptKind> = {
    ".tsx": ts.ScriptKind.TSX, ".jsx": ts.ScriptKind.JSX,
    ".js": ts.ScriptKind.JS, ".mjs": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS,
  };
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kinds[ext] ?? ts.ScriptKind.TS);
}

/** 中身を空白にする範囲。start から end の手前までのうち、先頭 head 文字と末尾 tail 文字は残す。 */
export interface Literal {
  end: number;
  head: number;
  tail: number;
}

/**
 * 文字列・テンプレート・正規表現・JSX の文字の範囲を、始まりの位置ごとに返す。
 * 構文木から取るので、正規表現の中の // や、JSX の文字の中の ' をコメントや文字列と取り違えない。
 */
export function literalRanges(ts: TsModule, sf: TS.SourceFile): Map<number, Literal> {
  const K = ts.SyntaxKind;
  const ranges = new Map<number, Literal>();
  const add = (node: TS.Node, head: number, tail: number) => {
    // JSX の文字には前置きの空白やコメントがないので pos から。getStart だと中の // をコメントとして飛ばしてしまう
    const start = node.kind === K.JsxText ? node.pos : node.getStart(sf);
    if (start < node.end) ranges.set(start, { end: node.end, head, tail });
  };
  const visit = (node: TS.Node): void => {
    switch (node.kind) {
      case K.StringLiteral:
      case K.NoSubstitutionTemplateLiteral:
      case K.TemplateTail: // `}...\``
        add(node, 1, 1);
        break;
      case K.TemplateHead: // `\`...${`
      case K.TemplateMiddle: // `}...${`
        add(node, 1, 2);
        break;
      case K.RegularExpressionLiteral: { // /.../flags は、最後の / から後ろ(フラグ)を残す
        const text = node.getText(sf);
        add(node, 1, text.length - text.lastIndexOf("/"));
        break;
      }
      case K.JsxText:
        add(node, 0, 0);
        break;
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return ranges;
}

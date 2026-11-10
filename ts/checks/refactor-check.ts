#!/usr/bin/env node
/**
 * リファクタリングを始めるべきかどうかを判定する。
 *
 * コードを調べて、catalog.md の項目に対応する問題を見つけ、
 * 「今すぐ直す(act)」「提案する(suggest)」「直さない(skip)」のどれかを返す。
 * コードの書き換えは一切しない。
 *
 * 使い方:
 *   node checks/refactor-check.ts [パス ...]   指定したファイルやフォルダを調べる
 *   node checks/refactor-check.ts --changed    git で変更したファイルだけを調べる
 *   node checks/refactor-check.ts --staged     ステージした中身だけを調べる(コミット前のフック用)
 *   node checks/refactor-check.ts --json       AI が読みやすい JSON で出力する
 *
 * Node.js 22.18 以上(.ts をそのまま実行できる版)。
 * JS/TS を正確に解析するには typescript が必要(調べるプロジェクトに入っていればそれを使う)。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { checkBrace } from "./brace.ts";
import {
  type Finding, git, GitError, gitPaths, isExcluded, isTestPath, relPath, Report, Source, walk, wanted,
} from "./core.ts";
import { checkDuplicates, FILE_CHECKS } from "./lines.ts";
import { checkPython } from "./python.ts";
import {
  CONFIG_FILE, type Config, DEFAULTS, MAX_FILE_BYTES, MAX_LINE_CHARS, MINIFIED_SAMPLE_LINES,
  SEVERITY_ORDER, type Severity,
} from "./rules.ts";
import { checkTs } from "./ts-ast.ts";
import { loadTypeScript, type TsModule } from "./ts-parse.ts";

export { DEFAULTS };

// ---------------------------------------------------------------- 判定

export type Verdict = "act" | "suggest" | "skip";

export interface Preflight {
  test_files: number;
  git_repo: boolean;
  uncommitted_changes: number;
}

export interface Result {
  verdict: Verdict;
  reason: string;
  counts: Record<Severity, number>;
  next_steps: string[];
  files_checked: number;
  /** JS/TS をどう調べたか。"typescript" = 構文解析 / "heuristic" = 文字の並びから推測 */
  js_ts_parser: "typescript" | "heuristic";
  preflight: Preflight;
  findings: Finding[];
}

/** 直し始めてよい状態かどうかを調べる(カタログ P01, P03)。 */
function preflight(root: string, exclude: string[]): Preflight {
  let tests = 0;
  for (const p of walk(root, exclude)) if (isTestPath(relPath(p, root))) tests++;
  const status = git(root, "status", "--porcelain");
  return {
    test_files: tests,
    git_repo: status !== null,
    uncommitted_changes: status ? status.split("\n").filter(Boolean).length : 0,
  };
}

// [この重さの項目が1件でもあれば, 判定, 理由] を重い順に並べたもの
const VERDICTS: ReadonlyArray<[Severity, Verdict, string]> = [
  ["high", "act", "重大な問題があるので、今の作業を進める前に直す価値がある"],
  ["medium", "suggest", "直したほうがよい点がある。ユーザーに見せて、直すかどうかを決めてもらう"],
];
const SKIP: [Verdict, string] = ["skip", "リファクタリングを始めるほどの問題はない"];

function verdictOf(counts: Record<Severity, number>): [Verdict, string] {
  for (const [severity, verdict, reason] of VERDICTS) if (counts[severity]) return [verdict, reason];
  return SKIP;
}

/** 直す順番。先に安全を確かめる手順(P01, P03)を置き、最後にテストの手順(P02)を置く。 */
function nextSteps(findings: Finding[], pre: Preflight): string[] {
  const steps: string[] = [];
  if (pre.test_files === 0) steps.push("P01: テストが見つからない。直す前に、今の動きを固定するテストを書く");
  if (pre.uncommitted_changes) {
    steps.push(`P03: コミットしていない変更が ${pre.uncommitted_changes} 件ある。先にコミットして、整理と機能の変更を混ぜない`);
  }
  const byId = new Map<string, string>();
  for (const f of findings) {
    if (f.severity !== "low" && !byId.has(f.catalog_id)) byId.set(f.catalog_id, `${f.catalog_id} ${f.title}: ${f.action}`);
  }
  return [...steps, ...byId.values(), "P02: 1種類直すたびにテストを実行する"];
}

function decide(findings: Finding[], pre: Preflight) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  const [verdict, reason] = verdictOf(counts);
  return { verdict, reason, counts, next_steps: verdict !== "skip" ? nextSteps(findings, pre) : [] };
}

export function loadConfig(root: string): Config {
  const cfg = { ...DEFAULTS };
  const file = path.join(root, CONFIG_FILE);
  if (existsSync(file)) {
    try {
      Object.assign(cfg, JSON.parse(readFileSync(file, "utf8")));
    } catch (e) {
      process.stderr.write(`${CONFIG_FILE} を読めません: ${(e as Error).message}\n`);
    }
  }
  return cfg;
}

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

/** コミットしていない変更(追加・編集・未追跡)のあるファイル。 */
function changedFiles(root: string, exclude: string[]): Set<string> {
  const untracked = gitPaths(root, "ls-files", "--others", "--exclude-standard");
  const tracked = git(root, "rev-parse", "--verify", "--quiet", "HEAD") === null
    ? gitPaths(root, "ls-files", "--cached") // 最初のコミットの前は、追加したものすべてが変更
    : gitPaths(root, "diff", "--name-only", "--relative", "HEAD");
  const paths = [...tracked, ...untracked].map((name) => path.resolve(root, name));
  return new Set(paths.filter((p) => isFile(p) && wanted(p) && !isExcluded(p, exclude)));
}

/**
 * ステージした変更のあるファイルと、ステージした中身(パス -> 中身)。
 * 作業中のファイルではなくインデックスの中身を読むので、コミットされるものをそのまま調べられる。
 * git diff HEAD だけでは、ステージした変更と、その後で作業中のファイルを戻した変更が打ち消し合って見えなくなる。
 */
function stagedFiles(root: string, exclude: string[]): Map<string, string> {
  const names = gitPaths(root, "diff", "--cached", "--name-only", "--relative", "--diff-filter=d");
  const staged = new Map<string, string>();
  for (const name of names) {
    const p = path.resolve(root, name);
    if (!wanted(p) || isExcluded(p, exclude)) continue;
    const text = git(root, "show", `:./${name}`);
    if (text === null) throw new GitError(`git show :./${name} が失敗しました`);
    staged.set(p, text);
  }
  return staged;
}

function listedFiles(paths: string[], exclude: string[]): Set<string> {
  const found = new Set<string>();
  for (const raw of paths.length ? paths : ["."]) {
    const p = path.resolve(raw);
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) for (const x of walk(p, exclude)) found.add(path.resolve(x));
    else if (statSync(p).isFile() && wanted(p)) found.add(p);
  }
  return found;
}

/** 調べるファイル。texts にあるファイルは、ファイルの代わりにその中身を調べる。 */
interface Selection {
  targets: Set<string>; // 問題を報告するファイル
  files: Set<string>; // 読み込むファイル(重複を比べる相手を含む)
  texts: Map<string, string>;
}

function loadSources(sel: Selection, root: string, ts: TsModule | null): Source[] {
  const sources: Source[] = [];
  for (const p of [...sel.files].sort()) {
    const text = sel.texts.get(p);
    let src: Source;
    try {
      const size = text !== undefined ? Buffer.byteLength(text) : statSync(p).size;
      if (size > MAX_FILE_BYTES) continue;
      src = new Source(p, root, sel.targets.has(p), { text, ts });
    } catch { // refactor-check: ignore  読めないファイルは調べない(Python 版と同じ)
      continue;
    }
    // 1行が極端に長いのは圧縮済みのファイルなので除く
    if (!src.lines.slice(0, MINIFIED_SAMPLE_LINES).some((line) => line.length > MAX_LINE_CHARS)) sources.push(src);
  }
  return sources;
}

export interface AnalyzeOptions {
  changed?: boolean; // git で変更したファイルだけを調べる
  staged?: boolean; // ステージした中身だけを調べる
  cfg?: Config;
}

function selectFiles(paths: string[], root: string, options: AnalyzeOptions, exclude: string[]): Selection {
  let targets: Set<string>;
  let texts = new Map<string, string>();
  if (options.staged) {
    texts = stagedFiles(root, exclude);
    targets = new Set(texts.keys());
  } else if (options.changed) {
    targets = changedFiles(root, exclude);
  } else {
    targets = listedFiles(paths, exclude);
    return { targets, files: targets, texts };
  }
  const files = new Set(targets);
  for (const p of walk(root, exclude)) files.add(path.resolve(p)); // 重複は全体と比べる
  return { targets, files, texts };
}

function runChecks(sources: Source[], cfg: Config, ts: TsModule | null) {
  const rep = new Report(cfg);
  for (const src of sources) {
    if (!src.isTarget) continue;
    if (src.isPy) checkPython(rep, src);
    else if (ts && src.tsFile) checkTs(ts, rep, src as Source & { tsFile: NonNullable<Source["tsFile"]> });
    else checkBrace(rep, src);
    for (const check of FILE_CHECKS) check(rep, src);
  }
  checkDuplicates(rep, sources);
  return rep.findings.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    || a.line - b.line);
}

export function analyze(paths: string[], rootArg: string, options: AnalyzeOptions = {}): Result {
  const root = path.resolve(rootArg);
  const cfg = options.cfg ?? loadConfig(root);
  const ts = loadTypeScript(root);
  const sources = loadSources(selectFiles(paths, root, options, cfg.exclude), root, ts);
  const findings = runChecks(sources, cfg, ts);
  const pre = preflight(root, cfg.exclude);
  return {
    ...decide(findings, pre),
    files_checked: sources.filter((s) => s.isTarget).length,
    js_ts_parser: ts ? "typescript" : "heuristic",
    preflight: pre,
    findings,
  };
}

// ---------------------------------------------------------------- 出力

const VERDICT_LABEL: Record<Verdict, string> = {
  act: "ACT(今すぐ直す)", suggest: "SUGGEST(提案する)", skip: "SKIP(直さない)",
};

function headerLines(result: Result): string[] {
  const { preflight: pre, counts } = result;
  const tests = pre.test_files ? `${pre.test_files} ファイル` : "なし";
  const uncommitted = pre.git_repo ? `${pre.uncommitted_changes} 件` : "不明(git 管理外)";
  return [
    "== リファクタリング判定 ==",
    `調べたファイル: ${result.files_checked}`,
    `事前確認: テスト ${tests} / コミットしていない変更 ${uncommitted}`,
    `判定: ${VERDICT_LABEL[result.verdict]}  high ${counts.high} / medium ${counts.medium} / low ${counts.low}`,
    `理由: ${result.reason}`,
  ];
}

function findingLines(findings: Finding[], showAll: boolean): string[] {
  const shown = findings.filter((f) => showAll || f.severity !== "low");
  const lines = shown.length ? [""] : [];
  for (const f of shown) {
    lines.push(`[${f.severity}] ${f.file}:${f.line}  ${f.catalog_id} ${f.title}`);
    lines.push(`        ${f.message}`);
  }
  const hidden = findings.length - shown.length;
  if (hidden) lines.push(`\nlow が ${hidden} 件ある(--all で表示)`);
  return lines;
}

function stepLines(steps: string[]): string[] {
  return steps.length ? ["\n次にやること:", ...steps.map((s, i) => `  ${i + 1}. ${s}`)] : [];
}

export function render(result: Result, showAll = false): string {
  const parserNote = result.js_ts_parser === "heuristic"
    ? ["(typescript が見つからないため、JS/TS は文字の並びから推測した)"] : [];
  const lines = [...headerLines(result), ...parserNote, ...findingLines(result.findings, showAll),
    ...stepLines(result.next_steps)];
  return lines.join("\n") + "\n";
}

const HELP = `使い方: node checks/refactor-check.ts [パス ...] [オプション]

リファクタリングを始めるべきかどうかを判定する

オプション:
  --changed               git で変更したファイルだけを調べる
  --staged                ステージした中身だけを調べる(コミット前のフック用)
  --root <フォルダ>       プロジェクトの一番上のフォルダ(初期値: .)
  --json                  JSON で出力する
  --all                   low の項目も表示する
  --fail-on <判定>        never / act / suggest。この判定以上なら終了コード 1 を返す(CI やフック用)
  -h, --help              この説明を表示する
`;

interface Cli {
  paths: string[];
  changed: boolean;
  staged: boolean;
  root: string;
  json: boolean;
  all: boolean;
  failOn: "never" | Verdict;
}

const FAIL_ON = ["never", "act", "suggest"];

/** 引数を読む。すぐに終わるとき(--help や誤った指定)は終了コードを返す。 */
function parseCli(argv: string[]): Cli | number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        changed: { type: "boolean", default: false },
        staged: { type: "boolean", default: false },
        root: { type: "string", default: "." },
        json: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        "fail-on": { type: "string", default: "never" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (v.changed && v.staged) {
    process.stderr.write("--changed と --staged は一緒に使えません\n");
    return 2;
  }
  if (!FAIL_ON.includes(v["fail-on"])) {
    process.stderr.write("--fail-on には never / act / suggest のどれかを指定してください\n");
    return 2;
  }
  return {
    paths: positionals, changed: v.changed, staged: v.staged, root: v.root, json: v.json, all: v.all,
    failOn: v["fail-on"] as Cli["failOn"],
  };
}

/** 判定する。git の問題で調べられないときは終了コードを返す。 */
function analyzeCli(cli: Cli): Result | number {
  if ((cli.changed || cli.staged) && git(cli.root, "rev-parse", "--git-dir") === null) {
    process.stderr.write(`${cli.staged ? "--staged" : "--changed"} は git のリポジトリの中でだけ使えます\n`);
    return 2;
  }
  try {
    return analyze(cli.paths, cli.root, { changed: cli.changed, staged: cli.staged });
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    process.stderr.write(`変更したファイルを調べられません: ${e.message}\n`);
    return 2;
  }
}

const RANK: Record<Verdict, number> = { skip: 0, suggest: 1, act: 2 };

export function main(argv = process.argv.slice(2)): number {
  const cli = parseCli(argv);
  if (typeof cli === "number") return cli;
  const result = analyzeCli(cli);
  if (typeof result === "number") return result;
  process.stdout.write(cli.json ? JSON.stringify(result, null, 2) + "\n" : render(result, cli.all));
  return cli.failOn !== "never" && RANK[result.verdict] >= RANK[cli.failOn] ? 1 : 0;
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  process.exitCode = main();
}

# ai-refactoring-kit

AIと一緒にコードを書くときの、リファクタリング支援キットです。次の3つが入っています。

| 中身 | 場所 | 役割 |
|---|---|---|
| カタログ | [catalog.md](catalog.md) | 直したほうがいいサイン、直し方、AIへの頼み方を62項目にまとめた一覧 |
| 判定スクリプト | [checks/](checks/) | コードを調べて「今リファクタリングを始めるべきか」を判定する |
| AI用の手順 | [.claude/skills/refactor-check/SKILL.md](.claude/skills/refactor-check/SKILL.md) | 判定の結果に応じてAIがどう動くかを決めた手順書 |

## なぜ判定が必要か

AIは頼めばいくらでもコードを書き換えます。そのため「どう直すか」より「今直すべきか」のほうが難しくなります。直さなくていいコードを書き換えると、差分が増え、確認の手間が増え、壊す機会も増えます。

このキットでは、スクリプトが数えられるものを数えて、3段階で判定します。

| 判定 | 条件 | AIの動き |
|---|---|---|
| `act` | 重大な問題（high）が1つ以上ある | 今の作業を止めて、直す手順を提案する |
| `suggest` | 直したほうがよい点（medium）がある | 作業は続け、最後に一覧を見せて直すかどうかを聞く |
| `skip` | 軽い指摘（low）だけ、または何もない | 何も直さない |

あわせて、直し始めてよい状態かどうか（テストがあるか、コミットしていない変更がないか）も確かめます。

## 使い方

Python 3.9 以上があれば動きます。追加のライブラリは不要です。

フォルダ全体を調べる：

```bash
python checks/refactor_check.py src
```

git で変更したファイルだけを調べる（AIに書かせた直後に使う）：

```bash
python checks/refactor_check.py --changed
```

AIに読ませるために JSON で出す：

```bash
python checks/refactor_check.py --changed --json
```

出力の例：

```
== リファクタリング判定 ==
調べたファイル: 1
事前確認: テスト なし / コミットしていない変更 1 件
判定: ACT(今すぐ直す)  high 1 / medium 0 / low 0
理由: 重大な問題があるので、今の作業を進める前に直す価値がある

[high] new.py:4  E01 エラーを黙って捨てている
        except の中が空で、エラーが起きても何も残らない(すべてのエラーを捨てている)

次にやること:
  1. P01: テストが見つからない。直す前に、今の動きを固定するテストを書く
  2. P03: コミットしていない変更が 1 件ある。先にコミットして、整理と機能の変更を混ぜない
  3. E01 エラーを黙って捨てている: ログを残すか、捕まえるのをやめる
  4. P02: 1種類直すたびにテストを実行する
```

### オプション

| オプション | 意味 |
|---|---|
| `--changed` | git で変更・追加したファイルだけを調べる。重複はプロジェクト全体と比べる |
| `--staged` | ステージした中身だけを調べる。作業中のファイルではなく、コミットされる中身を読む。コミット前のフックで使う |
| `--json` | JSON で出力する |
| `--all` | low の項目も表示する |
| `--root フォルダ` | プロジェクトの一番上のフォルダを指定する |
| `--fail-on act` / `--fail-on suggest` | その判定以上なら終了コード 1 を返す。CI やフックで使う |

## 自動で検出するもの

18種類を検出します。IDは [catalog.md](catalog.md) と対応しています。

| ID | 検出するもの | 初期の目安 | 重さ |
|---|---|---|---|
| R01 | 長すぎる関数 | 50行 | medium（2倍を超えると high） |
| R02 | 深すぎる入れ子 | 3段 | medium（2倍を超えると high） |
| R04 | 説明のない数字 | 0, 1, 2, 10, 100 以外 | low |
| R05 | 長い条件式 | 1行に and / or が3個以上 | low（5個以上で medium） |
| R08 | 分岐が多すぎる関数 | 10個 | medium（2倍を超えると high） |
| R09 | 長い if-else の列 | 5分岐以上 | medium |
| D01 | 重複したコード | 6行以上 | medium（18行以上で high） |
| D04 | コメントにされたコード | 2行以上続く | low |
| D05 | 確認用の出力の消し忘れ | `print` `console.log` `debugger` など | low |
| D06 | TODO / FIXME | 1件ごと | low |
| F01 | 引数が多すぎる | 5個以上 | medium |
| F02 | true/false で動きを切り替える引数 | 1件ごと | low |
| F06 | 共有の書き換えられる変数 | `global`、一番外側の `let` / `var` | medium |
| F09 | 型の確認のすり抜け | `any` `@ts-ignore` `# type: ignore` など | medium |
| F11 | 中身を何段もたどる呼び出し | 引数なしの呼び出しが3回以上続く | low |
| M01 | 大きすぎるファイル | 400行 | medium（2倍を超えると high） |
| M10 | 鍵やパスワードらしい値 | 1件ごと | high |
| E01 | 空の catch / except | 1件ごと | high |

カタログの残りの項目（名前の良し悪し、設計の分け方など）は数えられないので、AIがコードを読んで判断します。その手順は SKILL.md に書いてあります。

### 対応している言語

| 言語 | 精度 |
|---|---|
| Python | 構文を解析するので正確 |
| JavaScript / TypeScript / Java / Go / C# / Kotlin | 文字の並びから推測する。関数の見つけ方に取りこぼしや誤検出がありうる |

JS / TS のプロジェクトでは、[TypeScript 版](#typescript-版) を使うと JS / TS を構文解析で正確に調べられます。

### 目安を変える

プロジェクトの一番上に `.refactor-check.json` を置くと、目安を変えられます。書いた項目だけが上書きされます。

```json
{
  "max_function_lines": 80,
  "max_params": 5,
  "allowed_numbers": ["0", "1", "2", "10", "100", "1000"],
  "exclude": ["migrations/", "generated/"]
}
```

1行だけ見逃したいときは、その行に `refactor-check: ignore` と書いたコメントを付けます。

## AIに使わせる

### Claude Code

`.claude/skills/refactor-check/` と `checks/` と `catalog.md` を、自分のプロジェクトにコピーします。「整理して」と頼んだときや、変更が一区切りついたときに、AIが判定を実行してから動くようになります。

### ほかのAIツール

`CLAUDE.md` や `AGENTS.md` など、AIが最初に読むファイルに次を書きます。

```markdown
## リファクタリングの決まり

- コードを変更したら `python checks/refactor_check.py --changed --json` を実行する
- verdict が act なら作業を止めて、high の項目と直す手順を提案する
- verdict が suggest なら作業を続け、最後に medium の項目を見せて直すかどうかを聞く
- verdict が skip なら何も整理しない
- 直すときは catalog.md の該当するIDの手順に従い、1種類ずつ直してそのたびにテストを実行する
- 動きは変えない。見つけたバグは直さずに報告する
```

### コミット前に止める

重大な問題があるときだけコミットを止めるには、`.git/hooks/pre-commit` に次を書きます。`--changed` ではなく `--staged` を使います。`--changed` は作業中のファイルを読むので、ステージした後で作業中のファイルを戻すと、コミットされる問題を見逃します。

```bash
python checks/refactor_check.py --staged --fail-on act
```

## TypeScript 版

[ts/](ts/README.md) に、同じ判定を Node.js で動かす TypeScript 版があります。Python がない環境や、JS / TS のプロジェクトで使います。

```bash
node checks/refactor-check.ts --changed --json
```

- 検出する項目、判定の基準、目安の初期値、JSON の形、`.refactor-check.json` は Python 版と同じ
- JS / TS は TypeScript の構文解析で調べるので正確（`typescript` が見つからなければ、文字の並びからの推測に切り替える）
- Python は字下げから推測するので、Python のプロジェクトには Python 版のほうが正確
- Node.js 22.18 以上。`.ts` をビルドせずにそのまま実行する

カタログ（`catalog.md`）は両方で共通です。使い方とコピーするファイルは [ts/README.md](ts/README.md) にあります。

## 開発

テストの実行：

```bash
python -m unittest discover -s tests
```

| ファイル | 役割 |
|---|---|
| `checks/refactor_check.py` | 入口。判定と出力 |
| `checks/rc_rules.py` | 目安の初期値、カタログとの対応、正規表現 |
| `checks/rc_core.py` | ファイルの読み込み、コメントと文字列の除去、問題の記録 |
| `checks/rc_python.py` | Python の検出 |
| `checks/rc_brace.py` | 波かっこを使う言語の検出 |
| `checks/rc_lines.py` | 行ごとの検出と重複の検出 |

検出を足すときは、`rc_rules.py` の `CATALOG` に1行足し、検出の関数を書き、`tests/` にテストを足します。

## ライセンス

[MIT License](LICENSE)

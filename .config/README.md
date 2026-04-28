# .config/

このリポジトリの開発ツール設定 (rc 系) を集約したディレクトリです。
各サブプロジェクト (`cdk/`, `metrics-collector/`) の `package.json` から
明示的なフラグでこれらの設定を参照しています。

## 含まれるファイル

| ファイル | 用途 | 参照方法 |
| --- | --- | --- |
| `eslint.config.mjs` | ESLint v9 flat config (TypeScript 対応) | `eslint --config ../.config/eslint.config.mjs .` |
| `.prettierrc.json` | Prettier 整形ルール | `prettier --config ../.config/.prettierrc.json` |
| `.prettierignore` | Prettier 対象外パターン | `prettier --ignore-path ../.config/.prettierignore` |
| `.editorconfig` | エディタ統一設定 | エディタが上位ディレクトリを自動検索 (※) |
| `.nvmrc` | 推奨 Node.js バージョン | `nvm use $(cat .config/.nvmrc)` |

※ `.editorconfig` はソースファイルから上位ディレクトリへ向けて検索されるため、
ここに配置すると `.config/` 配下のファイルにのみ適用されます。リポジトリ全体に
適用したい場合は別途ルートへ複製/シンボリックリンクしてください。本リポジトリ
ではコード規約は ESLint / Prettier が一次的に担保します。

## なぜ `.config/` に集約するか

- リポジトリルートを散らかさない
- ツール設定を一箇所で見渡せる
- バージョン管理対象の rc ファイルを一括で grep / 監査できる

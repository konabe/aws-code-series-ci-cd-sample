# aws-code-series-ci-cd-sample

AI 駆動開発において **コードレビューを必須化する制約** のもとで、レビューの
**コスト** と **有効性** を可視化しながら最適化する試み。

## ゴール

- AI 一次レビュー → 人間最終レビューの **ハイブリッドフロー** をリファレンス実装する
- レビュー関連メトリクスを CloudWatch Dashboard で可視化する
- 「AI レビューに払うコスト」と「人間レビュー時間の削減効果・検出効果」を比較できるようにする

## アーキテクチャ概要

```
[GitHub: konabe/aws-code-series-ci-cd-sample]   ← この repo (CDK + 計測 Lambda)
└ cdk/                  AWS 基盤 (CodeCommit / Pipeline / DynamoDB / Dashboard)
└ metrics-collector/    PR イベント収集 Lambda (EventBridge → DynamoDB / CloudWatch)
└ docs/

[CodeCommit: todo-api]                          ← サンプルアプリ本体
└ src/                  TypeScript Lambda (TODO API)
└ tests/
└ buildspec.yml         CodeBuild 用

[CI/CD]
CodeCommit (push / PR)
  ├─ EventBridge ─→ metrics-collector Lambda ─→ DynamoDB / CloudWatch Metrics
  └─ CodePipeline
       ├─ CodeBuild: Kiro CLI で AI レビュー → PR コメント + メトリクス記録
       ├─ Manual Approval (人間が必ずチェック)
       └─ CodeBuild: ビルド & Lambda デプロイ
```

## 計測する指標

### コスト
- レビュー所要時間 (AI / 人間 / 合計)
- ラウンドトリップ回数
- PR キュー時間 (作成 → 初回レビュー)
- レビュアー人数
- AI API コスト (USD / トークン数)

### 有効性
- AI 指摘件数 / 人間指摘件数 / 重複件数
- マージ後のリワーク (修正コミット数)
- 本番障害発生率

## ディレクトリ構成

| パス | 役割 |
| --- | --- |
| `cdk/` | AWS 基盤 (CodeCommit / DynamoDB / Dashboard / CodePipeline) を CDK で定義 |
| `metrics-collector/` | CodeCommit のイベントを受けて DynamoDB / CloudWatch に書き込む Lambda |
| `docs/` | 設計メモ |

## セットアップ (作業中)

```bash
cd cdk
npm install
npx cdk bootstrap
npx cdk deploy --all
```

詳細は構築完了後に追記。

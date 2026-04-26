# アーキテクチャ詳細

## 設計方針メモ

- **AI レビュアー**: Kiro CLI を CodeBuild 上で実行し、PR コメントを CodeCommit に投稿
- **人間レビュー**: CodeCommit の Approval Rule Template (`todo-api-require-human-approver`) で
  「マージに 1 人以上の承認が必要」を強制 (どんな PR でも必須)
- **メトリクス保存**:
  - 生イベント → DynamoDB (`code-review-pr-events`)
    - `pk = PR#<repo>#<prId>` / `sk = <ISO timestamp>#<event>`
  - 集計値 → CloudWatch Custom Metrics (`CodeReviewOpt` namespace)
- **可視化**: CloudWatch Dashboard `code-review-optimization`

## トリガ構成

| 発火元 | 経路 | 動作 |
| --- | --- | --- |
| PR 作成 / source ブランチ更新 | EventBridge → AI レビュー CodeBuild | Kiro 実行 → PR にコメント → メトリクス記録 |
| main ブランチへの push | CodePipeline | Source → Build → (デプロイは TODO API 実装後に追加) |
| あらゆる PR | CodeCommit Approval Rule | 人間 1 名以上の承認なしにマージ不可 |

## 想定する PR ライフサイクルとイベント

| 時刻 | イベント | 取得元 |
| --- | --- | --- |
| t0 | `pullRequestCreated` | CodeCommit Event |
| t1 | AI レビュー開始 | CodeBuild Start |
| t2 | AI レビュー終了 (コメント投稿) | CodeBuild Success |
| t3 | 人間レビュー開始 (初回 view / コメント) | CodeCommit Event |
| t4 | 人間レビュー submit | CodeCommit Event |
| t5 | (再 push / 再レビュー) — 繰り返し | CodeCommit Event |
| t6 | Approval & マージ | CodePipeline / CodeCommit |
| t7+ | マージ後の修正コミット (リワーク検知) | CodeCommit Event |

## 計算式 (案)

- レビュー所要時間 (AI) = t2 - t1
- レビュー所要時間 (人間) = t4 - t3 (初回のみ。以降の往復は別途)
- キュー時間 = t3 - t0
- ラウンドトリップ = changes_requested 回数
- リワーク = マージ後 N 日以内に同ファイルを修正したコミット数
- AI コスト USD = Bedrock / Kiro 利用トークン × 単価

## 未決事項

- Kiro CLI から「使用トークン数」を取り出す方法 (CLI の出力フォーマット要確認)
- CodeCommit が PR レビューイベントで取得できる項目の詳細確認
- 本番障害との紐付け (CloudWatch Alarm → 直近 PR との関連付けロジック)

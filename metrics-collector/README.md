# metrics-collector

CodeCommit のイベントを EventBridge 経由で受け取り、

- DynamoDB (`code-review-pr-events`) に **生イベントを保存**
- CloudWatch (`CodeReviewOpt` namespace) に **派生メトリクスを発行**

する Lambda 関数。

## 取り扱うイベント

| EventBridge `detail.event` | 動作 |
| --- | --- |
| `pullRequestCreated` | 生イベント保存のみ (PR 開始時刻として後で使う) |
| `pullRequestSourceBranchUpdated` | `ReviewRoundTrips +1` |
| `commentOnPullRequestCreated` | `PullRequestComments +1` |
| `pullRequestApprovalStateChanged` (APPROVE) | `ApprovalEvents +1` |
| `pullRequestStatusChanged` (merged) | DynamoDB から PR 開始時刻を引いて `TotalReviewDurationSec` を発行 |
| その他 | 生イベントだけ保存 |

## DynamoDB スキーマ

| 項目 | 内容 |
| --- | --- |
| `pk` | `PR#<repository>#<pullRequestId>` |
| `sk` | `<ISO timestamp>#<eventName>` |
| `event` | イベント名 |
| `time` | EventBridge `time` |
| `actor` | `callerUserArn` |
| `payload` | `detail` 全体 |
| `ttl` | 1 年後 (epoch sec) |

## 開発

```bash
cd metrics-collector
npm install
npm run build  # 型チェック
```

CDK 側で `NodejsFunction` がこのディレクトリの `src/index.ts` を esbuild で
バンドルして Lambda にデプロイする (`@aws-sdk/*` は Lambda 標準ランタイムを使うため external)。

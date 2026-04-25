# metrics-collector

CodeCommit の PR / コミットイベントを EventBridge 経由で受け取り、
DynamoDB に生イベントを保存しつつ CloudWatch Custom Metrics に集計値を発行する
Lambda 関数。

実装はこれから（初期スケルトンのみ）。

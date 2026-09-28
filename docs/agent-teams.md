# Agent Teams 設計書

## 追加機能の概要
・在庫アラート通知（在庫アラート閾値が1の商品をまとめてリスト表示するAPIの追加）
・CSV出力　（在庫一覧をCSV形式でダウンロードできるエンドポイントを追加する）

## Agent構成

| Agent名 | 役割 | 担当タスク |
|----------|----------|----------|
| backend-architect | バックエンド実装担当 | 在庫アラートAPI実装、CSV出力API実装、データ取得処理実装 |
| frontend-developer | フロントエンド実装担当 | 在庫アラート表示機能、CSV出力機能を実装|
| security-auditor | テスト、レビュー担当 | テスト実施、セキュリティレビュー、コードレビュー |

## タスクの依存関係

Backend Agent → frontend-developer → security-auditor →（修正あれば追加で）Bakend Agent → frontend-developer → security-auditor

## 並列実行できるタスク

- Backend Agent
  - GET /products/alerts の実装
  - GET /products/export/csv の実装

上記2機能は互いに独立しているため並列実行可能

- security-auditor
  - 在庫アラートAPIテスト作成
  - CSV出力APIテスト作成

上記2機能のテストも並列実行可能

## 統合時の確認ポイント

- 在庫アラートAPIが正常に応答すること
- 閾値が「1」の商品のみ取得できること
- 対象データが0件の場合でも正常終了すること
- CSVファイルが正常にダウンロードできること
- CSVヘッダーが正しく出力されること
- 商品一覧データが正しく出力されること
- 日本語が文字化けしないこと
- Content-Type が text/csv として返却されること
- テストが全件成功すること
- npm run test:coverage が成功すること
- カバレッジ80%以上を満たしていること
- SQLインジェクション対策が実装されていること
- 入力値バリデーションが実装されていること
- 不要な機密情報がCSVへ出力されていないこと
- Agentごとの成果物を統合しても既存機能へ影響がないこと
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

---

## 実施結果（C-後半）

### 実際に使った構成

| Agent | 実際に担当した内容 | 成果物 |
|----------|----------|----------|
| （統括）メインセッション | 既存コードの調査、API 仕様（パス・レスポンス形式）の事前確定、各 Agent への指示、結果の統合と最終テスト、軽微な追加修正 | ― |
| backend-architect | CSV 出力 API の実装。在庫アラート API は既に実装済みだったため動作確認のみ | `src/routes/products.js`（GET /products/export.csv）、`src/lib/csv.js`（新規） |
| frontend-developer | 在庫アラートバナー、CSV ダウンロードボタン。2周目では CSV 取得を fetch + Blob 方式に変更 | `public/index.html`、`public/js/index.js`、`public/js/api.js`（`Api.getBlob`）、`public/style.css`（末尾に追記のみ） |
| security-auditor | テスト作成、`npm run test:coverage`、セキュリティレビュー、コードレビュー。明確なバグ 1 件を修正 | `__tests__/lib/csv.test.js`、`__tests__/routes/productsExport.test.js` |

### 実際の実行順序

1. 統括が既存コードを調査し、API 仕様（`GET /products/export.csv`、CSV のヘッダー行など）を先に確定した。
2. backend-architect と frontend-developer を**並列**で実行した。設計書では「Backend → Frontend」の順だったが、仕様を先に固めたことで並列にできた。
3. security-auditor がテストの作成とレビューを行い、指摘事項を Critical 〜 Low で報告した。
4. 2周目（指摘の修正）:
   - frontend-developer: CSV 取得を fetch + Blob 方式に変更し、エラーを画面内に表示するようにした。
   - 統括: ダウンロードのキャンセル（クライアント切断）をエラーログから外した。
5. 最終確認: `npm run test:coverage` は 9 スイート・461 件すべて成功。カバレッジは Statements 96.78% / Branches 96.77% / Functions 91.17% / Lines 97.79%。実 DB でアラート API と CSV 出力が動くことも確認した。

### 統合時の確認ポイントの結果

設計書の確認ポイント 15 項目はすべて OK。

### security-auditor の指摘と対応

| 重要度 | 指摘 | 対応 |
|--------|------|------|
| Medium | CSV 出力中にクライアントが切断すると、サーバーの処理が止まったまま残る | 修正済み（security-auditor） |
| Medium | CSV 出力専用のレート制限・同時実行数の上限が無い | 未対応 |
| Low | 1000 件ごとに別々に取得するため、出力中の更新で区切りの前後がずれることがある | 未対応（厳密さが必要なら REPEATABLE READ のトランザクションにまとめる） |
| Low | CSV のエラー時に画面が JSON 表示に切り替わる | 修正済み（fetch + Blob 方式に変更） |
| Low | カバレッジ閾値（coverageThreshold）が未設定 | 未対応 |
| Low | ダウンロードのキャンセルもエラーログになる | 修正済み（情報ログに変更） |

### 気づき

- **仕様を先に固めると並列にできる**: 依存関係は「Backend → Frontend」だったが、統括がパスとレスポンス形式を先に確定して両方に渡したことで、同時に着手できた。
- **設計書・指示と実装を事前に突き合わせる**: 設計書のパスは `/products/export/csv`、Frontend への指示は `/api/products/export.csv` で、どちらも既存の実装（`/api` 接頭辞なし）と合っていなかった。着手前に既存コードを確認し、`/products/export.csv` に統一した。在庫アラート API も既に実装済みだった。着手前の調査を省くと、Agent ごとに違うパスで実装してしまうおそれがあった。
- **Agent への指示は具体的に書く**: 「既存の書き方に合わせる」「CSP でインライン禁止」「innerHTML 禁止」「CSS は末尾に追記のみ」などの制約を明記したことで、統合時の手戻りがほぼ無かった。
- **レビュー専任の Agent は有効**: 実装した Agent 自身は気づかなかった「切断済みの応答への書き込みで処理が止まる」バグを、security-auditor が再現テスト付きで見つけた。
- **Agent 同士の担当ファイルを分ける**: Backend は `src/`、Frontend は `public/` と担当を分けたため、並列で動かしても競合しなかった。
- **Agent の報告はそのまま信じず、統括が確かめる**: 「全件成功」という報告を受けたあとも、統括側で `npm run test:coverage` を実行し直して確認した。
- **Windows ではサーバー停止に注意**: `npm start` のタスクを止めても子プロセスの node が残り、ポート 3000 を使い続けた。個別に停止する必要があった。

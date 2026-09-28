# アーキテクチャ

## 構成

| 層 | 技術 | 配置 |
|----|------|------|
| フロントエンド | HTML / CSS / Vanilla JavaScript | `public/`（Express が静的配信） |
| API サーバー | Node.js + Express | `src/index.js`, `src/routes/` |
| 共通処理 | バリデーション・エラー・レート制限・CSV 生成 | `src/lib/` |
| DB | PostgreSQL（`pg` の接続プール） | `src/db/`, `db/migrations/` |
| テスト | Jest + supertest（DB はモック） | `__tests__/` |

```
ブラウザ ──(同一オリジン)──▶ Express
                              ├─ express.static(public/)   … 画面（HTML/CSS/JS）
                              └─ /products, /stock-transactions … API ──▶ PostgreSQL
```

- API には `/api` 接頭辞は付けていない（`public/js/api.js` の `API_BASE = ''`）。
- 共通ミドルウェア（API のみ、静的ファイルは対象外）:
  - helmet によるセキュリティヘッダー（CSP は `'self'` のみ。インライン script / style は不可）
  - `Cache-Control: no-store`
  - レート制限: 全体 300 回/分、書き込み（POST / PUT / DELETE）60 回/分。超えると 429 を返す
  - JSON ボディは 10kb まで。POST / PUT では `Content-Type: application/json` が必須
- エラーは共通形式 `{ "error": { "message": string, "details": [{ field, message }] } }` で返す。5xx のときは `details` を常に空にする。

## APIエンドポイント一覧

| メソッド | パス | 概要 | 主なステータス |
|----------|------|------|----------------|
| GET | /products | 商品一覧（商品ID昇順、ページング） | 200 / 400 |
| GET | /products/alerts | 在庫アラート対象（threshold = '1'）の商品一覧（ページング） | 200 / 400 |
| GET | /products/export.csv | 在庫一覧を CSV でダウンロード（全件）**【C-後半で追加】** | 200 / 503 |
| GET | /products/:id | 商品詳細 | 200 / 400 / 404 |
| POST | /products | 商品登録（threshold は stock から自動算出） | 201 / 400 / 409 |
| PUT | /products/:id | 商品名・在庫数の部分更新（stock を更新すると threshold も再算出） | 200 / 400 / 404 |
| DELETE | /products/:id | 商品削除（入出庫履歴があると削除不可） | 204 / 400 / 404 / 409 |
| POST | /stock-transactions | 入庫・出庫の記録（在庫と threshold も同時に更新） | 201 / 400 / 404 / 409 |
| GET | /stock-transactions | 入出庫履歴一覧（`?product_id=` で絞り込み、ページング） | 200 / 400 |
| GET | /stock-transactions/:id | 入出庫履歴詳細 | 200 / 400 / 404 |

共通: 429（レート制限超過）、500 / 503（サーバー・DB エラー）。

### ページング（一覧 API 共通）

- キーセット方式。`?limit=1〜500`（既定 100）、`?after=<前のページの meta.next_after>`。
- レスポンスは `{ "data": [...], "meta": { "limit": n, "next_after": string | null } }`。`next_after` が null なら最後のページ。

### GET /products/alerts（在庫アラート）

- 条件は `threshold = '1'`（在庫10未満）。プレースホルダ付きのクエリで取得する。
- 対象が 0 件でも 200 を返し、`data` は空配列になる。
- ルートは `/:id` より前に定義している。`alerts` は商品IDの予約語で、登録できない。

### GET /products/export.csv（CSV 出力）

| 項目 | 内容 |
|------|------|
| Content-Type | `text/csv; charset=utf-8` |
| Content-Disposition | `attachment; filename="products_YYYYMMDD.csv"`（日付は日本時間） |
| 文字コード・改行 | UTF-8（BOM 付き。Excel で文字化けしない）、CRLF（RFC 4180） |
| ヘッダー行 | `商品ID,商品名,在庫数,在庫アラート` |
| 在庫アラート列 | threshold '1' → 「在庫少」 / それ以外 → 空欄 |
| 出力対象 | 上記 4 列のみ（カラムはホワイトリストで固定）。商品ID昇順で全件。クエリパラメータは無視する |

- エスケープ: `"` `,` 改行を含む値は `"..."` で囲み、中の `"` は `""` にする。
- CSV インジェクション対策: `= + - @ タブ CR` で始まる文字列セルは、先頭に `'` を付けて数式として実行されないようにする。
- 大量件数対策: 1000 件ずつキーセット方式で取得して順に書き出す。送信バッファが詰まったら drain を待つ。
- エラー時:
  - 最初の取得（ヘッダー送信前）で失敗した場合は、共通の JSON エラーを返す。
  - 書き出し開始後の DB エラーは、エラーログを出して接続を切断する。途中までの CSV を完全なファイルに見せないため。
  - クライアント側の切断（ダウンロードのキャンセル等）はエラーとして扱わない。情報ログを 1 行残すだけにしている。
- 実装: `src/routes/products.js`（ルート）、`src/lib/csv.js`（エスケープ・行生成）。

## DBスキーマ

マイグレーションは `db/migrations/` に番号順で置いている。各ファイルに対応する `_down.sql`（ロールバック用）がある。

| 番号 | 内容 |
|------|------|
| 001 | M_PRODUCTS（商品マスタ）作成 |
| 002 | T_STOCK_TRANSACTIONS（入出庫履歴）作成 |
| 003 | threshold をアラート有無フラグ（'0' / '1'）に変更 |
| 004 | 履歴ID採番用シーケンス SEQ_RIREKI_ID 作成 |

C-後半の追加機能（在庫アラート・CSV 出力）は既存テーブルの参照だけで実現した。そのため、スキーマの変更やマイグレーションの追加はしていない。

### M_PRODUCTS（商品マスタ）

| 論理名 | カラム名 | 型 | 制約 |
|--------|----------|----|------|
| 商品ID | product_id | VARCHAR(10) | PRIMARY KEY（英数字・`_`・`-` の 1〜10 文字。`alerts` は予約語） |
| 商品名 | product_name | VARCHAR(100) | NOT NULL（前後の空白を除いて 1〜100 文字、制御文字は不可） |
| 在庫数 | stock | INTEGER | NOT NULL, DEFAULT 0, CHECK (stock >= 0) |
| 在庫アラート閾値 | threshold | VARCHAR(1) | NOT NULL, CHECK (threshold IN ('0','1')) |

- threshold はサーバー側で stock から算出する（'0' = 在庫10以上、'1' = 在庫10未満）。

### T_STOCK_TRANSACTIONS（入出庫履歴）

| 論理名 | カラム名 | 型 | 制約 |
|--------|----------|----|------|
| 履歴ID | rireki_id | VARCHAR(10) | PRIMARY KEY（サーバー採番: `R` + 9桁ゼロ埋め） |
| 商品ID | product_id | VARCHAR(10) | NOT NULL, FOREIGN KEY → M_PRODUCTS.product_id（ON DELETE / ON UPDATE RESTRICT） |
| 取引種別 | transaction_type | VARCHAR(1) | NOT NULL, CHECK IN ('0','1')（0: 入庫 / 1: 出庫） |
| 数量 | quantity | INTEGER | NOT NULL, CHECK (quantity > 0) |

- インデックス: `idx_t_stock_transactions_product_id`（product_id）
- 外部キーを RESTRICT にしているのは、監査・棚卸の根拠となる履歴を失わないため。履歴がある商品は削除できず、API は 409 を返す。

### SEQ_RIREKI_ID（シーケンス）

- INTEGER、1〜999999999、NO CYCLE。`'R' || LPAD(nextval('seq_rireki_id')::text, 9, '0')` の形で履歴IDを採番する。
- シーケンスはロールバックしても巻き戻らないため、欠番が出ることがある（仕様として許容）。

## 画面と API の対応

| 画面 | 使用 API |
|------|----------|
| 商品一覧（index.html） | GET /products, GET /products/alerts（一覧の絞り込み・アラートバナー）, GET /products/export.csv |
| 商品登録／入出庫（form.html） | POST /products, POST /stock-transactions, GET /products |
| 商品詳細（detail.html?id=） | GET /products/:id, PUT /products/:id, DELETE /products/:id, GET /stock-transactions?product_id=, POST /stock-transactions |

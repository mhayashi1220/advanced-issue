-- =============================================================================
-- マイグレーション 002: 入出庫履歴（T_STOCK_TRANSACTIONS）の作成
-- -----------------------------------------------------------------------------
-- 概要  : 商品ごとの入庫・出庫の記録を保持する入出庫履歴テーブルを作成する。
-- 出典  : docs/requirements.md「DBテーブル設計 ② T_STOCK_TRANSACTIONS」
-- 前提  : 001_create_m_products.sql が適用済みであること。
-- 備考  : テーブル名・カラム名は引用符なしで記述しているため、PostgreSQL では
--         小文字（t_stock_transactions 等）に畳み込まれて作成される。
-- ロールバック: 002_create_t_stock_transactions_down.sql を実行する。
--
-- 【外部キーの ON DELETE / ON UPDATE 挙動の選定理由】
--   ON DELETE RESTRICT を採用する。
--     - DELETE /products/:id が存在するが、CASCADE にすると商品削除と同時に
--       入出庫履歴が消え、監査・棚卸の根拠となる履歴が失われる。
--     - SET NULL は product_id が NOT NULL（定義書の制約）のため使用できず、
--       仮に使えても「どの商品の取引か」が不明な履歴になり意味をなさない。
--     - よって履歴が1件でも存在する商品の物理削除は DB で拒否する。
--       API 側では外部キー違反（SQLSTATE 23503）を捕捉し 409 Conflict を返す。
--     - NO ACTION ではなく RESTRICT としたのは、遅延評価の余地を残さず
--       文の実行時点で即座に拒否することを明示するため。
--   ON UPDATE RESTRICT を採用する。
--     - 商品IDは主キーであり、PUT /products/:id の更新対象（商品名・在庫数・
--       閾値）にも含まれないため、変更されない前提とする。
--     - 誤って主キーを変更した場合に履歴側が暗黙に書き換わることを防ぐ。
-- =============================================================================

BEGIN;

CREATE TABLE T_STOCK_TRANSACTIONS (
    rireki_id        VARCHAR(10) NOT NULL,
    product_id       VARCHAR(10) NOT NULL,
    transaction_type VARCHAR(1)  NOT NULL,
    quantity         INTEGER     NOT NULL,

    -- 主キー：履歴ID
    CONSTRAINT pk_t_stock_transactions PRIMARY KEY (rireki_id),

    -- 外部キー：商品ID → 商品マスタ.商品ID（選定理由はファイル先頭を参照）
    CONSTRAINT fk_t_stock_transactions_product_id
        FOREIGN KEY (product_id)
        REFERENCES M_PRODUCTS (product_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT,

    -- 取引種別のコード値制約
    --   '0' = 入庫 / '1' = 出庫
    CONSTRAINT ck_t_stock_transactions_type_code CHECK (transaction_type IN ('0', '1')),

    -- 数量は正の整数のみ（入庫/出庫の向きは transaction_type で表現する）
    CONSTRAINT ck_t_stock_transactions_quantity_positive CHECK (quantity > 0)
);

-- 商品IDでの履歴検索・外部キー検証（親の削除時チェック）の高速化用インデックス
-- ※ PostgreSQL は外部キー参照元の列に自動でインデックスを作成しないため明示的に作成する
CREATE INDEX idx_t_stock_transactions_product_id
    ON T_STOCK_TRANSACTIONS (product_id);

-- 論理名の付与
COMMENT ON TABLE  T_STOCK_TRANSACTIONS                  IS '入出庫履歴';
COMMENT ON COLUMN T_STOCK_TRANSACTIONS.rireki_id        IS '履歴ID';
COMMENT ON COLUMN T_STOCK_TRANSACTIONS.product_id       IS '商品ID（商品マスタ.商品ID を参照）';
COMMENT ON COLUMN T_STOCK_TRANSACTIONS.transaction_type IS '取引種別（0:入庫, 1:出庫）';
COMMENT ON COLUMN T_STOCK_TRANSACTIONS.quantity         IS '数量（1以上）';

COMMIT;

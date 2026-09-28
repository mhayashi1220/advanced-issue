-- =============================================================================
-- マイグレーション 001: 商品マスタ（M_PRODUCTS）の作成
-- -----------------------------------------------------------------------------
-- 概要  : 在庫管理アプリの商品マスタを作成する。
-- 出典  : docs/requirements.md「DBテーブル設計 ① M_PRODUCTS」
-- 備考  : テーブル名・カラム名は引用符なしで記述しているため、PostgreSQL では
--         小文字（m_products 等）に畳み込まれて作成される。アプリ側の SQL でも
--         引用符なし、または小文字で参照すること。
-- ロールバック: 001_create_m_products_down.sql を実行する。
-- =============================================================================

BEGIN;

CREATE TABLE M_PRODUCTS (
    product_id   VARCHAR(10)  NOT NULL,
    product_name VARCHAR(100) NOT NULL,
    stock        INTEGER      NOT NULL DEFAULT 0,
    threshold    VARCHAR(1)   NOT NULL,

    -- 主キー：商品ID
    CONSTRAINT pk_m_products PRIMARY KEY (product_id),

    -- 在庫数はマイナス不可（出庫・PUT 更新時の在庫マイナスを DB レベルでも防止する）
    CONSTRAINT ck_m_products_stock_non_negative CHECK (stock >= 0),

    -- 在庫アラート閾値のコード値制約
    --   '0' = 在庫10以上 / '1' = 在庫10未満 / '2' = 在庫0
    CONSTRAINT ck_m_products_threshold_code CHECK (threshold IN ('0', '1', '2'))
);

-- 論理名の付与
COMMENT ON TABLE  M_PRODUCTS              IS '商品マスタ';
COMMENT ON COLUMN M_PRODUCTS.product_id   IS '商品ID';
COMMENT ON COLUMN M_PRODUCTS.product_name IS '商品名';
COMMENT ON COLUMN M_PRODUCTS.stock        IS '在庫数（0以上）';
COMMENT ON COLUMN M_PRODUCTS.threshold    IS '在庫アラート閾値（0:在庫10以上, 1:在庫10未満, 2:在庫0）';

COMMIT;

-- =============================================================================
-- マイグレーション 003: 在庫アラート閾値（threshold）をアラート有無フラグに変更
-- -----------------------------------------------------------------------------
-- 概要  : threshold のコード値から '2'（在庫0）を廃止し、アラートの有無を表す
--         2値フラグとする。
--           '0' = 在庫10以上（アラートなし）
--           '1' = 在庫10未満（アラート発生状態）
--         在庫0も「在庫10未満」に含まれるため '1' とする。
-- 前提  : 001_create_m_products.sql が適用済みであること。
--         threshold = '2' のデータが存在する場合、制約追加でエラーとなる。
-- ロールバック: 003_alter_m_products_threshold_to_alert_flag_down.sql を実行する。
-- =============================================================================

BEGIN;

-- 旧コード値制約（'0','1','2'）を削除し、新コード値制約（'0','1'）を追加する
ALTER TABLE M_PRODUCTS DROP CONSTRAINT ck_m_products_threshold_code;

ALTER TABLE M_PRODUCTS
    ADD CONSTRAINT ck_m_products_threshold_code CHECK (threshold IN ('0', '1'));

-- 論理名・コード値の説明を更新
COMMENT ON COLUMN M_PRODUCTS.threshold IS '在庫アラート閾値（0:在庫10以上, 1:在庫10未満＝アラート発生）';

COMMIT;

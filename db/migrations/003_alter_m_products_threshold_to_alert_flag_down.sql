-- =============================================================================
-- マイグレーション 003 DOWN: 在庫アラート閾値（threshold）のコード値制約を元に戻す
-- -----------------------------------------------------------------------------
-- 概要  : 003_alter_m_products_threshold_to_alert_flag.sql のロールバック。
--         コード値制約を 001 時点の '0','1','2' に戻す。
-- =============================================================================

BEGIN;

ALTER TABLE M_PRODUCTS DROP CONSTRAINT ck_m_products_threshold_code;

ALTER TABLE M_PRODUCTS
    ADD CONSTRAINT ck_m_products_threshold_code CHECK (threshold IN ('0', '1', '2'));

COMMENT ON COLUMN M_PRODUCTS.threshold IS '在庫アラート閾値（0:在庫10以上, 1:在庫10未満, 2:在庫0）';

COMMIT;

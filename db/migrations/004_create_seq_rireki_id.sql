-- =============================================================================
-- マイグレーション 004: 履歴ID（rireki_id）採番用シーケンス（SEQ_RIREKI_ID）の作成
-- -----------------------------------------------------------------------------
-- 概要  : T_STOCK_TRANSACTIONS.rireki_id をサーバー側で採番するためのシーケンスを
--         作成する。アプリ側では次の式で履歴IDを生成する。
--           'R' || LPAD(nextval('seq_rireki_id')::text, 9, '0')
--           例: R000000001
-- 前提  : 002_create_t_stock_transactions.sql が適用済みであること。
-- 備考  : - rireki_id は VARCHAR(10) のため、'R' + 9桁 = 10文字が上限となる。
--           MAXVALUE を 999999999 とし、NO CYCLE で上限到達時はエラーにする
--           （周回して既存の履歴IDと重複することを防ぐ）。
--         - シーケンスはトランザクションのロールバックで巻き戻らないため、
--           出庫エラー等で欠番が発生することがある（仕様上許容する）。
--         - シーケンス名は引用符なしで記述しているため、小文字（seq_rireki_id）で
--           作成される。
-- ロールバック: 004_create_seq_rireki_id_down.sql を実行する。
-- =============================================================================

BEGIN;

CREATE SEQUENCE SEQ_RIREKI_ID
    AS INTEGER
    START WITH 1
    INCREMENT BY 1
    MINVALUE 1
    MAXVALUE 999999999
    NO CYCLE;

-- 論理名の付与
COMMENT ON SEQUENCE SEQ_RIREKI_ID IS '履歴ID採番用シーケンス（R + 9桁ゼロ埋めで使用）';

COMMIT;

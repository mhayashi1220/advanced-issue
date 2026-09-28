# 要件定義書

## システム概要
このアプリが何をするか：在庫の管理
誰が使うか：在庫管理者

## 画面一覧
画面①
商品一覧画面（index.html）
画面②
商品登録／入出庫フォーム（form.html）


## APIエンドポイント一覧

| メソッド   | パス                      | 概要                    |
| ------ | ----------------------- | --------------------- |
| GET    | /products               | 商品一覧を取得する             
| GET    | /products/:id           | 商品詳細を取得する             
| POST   | /products               | 商品を登録する               
| PUT    | /products/:id           | 商品情報（商品名・在庫数・閾値）を更新する 
| DELETE | /products/:id           | 商品を削除する               
| GET    | /products/alerts        | 在庫数が閾値を下回った商品一覧を取得する  
| POST   | /stock-transactions     | 入庫・出庫を記録する            
| GET    | /stock-transactions     | 入出庫履歴一覧を取得する          
| GET    | /stock-transactions/:id | 入出庫履歴詳細を取得する          


## DBテーブル設計
（テーブル名・カラム名・型・制約）
①物理名：M_PRODUCTS　論理名：商品マスタ
| 論理名   | カラム名             | 型           | 制約                |
| -------- | -------------        | ------------ | ------------------- |
| 商品ID   | product\_id          | VARCHAR(10)  | PRIMARY KEY         |
| 商品名   | product\_name        | VARCHAR(100) | NOT NULL            |
| 在庫数   | stock                | INTEGER      | NOT NULL, DEFAULT 0 |
| 在庫アラート閾値 | threshold    | VARCHAR(1)   | NOT NULL            |



②物理名：T_STOCK_TRANSACTIONS 論理名：入出庫履歴
| 論理名  | カラム名          | 型          | 制約                  |
| ----    | ----------------- | ----------- | --------------------- |
| 履歴ID  | rireki\_id        | VARCHAR(10) | PRIMARY KEY           |
| 商品ID  | product\_id       | VARCHAR(10) | NOT NULL, FOREIGN KEY |
| 取引種別| transaction\_type | VARCHAR(1)  | NOT NULL              |
| 数量    | quantity          | INTEGER     | NOT NULL              |



## 状態遷移（該当するテーマのみ）
（ステータスがどう変化するか）
①在庫アラート閾値
0：在庫10以上
1：在庫が10未満の状態 

②取引種別
0：入庫
1：出庫
### 課題C：在庫管理アプリ

- ゴール（c-前半）：ローカルで基本CRUDとフロントエンドが動く状態
- ゴール（c-後半）：追加機能実装・EC2デプロイ完了
- 分解（c-前半）：
   - STEP1 要件定義書作成
    - 検証： 要件定義書が作成すること
    - 失敗予測：実装工程になり考慮不足が発覚する
   - STEP2 Subagent定義
    - 検証：  
    - 失敗予測：
  - STEP3 DB設計・マイグレーション
      - 検証：各テーブルが実装されること
      - 失敗予測：マイグレーションSQLの実行順序を誤る
  - STEP4 基本CRUD実装
      - 検証：各CRUDの実装が完了すること
      - 失敗予測：エラーハンドリング不足による異常終了
  - STEP5 テスト追加
      - 検証： npm run test:coverage が実行できること
      - 失敗予測：npm run test:coverage が実行できること
  - STEP6 フロントエンド実装
      - 検証：各画面が実装されること
      - 失敗予測：APIエンドポイント指定ミス
                 修正箇所が多く実行に20分以上かかった。
### 課題C-後半：追加機能実装
 
- Agent Teamsへの依頼内容：
    Agent Teamを作成して、以下の追加機能を実装してください。

    【設計書】
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

    【Agent構成】
    | backend-architect | バックエンド実装担当 | 在庫アラートAPI実装、CSV出力API実装、データ取得処理実装 |
    | frontend-developer | フロントエンド実装担当 | 在庫アラート表示機能、CSV出力機能を実装|
    | security-auditor | テスト、レビュー担当 | テスト実施、セキュリティレビュー、コードレビュー |

    各Agentの結果を統合して、最終的に動作するコードにしてください。

    Frontend Agentへの指示：

    - public/index.html の一覧画面上部に在庫アラートバナーを追加する
    （/api/products/alerts を fetch して閾値割れ商品を表示）

    - 一覧画面に「CSV ダウンロード」ボタンを追加するac
    （window.location.href = '/api/products/export.csv' で実装）

    - 既存のスタイル（public/style.css）を崩さないこと
- 各Agentの出力で気になった点：
- Backend Agent：なし
- Frontend Agent：アラート表示の商品名が他の文字より不自然に大きく違和感があった
- 統合時に自分で修正した箇所：なし
- 期待と違った箇所・なぜそうなったか：
    入出庫履歴がある場合、商品を削除できなかった
    理由はDB設計漏れ（商品マスタを参照する外部キーで、ON DELETE RESTRICT が付いていたから）
    削除フラグをテーブルごとに持ち、削除は論理削除で行えるように設計すべきだった

## EC2デプロイ
　　手順は初めにSSHにつなぐことだけわかりましたが、つなぎ方やそれ以降の手順はわからずすべて資料を見ました。
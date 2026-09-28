// 在庫管理アプリ API サーバーのエントリポイント
// テストから利用できるよう app をエクスポートし、直接実行時のみ listen する

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const pool = require('./db/pool');
const { ApiError, fromPgError } = require('./lib/errors');
const { createRateLimiters } = require('./lib/rateLimit');
const productsRouter = require('./routes/products');
const stockTransactionsRouter = require('./routes/stockTransactions');

const app = express();

// フレームワーク情報をレスポンスヘッダに出さない
app.disable('x-powered-by');

// ---- セキュリティヘッダー（画面・API の全レスポンスに付ける） ----
// public/ の画面はインラインの script / style / style 属性を使っていないため、
// 'unsafe-inline' なしの CSP で動作する。
// useDefaults: false により helmet 既定の upgrade-insecure-requests 等は付けない
// （HTTP で公開した場合に画面の読み込みが壊れないようにするため）。
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  },
  // CSP の frame-ancestors 'none' に合わせ、古いブラウザ向けの X-Frame-Options も DENY にする
  xFrameOptions: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
  // X-Content-Type-Options: nosniff は helmet の既定で付く
}));

// フロントエンド画面（public/ 配下の HTML・CSS・JS）を静的ファイルとして配信する
// 起動時のカレントディレクトリに左右されないよう、このファイルの位置から絶対パスを組み立てる
// ※ レート制限・Cache-Control: no-store の対象外とするため、それらより前に置く
app.use(express.static(path.join(__dirname, '..', 'public')));

// ここから下は API（と 404）のレスポンス
// 在庫数などの業務データをブラウザや中間キャッシュに残さない
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// レート制限（全体 → 書き込み の順に判定する。超過時は 429）
const { globalLimiter, writeLimiter } = createRateLimiters(process.env);
app.use(globalLimiter);
app.use(writeLimiter);

// JSON ボディのパース（サイズ上限 10kb。超過時は 413 を返す）
// strict: true（既定）により、トップレベルがオブジェクト/配列以外の JSON は解析エラーになる
app.use(express.json({ limit: '10kb', strict: true }));

// ボディを受け取るメソッドでは Content-Type: application/json を必須とする
// （JSON 以外で送られると req.body が空となり、原因が分かりにくいエラーになるため）
app.use((req, res, next) => {
  if ((req.method === 'POST' || req.method === 'PUT') && !req.is('application/json')) {
    return next(new ApiError(400, 'Content-Type は application/json を指定し、JSON オブジェクトを送信してください', [
      { field: 'body', message: 'JSON オブジェクトである必要があります' },
    ]));
  }
  next();
});

// ルーティング
app.use('/products', productsRouter);
app.use('/stock-transactions', stockTransactionsRouter);

// 404 ハンドラ（どのルートにも一致しなかった場合）
// リクエストされたパスは応答に含めない（入力値の反射を避ける）
app.use((req, res, next) => {
  next(new ApiError(404, 'リソースが見つかりません'));
});

// body-parser 等が返すクライアントエラー（4xx）の固定メッセージ
// err.message には Content-Type の charset など入力値が含まれるため、そのまま返さない
const CLIENT_ERROR_MESSAGES = {
  400: 'リクエストが不正です',
  415: '対応していない文字コードまたは圧縮形式です。UTF-8 の JSON を送信してください',
};

// 共通エラーハンドラ（引数4つで Express にエラーハンドラと認識させる）
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let apiError;

  if (err instanceof ApiError) {
    apiError = err;
  } else if (err instanceof URIError) {
    // パスの不正なパーセントエンコード（例: /products/%E0）。Express のパラメータ展開で発生する
    apiError = new ApiError(400, 'URL の形式が不正です');
  } else if (err.type === 'entity.parse.failed') {
    // 壊れた JSON
    apiError = new ApiError(400, 'リクエストボディの JSON が不正です', [
      { field: 'body', message: 'JSON として解析できません' },
    ]);
  } else if (err.type === 'entity.too.large') {
    apiError = new ApiError(413, 'リクエストボディが大きすぎます');
  } else if (err.expose && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    // body-parser 等が返すその他のクライアントエラー（文字コード不正など）
    apiError = new ApiError(err.status, CLIENT_ERROR_MESSAGES[err.status] || CLIENT_ERROR_MESSAGES[400]);
  } else {
    // DB エラーコードの変換（23505→409, 55P03→409, 57014→503 など）と接続取得タイムアウト（503）
    apiError = fromPgError(err);
  }

  if (!apiError) {
    // 想定外のエラー：詳細（スタック・SQL 等）はサーバーログにのみ出力する
    console.error(`[500] ${req.method} ${req.originalUrl}`, err);
    apiError = new ApiError(500, 'サーバー内部でエラーが発生しました');
  } else if (apiError.status >= 500) {
    // 503 など：原因はサーバーログにのみ出力し、応答は固定メッセージにする
    console.error(`[${apiError.status}] ${req.method} ${req.originalUrl}`, err);
  } else if (!(err instanceof ApiError) && err.code) {
    // DB 由来のクライアントエラーは原因調査用にコードだけ記録する
    console.warn(`[${apiError.status}] ${req.method} ${req.originalUrl} pg=${err.code || '-'} ${err.constraint || ''}`);
  }

  res.status(apiError.status).json({
    error: {
      message: apiError.message,
      // 5xx では details に内部情報が入らないよう、常に空配列にする
      details: apiError.status >= 500 ? [] : (apiError.details || []),
    },
  });
});

// 直接実行されたときだけサーバーを起動する
if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || 3000;
  const server = app.listen(port, () => {
    console.log(`在庫管理APIサーバー起動: http://localhost:${port}`);
  });

  // 終了シグナル受信時は新規接続を止め、DB プールを閉じてから終了する
  const shutdown = (signal) => {
    console.log(`${signal} を受信したため終了します`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = app;

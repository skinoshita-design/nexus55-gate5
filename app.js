// アプリ起動: npm start
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { openDb } = require('./src/db');
const { createLendingService } = require('./src/services/lendingService');
const { PAGE_ERRORS, msg } = require('./src/constants/messages');
const { slash, slashDateTime } = require('./src/dates');

function createApp({ db, service }) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use('/static', express.static(path.join(__dirname, 'public')));

  // 動作確認用のユーザー切替(画面にはUIを置かない)。ログイン機能は範囲外のため Cookie で代用する
  // 例: /login?user_id=1 → 山田 太郎として操作
  app.get('/login', (req, res) => {
    const employee = service.findEmployee(Number(req.query.user_id));
    if (!employee) return res.status(400).send('user_id が不正です。');
    // 8 時間で期限切れ(E-33)
    res.cookie('user_id', String(employee.id), { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 });
    res.send(`${employee.name}(${employee.employee_code})としてログインしました。`);
  });

  // 処理結果を次の画面表示まで保持する
  function setFlash(res, flash) {
    res.cookie('flash', JSON.stringify(flash), { httpOnly: true });
  }
  function takeFlash(req, res) {
    if (!req.cookies.flash) return null;
    res.clearCookie('flash');
    try { return JSON.parse(req.cookies.flash); } catch (e) { return null; }
  }

  // 全画面エラー(エラーページ)
  function showError(res, result) {
    res.status(PAGE_ERRORS[result.id] || 500).render('error', { user: res.locals.user || null, result });
  }
  // 結果がエラーページ向けのメッセージか
  const isPageError = (result) => !!PAGE_ERRORS[result.id];

  // 操作者は常に Cookie(ログイン情報)から取得する。リクエスト中の user_id は使わない(R-09)
  function requireUser(req, res, next) {
    const id = Number(req.cookies.user_id);
    if (!id) return showError(res, msg('E-33'));
    const employee = service.findEmployee(id);
    if (!employee) return showError(res, msg('E-10'));
    req.user = employee;
    res.locals.user = employee;
    next();
  }

  // V-07:確認画面・完了画面はキャッシュさせない
  const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };

  // 貸出申請画面を描画する
  function renderApply(req, res, { values = {}, banner = null, inline = {}, flash = null }) {
    const ctx = service.getApplyContext(req.user.id);
    res.render('apply', {
      user: req.user,
      flash,
      banner: banner || ctx.blocker || null,
      blocked: !!ctx.blocker,
      devices: ctx.devices,
      noDevices: ctx.devices.length === 0,
      values,
      inline,
    });
  }

  app.get('/', (req, res) => res.redirect('/lendings/new'));

  // ---- 貸出 -----------------------------------------------------------------

  // 貸出申請画面(V-01〜V-04・V-06)
  app.get('/lendings/new', requireUser, (req, res) => {
    const flash = takeFlash(req, res);
    const restored = service.getRestore(req.user.id, req.query.restore);
    const values = restored
      ? { deviceId: String(restored.device_id), dueDate: slash(restored.due_date), purpose: restored.purpose }
      : {};
    renderApply(req, res, { values, flash });
  });

  // 申請 → 確認画面(入力チェック。OK ならトークン発行して確認画面へ)
  app.post('/lendings/confirm', requireUser, (req, res) => {
    const input = {
      userId: req.user.id,
      deviceId: req.body.device_id,
      dueDate: req.body.due_date,
      purpose: req.body.purpose,
    };
    const result = service.createConfirmation(input);
    if (result.ok) return res.redirect(303, `/lendings/confirm/${result.token}`);
    if (isPageError(result)) return showError(res, result);
    const values = { deviceId: String(input.deviceId ?? ''), dueDate: String(input.dueDate ?? ''), purpose: String(input.purpose ?? '') };
    return renderApply(req, res, { values, banner: result.inline ? null : result, inline: result.inline || {} });
  });

  // 確認画面
  app.get('/lendings/confirm/:token', requireUser, noStore, (req, res) => {
    const result = service.getConfirmation(req.user.id, req.params.token);
    if (!result.ok) return showError(res, result);
    res.render('confirm', {
      user: req.user,
      token: req.params.token,
      device: result.device,
      dueDate: slash(result.request.due_date),
      purpose: result.request.purpose,
    });
  });

  // 確定。受け取るのは確認トークンのみ(R-15)。端末・返却予定日・利用目的はサーバー保存分を使う
  app.post('/lendings/commit', requireUser, (req, res) => {
    const token = req.body.token;
    const result = service.commit({ userId: req.user.id, token });
    if (result.ok) {
      if (result.replay) setFlash(res, { notice: msg('E-14').text });
      return res.redirect(303, `/lendings/${result.lendingId}/complete`);
    }
    if (isPageError(result)) return showError(res, result);
    // E-02・E-23 ほかのバナーエラー:入力値を保持して申請画面へ
    setFlash(res, { type: 'error', text: result.text });
    return res.redirect(303, `/lendings/new?restore=${encodeURIComponent(token)}`);
  });

  // 貸出完了画面(S-01)
  app.get('/lendings/:id/complete', requireUser, noStore, (req, res) => {
    const result = service.getOwnLending(req.user.id, req.params.id);
    if (!result.ok) return showError(res, result);
    const flash = takeFlash(req, res);
    const { lending } = result;
    res.render('complete', {
      user: req.user,
      message: msg('S-01', { assetNo: lending.asset_no, dueDate: lending.due_date }).text,
      notice: flash && flash.notice,
    });
  });

  // ---- 返却 -----------------------------------------------------------------

  // 返却画面(V-08・V-09)
  app.get('/returns', requireUser, (req, res) => {
    const flash = takeFlash(req, res);
    const lendings = service.listOpenLendings(req.user.id).map((l) => ({
      ...l,
      lentAtLabel: slashDateTime(l.lent_at),
      dueDateLabel: slash(l.due_date),
    }));
    res.render('returns', { user: req.user, flash, lendings });
  });

  // 返却の確定
  app.post('/returns', requireUser, (req, res) => {
    const result = service.returnLending({ userId: req.user.id, lendingId: req.body.lending_id });
    if (result.ok) return res.redirect(303, `/returns/${result.lendingId}/complete`);
    if (isPageError(result)) return showError(res, result);
    setFlash(res, { type: 'error', text: result.text });
    return res.redirect(303, '/returns');
  });

  // 返却完了画面(S-02 / 延滞していた場合は S-03)
  app.get('/returns/:id/complete', requireUser, noStore, (req, res) => {
    const result = service.getOwnLending(req.user.id, req.params.id);
    if (!result.ok) return showError(res, result);
    const { lending } = result;
    if (!lending.returned_at) return showError(res, msg('E-25'));
    const days = service.overdueDaysAtReturn(lending);
    // S-03 は S-02 の文言に「返却期限を N 日過ぎています。」を続けたもの。後半を黄色の注記で表示する(V-10)
    const returned = msg('S-02', { assetNo: lending.asset_no }).text;
    const notice = days > 0 ? msg('S-03', { assetNo: lending.asset_no, days }).text.slice(returned.length) : null;
    res.render('return_complete', { user: req.user, message: returned, notice });
  });

  // 想定外の例外(N-05:詳細は画面に出さない)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    showError(res, msg('E-30'));
  });

  return app;
}

if (require.main === module) {
  const db = openDb();
  const service = createLendingService(db);
  const app = createApp({ db, service });
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`http://localhost:${PORT} で起動しました`);
  });
}

module.exports = { createApp };

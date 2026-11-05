// 例外系シナリオの自動テスト: npm test
// 要件定義書(docs/02_例外系仕様書.md)と洗い出し表(docs/01_例外系洗い出し表.md)の No に対応させている
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDb, makeNoAvailableDevices } = require('../src/db');
const { createLendingService } = require('../src/services/lendingService');
const { createApp } = require('../app');
const { MESSAGES, msg } = require('../src/constants/messages');

// 固定する「今」:2026/04/06(月)10:00 日本時間。翌日は火曜、14 日後は月曜、土曜は 4/11
const NOW = '2026-04-06T10:00:00+09:00';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate5-'));
let seq = 0;

function makeClock(iso = NOW) {
  return { t: new Date(iso), now() { return this.t; } };
}
function fresh({ failTx = false } = {}) {
  const clock = makeClock();
  const filePath = path.join(tmpDir, `t${(seq += 1)}.sqlite`);
  const db = openDb({ filePath, clock });
  const service = createLendingService(db, { clock, failTx: () => failTx });
  return { db, service, clock, filePath };
}
const input = (over = {}) => ({
  userId: 1, deviceId: 1, dueDate: '2026/04/07', purpose: '出張', ...over,
});
const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;
const openLendings = (db) => count(db, 'SELECT COUNT(*) AS n FROM lendings WHERE returned_at IS NULL');

// 申請 → 確認 → 確定までを行う
function lend(service, over = {}) {
  const c = service.createConfirmation(input(over));
  assert.ok(c.ok, `確認に進めない: ${c.id} ${c.text}`);
  const r = service.commit({ userId: over.userId || 1, token: c.token });
  return { token: c.token, result: r };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- ① 在庫・状態
test('No.1 貸出中の端末を選ぶと E-01(確認遷移時)', () => {
  const { service } = fresh();
  const r = service.createConfirmation(input({ deviceId: 3 }));
  assert.equal(r.id, 'E-01');
  assert.equal(r.text, 'この端末は現在貸出中です。別の端末を選択してください。');
});
test('No.2-6 修理中/廃棄済み/存在しない/対象外の端末', () => {
  const { service } = fresh();
  assert.equal(service.createConfirmation(input({ deviceId: 5 })).text, 'PC-0005 は修理中のため貸出できません。');
  assert.equal(service.createConfirmation(input({ deviceId: 6 })).text, 'PC-0006 は廃棄済みのため貸出できません。');
  assert.equal(service.createConfirmation(input({ deviceId: 999 })).id, 'E-05');
  assert.equal(service.createConfirmation(input({ deviceId: 11 })).id, 'E-06'); // TABLET
  assert.equal(service.createConfirmation(input({ deviceId: 12 })).id, 'E-06'); // MONITOR
});
test('No.5 貸出可能な端末が 0 件のとき一覧が空になり、プルダウン用の端末が返らない', () => {
  const { db, service } = fresh();
  makeNoAvailableDevices(db);
  assert.equal(service.getApplyContext(1).devices.length, 0);
});
test('No.2,3,6 プルダウンに出る端末は LAPTOP かつ AVAILABLE のみ', () => {
  const { service } = fresh();
  const ids = service.getApplyContext(1).devices.map((d) => d.asset_no);
  assert.deepEqual(ids, ['PC-0001', 'PC-0002', 'PC-0007', 'PC-0008', 'PC-0009', 'PC-0010']);
});

// ---------------------------------------------------------------- ② 人の状態
test('No.7-10 退職/休職/社員なし/延滞中/1人1台', () => {
  const { service } = fresh();
  assert.equal(service.createConfirmation(input({ userId: 3 })).id, 'E-08');
  assert.equal(service.createConfirmation(input({ userId: 8 })).id, 'E-09');
  assert.equal(service.createConfirmation(input({ userId: 999 })).id, 'E-10');
  const overdue = service.createConfirmation(input({ userId: 4 }));
  assert.equal(overdue.id, 'E-12');
  assert.match(overdue.text, /^返却期限（2026\/04\/03）を過ぎた端末 PC-0003 があります。先に返却してください。$/);
  const holding = service.createConfirmation(input({ userId: 5 }));
  assert.equal(holding.text, 'すでに PC-0004 を借りています。返却してから申請してください。');
});
test('No.7-12 申請画面は不可の社員にバナー用メッセージを返す', () => {
  const { service } = fresh();
  assert.equal(service.getApplyContext(3).blocker.id, 'E-08');
  assert.equal(service.getApplyContext(4).blocker.id, 'E-12');
  assert.equal(service.getApplyContext(1).blocker, null);
});

// ---------------------------------------------------------------- ③ 重複・多重
test('No.12 同じ端末を 2 人が確定 → 先の人だけ成功、後の人は E-02。未返却は 1 件', () => {
  const { db, service } = fresh();
  const a = service.createConfirmation(input({ userId: 1 }));
  const b = service.createConfirmation(input({ userId: 2 })); // 確認画面の時点では両方とも空き
  assert.ok(a.ok && b.ok);
  assert.ok(service.commit({ userId: 1, token: a.token }).ok);
  const second = service.commit({ userId: 2, token: b.token });
  assert.equal(second.id, 'E-02');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM lendings WHERE device_id = 1 AND returned_at IS NULL'), 1);
});
test('No.13/14 同じトークンの再確定は新規登録せず前回の結果を返す(E-14)', () => {
  const { db, service } = fresh();
  const { token, result } = lend(service);
  const again = service.commit({ userId: 1, token });
  assert.ok(again.ok && again.replay);
  assert.equal(again.lendingId, result.lendingId);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM lendings WHERE user_id = 1 AND returned_at IS NULL'), 1);
  assert.equal(msg('E-14').text, 'この申請は既に登録済みです。重複して登録されていません。');
});
test('No.14/37 他人のトークン・存在しないトークン・空は E-15', () => {
  const { service } = fresh();
  const c = service.createConfirmation(input());
  assert.equal(service.commit({ userId: 2, token: c.token }).id, 'E-15');
  assert.equal(service.commit({ userId: 1, token: 'f'.repeat(32) }).id, 'E-15');
  assert.equal(service.commit({ userId: 1, token: '' }).id, 'E-15');
  assert.equal(service.commit({ userId: 1 }).id, 'E-15');
});
test('No.37 30 分を過ぎたトークンは E-15', () => {
  const { service, clock } = fresh();
  const c = service.createConfirmation(input());
  clock.t = new Date('2026-04-06T10:31:00+09:00');
  assert.equal(service.commit({ userId: 1, token: c.token }).id, 'E-15');
});
test('No.15 同じ人が別タブで別の端末を申請 → 2 台目は E-11、DB は 1 件のまま', () => {
  const { db, service } = fresh();
  const a = service.createConfirmation(input({ deviceId: 1 }));
  const b = service.createConfirmation(input({ deviceId: 2 })); // どちらも確認画面までは通る
  assert.ok(a.ok && b.ok);
  assert.ok(service.commit({ userId: 1, token: a.token }).ok);
  assert.equal(service.commit({ userId: 1, token: b.token }).id, 'E-11');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM lendings WHERE user_id = 1 AND returned_at IS NULL'), 1);
});
test('No.12,15 DB の部分ユニーク索引が最後の砦になる(アプリを通さず直接登録)', () => {
  const { db } = fresh();
  const ins = db.prepare("INSERT INTO lendings (device_id, user_id, lent_at, due_date, purpose) VALUES (?, ?, '2026-04-06 10:00:00', '2026-04-07', 'x')");
  ins.run(1, 1);
  assert.throws(() => ins.run(1, 2), /UNIQUE constraint failed: lendings.device_id/); // 同じ端末
  assert.throws(() => ins.run(2, 1), /UNIQUE constraint failed: lendings.user_id/);   // 同じ社員
});

// ---------------------------------------------------------------- ④ 入力値
test('No.16-20,25 返却予定日', () => {
  const { service } = fresh();
  const due = (v) => service.createConfirmation(input({ dueDate: v }));
  const err = (v) => due(v).inline.dueDate.id;
  assert.equal(err(''), 'E-16');
  assert.equal(err('   '), 'E-16');
  assert.equal(err('abc'), 'E-17');
  assert.equal(err('2026/02/30'), 'E-17');
  assert.equal(err('2026/13/01'), 'E-17');
  assert.equal(err('２０２６/０４/０８'), 'E-17'); // 全角
  assert.equal(err('2026/04/06'), 'E-18');        // 当日
  assert.equal(err('2026/04/05'), 'E-18');        // 過去
  assert.equal(err('2026/04/21'), 'E-18');        // 15 日後
  assert.equal(err('2036/04/07'), 'E-18');        // 10 年後
  assert.equal(err('2026/04/11'), 'E-19');        // 土曜
  assert.equal(err('2026/04/12'), 'E-19');        // 日曜
  assert.ok(due('2026/04/07').ok);                // 翌日ちょうど
  assert.ok(due('2026/04/20').ok);                // 14 日後ちょうど
  assert.ok(due('2026-04-08').ok);                // ハイフン区切り
  assert.ok(due('  2026/04/08　').ok);            // 前後の空白(半角・全角)は除去
});
test('No.21-23 利用目的', () => {
  const { service } = fresh();
  const pur = (v) => service.createConfirmation(input({ purpose: v }));
  const err = (v) => pur(v).inline.purpose.id;
  assert.equal(err(''), 'E-20');
  assert.equal(err('   　 '), 'E-20');
  assert.equal(err('あ'.repeat(101)), 'E-21');
  assert.equal(err('😀'.repeat(101)), 'E-21');
  assert.equal(err('1行目\n2行目'), 'E-22');
  assert.equal(err('a\u0000b'), 'E-22');
  assert.ok(pur('あ'.repeat(100)).ok);
  assert.ok(pur('😀'.repeat(100)).ok);          // 絵文字は 1 文字として数える
  assert.ok(pur('<script>alert(1)</script>').ok); // 保存は可(表示時にエスケープ)
});
test('No.21 利用目的は前後の空白を除去して保存される(R-16)', () => {
  const { db, service } = fresh();
  lend(service, { purpose: '　 出張 　' });
  assert.equal(db.prepare('SELECT purpose FROM lendings WHERE user_id = 1 AND returned_at IS NULL').get().purpose, '出張');
});
test('No.16,21 返却予定日と利用目的が同時に不正なら両方の項目にエラー', () => {
  const { service } = fresh();
  const r = service.createConfirmation(input({ dueDate: '', purpose: '' }));
  assert.equal(r.inline.dueDate.id, 'E-16');
  assert.equal(r.inline.purpose.id, 'E-20');
});
test('No.24 端末ID の形式不正は E-24', () => {
  const { service } = fresh();
  for (const v of ['abc', '1;DROP TABLE devices', '', '-1', '0', '1.5', undefined]) {
    assert.equal(service.createConfirmation(input({ deviceId: v })).id, 'E-24', String(v));
  }
});
test('チェック順:社員の状態 → 入力値 → 端末の状態(6.2)', () => {
  const { service } = fresh();
  // 退職者は入力が不正でも E-08 が先
  assert.equal(service.createConfirmation(input({ userId: 3, dueDate: '' })).id, 'E-08');
  // 入力不正は端末が貸出中でも入力エラーが先
  assert.ok(service.createConfirmation(input({ deviceId: 3, dueDate: '' })).inline);
});

// ---------------------------------------------------------------- ⑤ 順序・返却
test('No.26,27 返却:成功 → 二重返却は E-26 で returned_at を上書きしない', () => {
  const { db, service, clock } = fresh();
  const { result } = lend(service);
  clock.t = new Date('2026-04-06T15:30:00+09:00');
  assert.ok(service.returnLending({ userId: 1, lendingId: result.lendingId }).ok);
  const first = db.prepare('SELECT returned_at FROM lendings WHERE id = ?').get(result.lendingId).returned_at;
  assert.equal(first, '2026-04-06 15:30:00');
  assert.equal(db.prepare('SELECT status FROM devices WHERE id = 1').get().status, 'AVAILABLE');

  clock.t = new Date('2026-04-06T16:00:00+09:00');
  const again = service.returnLending({ userId: 1, lendingId: result.lendingId });
  assert.equal(again.id, 'E-26');
  assert.equal(again.text, 'PC-0001 は既に返却済みです（返却日時：2026/04/06 15:30）。');
  assert.equal(db.prepare('SELECT returned_at FROM lendings WHERE id = ?').get(result.lendingId).returned_at, first);
});
test('No.11 他人の貸出は返却できない(E-13)/存在しない貸出は E-27', () => {
  const { db, service } = fresh();
  assert.equal(service.returnLending({ userId: 1, lendingId: 1 + 1 }).id, 'E-13'); // 貸出ID 2 は伊藤(5)の貸出
  assert.equal(service.returnLending({ userId: 1, lendingId: 999 }).id, 'E-27');
  assert.equal(service.returnLending({ userId: 1, lendingId: 'abc' }).id, 'E-27');
  assert.equal(db.prepare('SELECT returned_at FROM lendings WHERE id = 2').get().returned_at, null);
});
test('No.26 端末が貸出中でない(修理中など)貸出は返却できない(E-25)', () => {
  const { db, service } = fresh();
  db.prepare("UPDATE devices SET status = 'REPAIR' WHERE id = 4").run(); // 不整合を作る
  assert.equal(service.returnLending({ userId: 5, lendingId: 2 }).id, 'E-25');
  assert.equal(db.prepare('SELECT returned_at FROM lendings WHERE id = 2').get().returned_at, null);
});
test('No.28 状態遷移表(貸出中は変更不可・廃棄済みは終端)', () => {
  const { service } = fresh();
  assert.equal(service.changeDeviceStatus({ deviceId: 3, toStatus: 'REPAIR' }).id, 'E-28');
  assert.equal(service.changeDeviceStatus({ deviceId: 3, toStatus: 'DISPOSED' }).id, 'E-28');
  assert.equal(service.changeDeviceStatus({ deviceId: 3, toStatus: 'AVAILABLE' }).id, 'E-29'); // 返却処理でのみ
  assert.equal(service.changeDeviceStatus({ deviceId: 1, toStatus: 'LENT' }).id, 'E-29');      // 貸出処理でのみ
  assert.equal(service.changeDeviceStatus({ deviceId: 6, toStatus: 'AVAILABLE' }).id, 'E-29'); // DISPOSED は終端
  assert.equal(service.changeDeviceStatus({ deviceId: 5, toStatus: 'LENT' }).id, 'E-29');      // REPAIR→LENT 不可
  assert.equal(service.changeDeviceStatus({ deviceId: 999, toStatus: 'REPAIR' }).id, 'E-05');
  assert.ok(service.changeDeviceStatus({ deviceId: 1, toStatus: 'REPAIR' }).ok);               // AVAILABLE→REPAIR
  assert.ok(service.changeDeviceStatus({ deviceId: 1, toStatus: 'AVAILABLE' }).ok);            // REPAIR→AVAILABLE
});

// ---------------------------------------------------------------- ⑥ 時間
test('No.29,32 延滞日数:期限当日は延滞でない、翌日から延滞', () => {
  const { service, clock } = fresh();
  assert.equal(service.listOpenLendings(4)[0].overdueDays, 3); // 期限 4/3 → 4/6 で 3 日
  assert.equal(service.listOpenLendings(5)[0].overdueDays, 0); // 期限 4/12
  clock.t = new Date('2026-04-12T23:59:00+09:00');
  assert.equal(service.listOpenLendings(5)[0].overdueDays, 0); // 期限当日の 23:59
  clock.t = new Date('2026-04-13T00:00:00+09:00');
  assert.equal(service.listOpenLendings(5)[0].overdueDays, 1); // 翌日 0:00 から延滞
});
test('No.29 延滞していた端末の返却は S-03 の日数が出る', () => {
  const { service } = fresh();
  const r = service.returnLending({ userId: 4, lendingId: 1 });
  assert.ok(r.ok);
  const l = service.getOwnLending(4, 1).lending;
  assert.equal(service.overdueDaysAtReturn(l), 3);
  assert.equal(msg('S-03', { assetNo: 'PC-0003', days: 3 }).text, 'PC-0003 を返却しました。返却期限を 3 日過ぎています。');
});
test('No.30 返却して延滞が解消すれば再び借りられる', () => {
  const { service } = fresh();
  assert.equal(service.createConfirmation(input({ userId: 4 })).id, 'E-12');
  service.returnLending({ userId: 4, lendingId: 1 });
  assert.ok(service.createConfirmation(input({ userId: 4 })).ok);
});
test('No.31 確認画面を開いたまま日付が変わると確定時に E-23(登録されない)', () => {
  const { db, service, clock } = fresh();
  clock.t = new Date('2026-04-06T23:50:00+09:00');
  const c = service.createConfirmation(input({ dueDate: '2026/04/07' })); // 23:50 時点では「明日」で有効
  assert.ok(c.ok);
  clock.t = new Date('2026-04-07T00:05:00+09:00'); // 日付が変わり、返却予定日が「当日」になった
  const r = service.commit({ userId: 1, token: c.token });
  assert.equal(r.id, 'E-23');
  assert.equal(openLendings(db), 2); // シードの 2 件のまま
  assert.equal(db.prepare('SELECT used_at FROM lending_requests WHERE token = ?').get(c.token).used_at, null);
});

// ---------------------------------------------------------------- ⑦ 失敗時
test('No.33 貸出の途中で失敗 → 全ロールバック(lendings も devices も変わらない)', () => {
  const { db, service } = fresh({ failTx: true });
  const c = service.createConfirmation(input());
  const before = count(db, 'SELECT COUNT(*) AS n FROM lendings');
  const r = service.commit({ userId: 1, token: c.token });
  assert.equal(r.id, 'E-30');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM lendings'), before);
  assert.equal(db.prepare('SELECT status FROM devices WHERE id = 1').get().status, 'AVAILABLE');
  assert.equal(db.prepare('SELECT used_at FROM lending_requests WHERE token = ?').get(c.token).used_at, null);
});
test('No.34 返却の途中で失敗 → 全ロールバック', () => {
  const { db, service } = fresh({ failTx: true });
  const r = service.returnLending({ userId: 5, lendingId: 2 });
  assert.equal(r.id, 'E-31');
  assert.equal(db.prepare('SELECT returned_at FROM lendings WHERE id = 2').get().returned_at, null);
  assert.equal(db.prepare('SELECT status FROM devices WHERE id = 4').get().status, 'LENT');
});
test('No.35 書き込みロックが取れないと E-32', () => {
  process.env.DB_BUSY_TIMEOUT_MS = '300';
  const { service, filePath } = fresh();
  delete process.env.DB_BUSY_TIMEOUT_MS;
  const c = service.createConfirmation(input());
  const blocker = new Database(filePath);
  blocker.exec('BEGIN IMMEDIATE'); // 別の接続が書き込みロックを保持
  try {
    assert.equal(service.commit({ userId: 1, token: c.token }).id, 'E-32');
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
  assert.ok(service.commit({ userId: 1, token: c.token }).ok); // ロックが外れれば成功する
});

// ---------------------------------------------------------------- メッセージ文言
test('メッセージ文言が仕様書(02_例外系仕様書.md 9.)と完全に一致する', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', '02_例外系仕様書.md'), 'utf8');
  const params = { assetNo: '{資産番号}', dueDate: '{YYYY/MM/DD}', days: '{N}', returnedAt: '{YYYY/MM/DD HH:mm}' };
  const ids = Object.keys(MESSAGES);
  let checked = 0;
  for (const line of doc.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 5 || !/^[ES]-\d\d$/.test(cells[1])) continue;
    assert.ok(ids.includes(cells[1]), `実装にない ID: ${cells[1]}`);
    assert.equal(msg(cells[1], params).text, cells[3], `${cells[1]} の文言が不一致`);
    checked += 1;
  }
  assert.equal(checked, ids.length, '仕様書とコードのメッセージ数が一致しない');
});

// ---------------------------------------------------------------- HTTP(実際のリクエスト)
async function withServer(fn, opts) {
  const env = fresh(opts);
  const app = createApp({ db: env.db, service: env.service });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (p, { method = 'GET', user, form, cookie = '' } = {}) => {
    const headers = { cookie: [user ? `user_id=${user}` : '', cookie].filter(Boolean).join('; ') };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(base + p, { method, headers, body, redirect: 'manual' });
    return {
      status: res.status,
      location: res.headers.get('location'),
      cache: res.headers.get('cache-control'),
      setCookie: res.headers.getSetCookie(),
      text: await res.text(),
    };
  };
  try {
    await fn({ ...env, http });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const tokenFrom = (location) => location.split('/').pop();
const confirmForm = (over = {}) => ({ device_id: '1', due_date: '2026/04/07', purpose: '出張', ...over });

test('HTTP 正常系:申請 → 確認 → 確定 → 完了 → 返却(S-01・S-02)', () => withServer(async ({ http }) => {
  const c = await http('/lendings/confirm', { method: 'POST', user: 1, form: confirmForm() });
  assert.equal(c.status, 303);
  const page = await http(c.location, { user: 1 });
  assert.equal(page.status, 200);
  assert.equal(page.cache, 'no-store');                 // V-07
  assert.match(page.text, /PC-0001/);
  const done = await http('/lendings/commit', { method: 'POST', user: 1, form: { token: tokenFrom(c.location) } });
  const complete = await http(done.location, { user: 1 });
  assert.equal(complete.cache, 'no-store');
  assert.match(complete.text, /PC-0001 を貸し出しました。返却予定日は 2026\/04\/07 です。/);
  const ret = await http('/returns', { user: 1 });
  assert.match(ret.text, /PC-0001/);
  const lendingId = /name="lending_id" value="(\d+)"/.exec(ret.text)[1];
  const r = await http('/returns', { method: 'POST', user: 1, form: { lending_id: lendingId } });
  const retDone = await http(r.location, { user: 1 });
  assert.match(retDone.text, /PC-0001 を返却しました。/);
  assert.doesNotMatch(retDone.text, /過ぎています/);
}));

test('HTTP No.1,16,17 画面にエラーが表示される(E-01 / E-16 / E-18)', () => withServer(async ({ http }) => {
  const a = await http('/lendings/confirm', { method: 'POST', user: 1, form: confirmForm({ device_id: '3' }) });
  assert.match(a.text, /この端末は現在貸出中です。別の端末を選択してください。/);
  const b = await http('/lendings/confirm', { method: 'POST', user: 1, form: confirmForm({ due_date: '' }) });
  assert.match(b.text, /id="err-due_date">返却予定日を入力してください。/);
  const c = await http('/lendings/confirm', { method: 'POST', user: 1, form: confirmForm({ due_date: '2026/04/01', purpose: 'テスト目的' }) });
  assert.match(c.text, /返却予定日は明日から14日以内で入力してください。/);
  assert.match(c.text, /value="2026\/04\/01"/);   // 入力値は保持(V-04)
  assert.match(c.text, /value="テスト目的"/);
}));

test('HTTP No.7-12 不可の社員は申請画面のボタンが非活性(V-03)/貸出可能 0 件は E-07(V-02)', () => withServer(async ({ http, db }) => {
  const retired = await http('/lendings/new', { user: 3 });
  assert.match(retired.text, /退職済みの社員は貸出できません。/);
  assert.match(retired.text, /id="submit" disabled/);
  const overdue = await http('/lendings/new', { user: 4 });
  assert.match(overdue.text, /返却期限（2026\/04\/03）を過ぎた端末 PC-0003 があります。先に返却してください。/);
  makeNoAvailableDevices(db);
  const none = await http('/lendings/new', { user: 1 });
  assert.match(none.text, /現在貸出できるノートPCはありません。しばらくしてからもう一度ご確認ください。/);
  assert.match(none.text, /id="submit" disabled/);
  assert.doesNotMatch(none.text, /<select/);
}));

test('HTTP No.13 同じトークンを同時に 5 回確定しても登録は 1 件(連打・二重送信)', () => withServer(async ({ http, db }) => {
  const c = await http('/lendings/confirm', { method: 'POST', user: 1, form: confirmForm() });
  const token = tokenFrom(c.location);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => http('/lendings/commit', { method: 'POST', user: 1, form: { token } })),
  );
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM lendings WHERE user_id = 1 AND returned_at IS NULL'), 1);
  assert.equal(new Set(results.map((r) => r.location)).size, 1);   // 全員が同じ完了画面へ
  assert.ok(results.every((r) => r.status === 303));
}));

test('HTTP No.14 戻るボタンから確認画面に戻って再確定 → E-14(重複登録なし)', () => withServer(async ({ http, db }) => {
  const c = await http('/lendings/confirm', { method: 'POST', user: 1, form: confirmForm() });
  const token = tokenFrom(c.location);
  const first = await http('/lendings/commit', { method: 'POST', user: 1, form: { token } });
  const back = await http(c.location, { user: 1 });                // ブラウザバックで確認画面を再表示
  assert.equal(back.status, 200);
  const second = await http('/lendings/commit', { method: 'POST', user: 1, form: { token } });
  assert.equal(second.location, first.location);
  const flash = second.setCookie.find((x) => x.startsWith('flash='));
  const page = await http(second.location, { user: 1, cookie: flash.split(';')[0] });
  assert.match(page.text, /この申請は既に登録済みです。重複して登録されていません。/);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM lendings WHERE user_id = 1 AND returned_at IS NULL'), 1);
}));

test('HTTP No.12 4 人が同じ端末を同時に確定 → 成功は 1 人だけ', () => withServer(async ({ http, db }) => {
  const users = [1, 2, 6, 7];
  const tokens = [];
  for (const u of users) {
    const c = await http('/lendings/confirm', { method: 'POST', user: u, form: confirmForm() });
    assert.equal(c.status, 303, `user ${u}`);
    tokens.push(tokenFrom(c.location));
  }
  const results = await Promise.all(users.map((u, i) => http('/lendings/commit', { method: 'POST', user: u, form: { token: tokens[i] } })));
  const succeeded = results.filter((r) => /\/complete$/.test(r.location));
  const refused = results.filter((r) => /restore=/.test(r.location || ''));
  assert.equal(succeeded.length, 1);
  assert.equal(refused.length, 3);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM lendings WHERE device_id = 1 AND returned_at IS NULL'), 1);
  // 負けた人の申請画面には E-02 が出る
  const idx = results.findIndex((r) => /restore=/.test(r.location || ''));
  const flash = results[idx].setCookie.find((x) => x.startsWith('flash='));
  const page = await http(results[idx].location, { user: users[idx], cookie: flash.split(';')[0] });
  assert.match(page.text, /他の方が先に貸し出したため、この端末は貸出できませんでした。別の端末を選択してください。/);
}));

test('HTTP No.37 確認画面を経由しない確定・ログインなしは拒否(E-15 / E-33)', () => withServer(async ({ http, db }) => {
  const noToken = await http('/lendings/commit', { method: 'POST', user: 1, form: { device_id: '1', due_date: '2026/04/07', purpose: 'x' } });
  assert.equal(noToken.status, 400);
  assert.match(noToken.text, /この画面は有効期限が切れているか、無効です。最初からやり直してください。/);
  const fake = await http('/lendings/commit', { method: 'POST', user: 1, form: { token: 'a'.repeat(32) } });
  assert.equal(fake.status, 400);
  const guest = await http('/lendings/commit', { method: 'POST', form: { token: 'a'.repeat(32) } });
  assert.equal(guest.status, 401);
  assert.match(guest.text, /ログインの有効期限が切れました。再ログイン後、返却画面で貸出状況をご確認ください。/);
  const noUser = await http('/lendings/new', { user: 999 });
  assert.equal(noUser.status, 403);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM lendings WHERE returned_at IS NULL'), 2);
}));

test('HTTP No.38 リクエストの user_id は無視し、Cookie のログイン情報を使う', () => withServer(async ({ http, db }) => {
  const c = await http('/lendings/confirm', { method: 'POST', user: 1, form: { ...confirmForm(), user_id: '2' } });
  const token = tokenFrom(c.location);
  assert.equal(db.prepare('SELECT user_id FROM lending_requests WHERE token = ?').get(token).user_id, 1);
  await http('/lendings/commit', { method: 'POST', user: 1, form: { token, user_id: '2' } });
  assert.equal(db.prepare('SELECT user_id FROM lendings WHERE device_id = 1 AND returned_at IS NULL').get().user_id, 1);
  // 他人の貸出 ID を指定した返却は E-13
  const other = await http('/returns', { method: 'POST', user: 1, form: { lending_id: '2' } });
  assert.equal(other.status, 403);
  assert.match(other.text, /この貸出はあなたの貸出ではないため、返却できません。/);
  // 他人のトークンで確認画面は開けない
  const peek = await http(c.location, { user: 2 });
  assert.equal(peek.status, 400);
}));

test('HTTP No.39 確認画面のあとにフォーム値をすり替えても、登録されるのは確認画面の内容', () => withServer(async ({ http, db }) => {
  const c = await http('/lendings/confirm', { method: 'POST', user: 1, form: confirmForm() });
  const token = tokenFrom(c.location);
  await http('/lendings/commit', { method: 'POST', user: 1, form: { token, device_id: '2', due_date: '2026/04/20', purpose: 'すり替え' } });
  const l = db.prepare('SELECT * FROM lendings WHERE user_id = 1 AND returned_at IS NULL').get();
  assert.equal(l.device_id, 1);
  assert.equal(l.due_date, '2026-04-07');
  assert.equal(l.purpose, '出張');
}));

test('HTTP No.23 利用目的の HTML タグは画面でエスケープされる', () => withServer(async ({ http }) => {
  const c = await http('/lendings/confirm', { method: 'POST', user: 1, form: confirmForm({ purpose: '<script>alert(1)</script>' }) });
  const page = await http(c.location, { user: 1 });
  assert.doesNotMatch(page.text, /<script>alert\(1\)<\/script>/);
  assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
}));

test('HTTP No.27 別タブからの二重返却は E-26 を返却画面に表示', () => withServer(async ({ http }) => {
  const r1 = await http('/returns', { method: 'POST', user: 5, form: { lending_id: '2' } });
  assert.equal(r1.status, 303);
  const r2 = await http('/returns', { method: 'POST', user: 5, form: { lending_id: '2' } });
  assert.equal(r2.location, '/returns');
  const flash = r2.setCookie.find((x) => x.startsWith('flash='));
  const page = await http('/returns', { user: 5, cookie: flash.split(';')[0] });
  assert.match(page.text, /PC-0004 は既に返却済みです（返却日時：2026\/04\/06 10:00）。/);
  assert.match(page.text, /返却する端末はありません/);   // V-08
}));

test('HTTP No.29 延滞中の返却画面に「延滞 3日」バッジ(V-09)/返却完了で S-03 の注記(V-10)', () => withServer(async ({ http }) => {
  const page = await http('/returns', { user: 4 });
  assert.match(page.text, /延滞 3日/);
  const ok = await http('/returns', { user: 5 });
  assert.doesNotMatch(ok.text, /延滞/);                  // 期限内は出ない
  const r = await http('/returns', { method: 'POST', user: 4, form: { lending_id: '1' } });
  const done = await http(r.location, { user: 4 });
  assert.match(done.text, /PC-0003 を返却しました。/);
  assert.match(done.text, /id="notice">返却期限を 3 日過ぎています。/);
}));

test('HTTP No.33 貸出の途中で失敗 → E-30(HTTP 500)・何も残らない', () => withServer(async ({ http, db }) => {
  const c = await http('/lendings/confirm', { method: 'POST', user: 1, form: confirmForm() });
  const r = await http('/lendings/commit', { method: 'POST', user: 1, form: { token: tokenFrom(c.location) } });
  assert.equal(r.status, 500);
  assert.match(r.text, /システムエラーが発生しました。貸出は完了していません。時間をおいてもう一度お試しください。/);
  assert.equal(openLendings(db), 2);
  assert.equal(db.prepare('SELECT status FROM devices WHERE id = 1').get().status, 'AVAILABLE');
}, { failTx: true }));

// ----------------------------------------------------------------------------
(async () => {
  const origError = console.error;
  console.error = () => {}; // E-30 / E-31 の確認時にサーバーログが出るため抑止
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ○ ${t.name}`);
    } catch (e) {
      failed += 1;
      console.log(`  × ${t.name}\n      ${String(e.message).split('\n').join('\n      ')}`);
    }
  }
  console.error = origError;
  console.log(`\n${tests.length - failed} / ${tests.length} 件 成功`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* Windows では開いたままの DB を消せないため無視 */ }
  process.exit(failed ? 1 : 0);
})();

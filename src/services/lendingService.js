// 貸出・返却の業務ロジック(要件定義書 5.〜7.)
const crypto = require('crypto');
const { msg } = require('../constants/messages');
const { canTransition } = require('../constants/transitions');
const { systemClock, jst, parseJst } = require('../clock');
const {
  daysBetween, isWeekend, trim, parseDateInput, slashDateTime,
} = require('../dates');

const PURPOSE_MAX = 100;
const MAX_DAYS_AHEAD = 14;          // R-05:返却予定日は明日から 14 日後まで
const TOKEN_TTL_MS = 30 * 60 * 1000; // N-07:確認トークンの有効期限 30 分
const CONTROL_CHARS = new RegExp('[\u0000-\u001F\u007F-\u009F\u2028\u2029]');

// トランザクションを巻き戻して、呼び出し元に結果を返すための例外
class Abort extends Error {
  constructor(result) {
    super(result.id);
    this.result = result;
  }
}

function fail(id, params) {
  return { ok: false, ...msg(id, params) };
}

function createLendingService(db, { clock = systemClock(), failTx = () => process.env.FAIL_TX === '1' } = {}) {
  const q = {
    employee: db.prepare('SELECT * FROM employees WHERE id = ?'),
    device: db.prepare('SELECT * FROM devices WHERE id = ?'),
    availableDevices: db.prepare(`
      SELECT id, asset_no, model_name FROM devices
       WHERE device_type = 'LAPTOP' AND status = 'AVAILABLE'
       ORDER BY asset_no
    `),
    openLendings: db.prepare(`
      SELECT l.*, d.asset_no, d.model_name
        FROM lendings l JOIN devices d ON d.id = l.device_id
       WHERE l.user_id = ? AND l.returned_at IS NULL
       ORDER BY l.due_date, l.id
    `),
    lending: db.prepare(`
      SELECT l.*, d.asset_no, d.model_name
        FROM lendings l JOIN devices d ON d.id = l.device_id
       WHERE l.id = ?
    `),
    request: db.prepare('SELECT * FROM lending_requests WHERE token = ?'),
    insertRequest: db.prepare(`
      INSERT INTO lending_requests (token, user_id, device_id, due_date, purpose, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertLending: db.prepare(`
      INSERT INTO lendings (device_id, user_id, lent_at, due_date, returned_at, purpose)
      VALUES (?, ?, ?, ?, NULL, ?)
    `),
    useRequest: db.prepare('UPDATE lending_requests SET used_at = ?, lending_id = ? WHERE token = ? AND used_at IS NULL'),
    setDeviceLent: db.prepare("UPDATE devices SET status = 'LENT' WHERE id = ? AND status = 'AVAILABLE'"),
    setLendingReturned: db.prepare('UPDATE lendings SET returned_at = ? WHERE id = ? AND returned_at IS NULL'),
    setDeviceAvailable: db.prepare("UPDATE devices SET status = 'AVAILABLE' WHERE id = ? AND status = 'LENT'"),
    setDeviceStatus: db.prepare('UPDATE devices SET status = ? WHERE id = ? AND status = ?'),
  };

  const nowInfo = () => jst(clock.now());

  // ---- 共通チェック ----------------------------------------------------------

  // チェック順 1〜4:社員の存在 → 在籍区分(R-02) → 延滞(R-04) → 未返却(R-03)
  function checkEmployee(userId, today) {
    const employee = q.employee.get(userId);
    if (!employee) return fail('E-10');
    if (employee.employment_status === 'RETIRED') return fail('E-08');
    if (employee.employment_status === 'LEAVE') return fail('E-09');
    const open = q.openLendings.all(userId);
    const overdue = open.find((l) => l.due_date < today);
    if (overdue) return fail('E-12', { dueDate: overdue.due_date, assetNo: overdue.asset_no });
    if (open.length > 0) return fail('E-11', { assetNo: open[0].asset_no });
    return { ok: true, employee };
  }

  // 返却予定日の範囲(R-05)。違反なら E-18
  function checkDueRange(dueDate, today) {
    const diff = daysBetween(today, dueDate);
    return diff >= 1 && diff <= MAX_DAYS_AHEAD ? null : fail('E-18');
  }

  // 返却予定日(I-02)→ { value } | { error }
  function validateDueDate(raw, today) {
    const parsed = parseDateInput(raw);
    if (!parsed.ok) return { error: fail(parsed.reason === 'EMPTY' ? 'E-16' : 'E-17') };
    const rangeError = checkDueRange(parsed.value, today);
    if (rangeError) return { error: rangeError };
    if (isWeekend(parsed.value)) return { error: fail('E-19') };
    return { value: parsed.value };
  }

  // 利用目的(I-03)→ { value } | { error }
  function validatePurpose(raw) {
    const value = trim(raw);
    if (value === '') return { error: fail('E-20') };
    if ([...value].length > PURPOSE_MAX) return { error: fail('E-21') };
    if (CONTROL_CHARS.test(value)) return { error: fail('E-22') };
    return { value };
  }

  // チェック順 6〜8:端末の存在 → 種別(R-01) → 状態(R-01)。
  // 確定時(atCommit)に貸出中だった場合は「先に貸し出された」ので E-02、申請→確認の遷移時は E-01
  function checkDevice(device, { atCommit }) {
    if (!device) return fail('E-05');
    if (device.device_type !== 'LAPTOP') return fail('E-06');
    if (device.status === 'LENT') return fail(atCommit ? 'E-02' : 'E-01');
    if (device.status === 'REPAIR') return fail('E-03', { assetNo: device.asset_no });
    if (device.status === 'DISPOSED') return fail('E-04', { assetNo: device.asset_no });
    return { ok: true };
  }

  // ---- 貸出申請 --------------------------------------------------------------

  // 貸出申請画面の表示用(V-01〜V-03)
  function getApplyContext(userId) {
    const today = nowInfo().date;
    const employee = q.employee.get(userId) || null;
    const blocker = checkEmployee(userId, today);
    return {
      employee,
      blocker: blocker.ok ? null : blocker,
      devices: q.availableDevices.all(),
    };
  }

  // 申請内容のチェック(申請→確認の遷移時)
  // 戻り値: { ok: true, device, dueDate, purpose } | { ok: false, id, text } | { ok: false, inline: { dueDate?, purpose? } }
  function prepareApplication({ userId, deviceId, dueDate, purpose }) {
    const today = nowInfo().date;

    const emp = checkEmployee(userId, today);
    if (!emp.ok) return emp;

    // チェック順 5:入力値。端末IDの形式不正は E-24、返却予定日・利用目的は項目ごとに表示する
    if (!/^[1-9]\d{0,17}$/.test(String(deviceId ?? ''))) return fail('E-24');
    const due = validateDueDate(dueDate, today);
    const pur = validatePurpose(purpose);
    if (due.error || pur.error) {
      return { ok: false, inline: { dueDate: due.error, purpose: pur.error } };
    }

    const device = q.device.get(Number(deviceId));
    const deviceCheck = checkDevice(device, { atCommit: false });
    if (!deviceCheck.ok) return deviceCheck;

    return { ok: true, device, dueDate: due.value, purpose: pur.value };
  }

  // 確認画面へ進む:内容をサーバーに保存し、1 回限りの確認トークンを発行する(R-15)
  function createConfirmation(input) {
    const prepared = prepareApplication(input);
    if (!prepared.ok) return prepared;
    const token = crypto.randomBytes(16).toString('hex');
    q.insertRequest.run(token, input.userId, prepared.device.id, prepared.dueDate, prepared.purpose, nowInfo().dateTime);
    return { ok: true, token };
  }

  function isTokenUsable(row, userId) {
    if (!row || row.user_id !== userId) return false;
    return clock.now().getTime() - parseJst(row.created_at).getTime() <= TOKEN_TTL_MS;
  }

  // 確認画面の表示用
  function getConfirmation(userId, token) {
    const row = q.request.get(String(token));
    if (!isTokenUsable(row, userId)) return fail('E-15');
    return { ok: true, request: row, device: q.device.get(row.device_id) };
  }

  // 「戻る」「日付が変わった」ときの入力値の復元(期限は問わない)
  function getRestore(userId, token) {
    const row = q.request.get(String(token || ''));
    return row && row.user_id === userId ? row : null;
  }

  // 貸出の確定(POST /lendings/commit)
  function commit({ userId, token }) {
    const row = q.request.get(String(token ?? ''));
    // ◇7:存在・本人・30分以内
    if (!isTokenUsable(row, userId)) return fail('E-15');
    // ◇8・◇9:使用済みなら再処理せず、前回成功していればその結果を返す(R-08)
    if (row.used_at) return replayOrFail(row);

    const run = db.transaction(() => {
      // ロック取得後に読み直して検証をやり直す(R-07・R-14)
      const fresh = q.request.get(row.token);
      if (fresh.used_at) return replayOrFail(fresh);

      const { date: today, dateTime } = nowInfo();
      const emp = checkEmployee(userId, today);
      if (!emp.ok) return emp;

      const device = q.device.get(fresh.device_id);
      const deviceCheck = checkDevice(device, { atCommit: true });
      if (!deviceCheck.ok) return deviceCheck;

      // E-23:確認画面を開いている間に日付が変わった
      if (checkDueRange(fresh.due_date, today)) return fail('E-23');

      if (!canTransition(device.status, 'LENT')) return fail('E-29');
      const { lastInsertRowid } = q.insertLending.run(device.id, userId, dateTime, fresh.due_date, fresh.purpose);
      // 動作確認専用:FAIL_TX=1 のとき 2 つ目の更新の前で失敗させる(N-01 のロールバック確認用)
      if (failTx()) throw new Error('FAIL_TX=1:貸出処理を意図的に失敗させました');
      if (q.setDeviceLent.run(device.id).changes !== 1) throw new Abort(fail('E-02'));
      q.useRequest.run(dateTime, lastInsertRowid, fresh.token);
      return { ok: true, lendingId: Number(lastInsertRowid) };
    });

    try {
      return run.immediate();
    } catch (e) {
      return mapError(e, 'E-30', userId);
    }
  }

  function replayOrFail(row) {
    return row.lending_id ? { ok: true, replay: true, lendingId: row.lending_id } : fail('E-15');
  }

  // 例外 → 利用者向けメッセージ(N-05:詳細は画面に出さずサーバーログのみ)
  function mapError(e, systemErrorId, userId) {
    if (e instanceof Abort) return e.result;
    if (e && e.code === 'SQLITE_BUSY') return fail('E-32');
    if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      // アプリのチェックをすり抜けた場合の最後の砦(部分ユニーク索引)
      if (String(e.message).includes('lendings.device_id')) return fail('E-02');
      if (String(e.message).includes('lendings.user_id')) {
        const open = q.openLendings.all(userId)[0];
        return fail('E-11', { assetNo: open ? open.asset_no : '' });
      }
    }
    console.error(e);
    return fail(systemErrorId);
  }

  // ---- 完了画面・返却 -----------------------------------------------------------

  // 完了画面用に、本人の貸出を取得
  function getOwnLending(userId, lendingId) {
    const lending = /^\d+$/.test(String(lendingId)) ? q.lending.get(Number(lendingId)) : null;
    if (!lending) return fail('E-27');
    if (lending.user_id !== userId) return fail('E-13');
    return { ok: true, lending };
  }

  // 返却画面用:本人の未返却の貸出(V-08・V-09)
  function listOpenLendings(userId) {
    const today = nowInfo().date;
    return q.openLendings.all(userId).map((l) => ({
      ...l,
      overdueDays: Math.max(0, daysBetween(l.due_date, today)),
    }));
  }

  // 返却延滞日数(返却予定日の当日は延滞ではない R-13)
  function overdueDaysAtReturn(lending) {
    return Math.max(0, daysBetween(lending.due_date, jst(parseJst(lending.returned_at)).date));
  }

  // 返却の確定(POST /returns)
  function returnLending({ userId, lendingId }) {
    const run = db.transaction(() => {
      const { dateTime } = nowInfo();
      // ◇15:存在 ◇16:本人 ◇17:未返却
      const lending = /^\d+$/.test(String(lendingId ?? '')) ? q.lending.get(Number(lendingId)) : null;
      if (!lending) return fail('E-27');
      if (lending.user_id !== userId) return fail('E-13');
      if (lending.returned_at) {
        return fail('E-26', { assetNo: lending.asset_no, returnedAt: slashDateTime(lending.returned_at) });
      }
      const device = q.device.get(lending.device_id);
      if (!device || !canTransition(device.status, 'AVAILABLE')) return fail('E-25');

      // R-11:returned_at が NULL の行だけを更新する
      if (q.setLendingReturned.run(dateTime, lending.id).changes !== 1) {
        throw new Abort(fail('E-26', { assetNo: lending.asset_no, returnedAt: '' }));
      }
      // 動作確認専用:FAIL_TX=1 のとき 2 つ目の更新の前で失敗させる(N-01 のロールバック確認用)
      if (failTx()) throw new Error('FAIL_TX=1:返却処理を意図的に失敗させました');
      if (q.setDeviceAvailable.run(device.id).changes !== 1) throw new Abort(fail('E-25'));
      return { ok: true, lendingId: lending.id };
    });

    try {
      return run.immediate();
    } catch (e) {
      return mapError(e, 'E-31', userId);
    }
  }

  // ---- 端末の状態変更(R-12。画面は範囲外のため、判定のみをサービスとして用意) ----------
  function changeDeviceStatus({ deviceId, toStatus }) {
    const run = db.transaction(() => {
      const device = q.device.get(Number(deviceId));
      if (!device) return fail('E-05');
      // 貸出中の端末は REPAIR / DISPOSED に変えられない(先に返却)
      if (device.status === 'LENT' && (toStatus === 'REPAIR' || toStatus === 'DISPOSED')) return fail('E-28');
      // LENT への変更・LENT からの変更は貸出・返却処理でのみ行う
      if (toStatus === 'LENT' || device.status === 'LENT') return fail('E-29');
      if (!canTransition(device.status, toStatus)) return fail('E-29');
      if (q.setDeviceStatus.run(toStatus, device.id, device.status).changes !== 1) return fail('E-29');
      return { ok: true };
    });
    try {
      return run.immediate();
    } catch (e) {
      return mapError(e, 'E-30', null);
    }
  }

  return {
    findEmployee: (id) => q.employee.get(id) || null,
    getApplyContext,
    createConfirmation,
    getConfirmation,
    getRestore,
    commit,
    getOwnLending,
    listOpenLendings,
    overdueDaysAtReturn,
    returnLending,
    changeDeviceStatus,
  };
}

module.exports = { createLendingService };

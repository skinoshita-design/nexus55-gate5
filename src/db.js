// DB接続・テーブル定義・シードデータ(要件定義書 3.)
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { systemClock, jst } = require('./clock');
const { addDays } = require('./dates');

// DB_PATH を指定すると保存先を変えられる(モック撮影用スクリプトなどで本番のDBを触らないため)
const DEFAULT_DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');

// 日時はアプリ側で日本時間の文字列('YYYY-MM-DD HH:mm:ss')を渡す(N-06)ため、DB のデフォルト時刻には頼らない
const SCHEMA = `
CREATE TABLE IF NOT EXISTS employees (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_code      VARCHAR(10) NOT NULL UNIQUE,
  name               VARCHAR(50) NOT NULL,
  department         VARCHAR(50) NOT NULL,
  employment_status  VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (employment_status IN ('ACTIVE', 'LEAVE', 'RETIRED'))
);

CREATE TABLE IF NOT EXISTS devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_no      VARCHAR(20) NOT NULL UNIQUE,
  model_name    VARCHAR(50) NOT NULL,
  device_type   VARCHAR(20) NOT NULL CHECK (device_type IN ('LAPTOP', 'TABLET', 'MONITOR')),
  status        VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE', 'LENT', 'REPAIR', 'DISPOSED')),
  purchased_at  DATE        NOT NULL
);

CREATE TABLE IF NOT EXISTS lendings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    BIGINT       NOT NULL REFERENCES devices(id),
  user_id      BIGINT       NOT NULL REFERENCES employees(id),
  lent_at      DATETIME     NOT NULL,
  due_date     DATE         NOT NULL,
  returned_at  DATETIME     NULL DEFAULT NULL,
  purpose      VARCHAR(100) NOT NULL
);

-- 未返却の貸出は 1 端末につき 1 件まで(R-06)/ 1 社員につき 1 件まで(R-03)
CREATE UNIQUE INDEX IF NOT EXISTS ux_lendings_open_device ON lendings(device_id) WHERE returned_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_lendings_open_user   ON lendings(user_id)   WHERE returned_at IS NULL;

CREATE TABLE IF NOT EXISTS lending_requests (
  token       VARCHAR(32) PRIMARY KEY,
  user_id     BIGINT       NOT NULL,
  device_id   BIGINT       NOT NULL,
  due_date    DATE         NOT NULL,
  purpose     VARCHAR(100) NOT NULL,
  created_at  DATETIME     NOT NULL,
  used_at     DATETIME     NULL DEFAULT NULL,
  lending_id  BIGINT       NULL DEFAULT NULL
);
`;

// シード:動作確認の各シナリオを再現できるよう、日付は「今日」からの相対で作る
//   employees  1 山田(通常) 2 佐藤(通常) 3 鈴木(退職) 4 高橋(延滞中) 5 伊藤(貸出中) 6 渡辺 7 中村 8 小林(休職)
//   devices    PC-0001〜0010 ノートPC(0003=貸出中・延滞 / 0004=貸出中 / 0005=修理中 / 0006=廃棄済み)
//              PC-0011 タブレット / PC-0012 モニター(貸出対象外)
function seed(db, clock = systemClock()) {
  const today = jst(clock.now()).date;
  const at = (offsetDays, time) => `${addDays(today, offsetDays)} ${time}`;

  const insertEmployee = db.prepare(
    'INSERT INTO employees (employee_code, name, department, employment_status) VALUES (?, ?, ?, ?)',
  );
  insertEmployee.run('E-1011', '山田 太郎', '営業部', 'ACTIVE');
  insertEmployee.run('E-1024', '佐藤 花子', '情報システム部', 'ACTIVE');
  insertEmployee.run('E-1033', '鈴木 次郎', '営業部', 'RETIRED');
  insertEmployee.run('E-1042', '高橋 三郎', '管理部', 'ACTIVE');
  insertEmployee.run('E-1055', '伊藤 健太', '営業部', 'ACTIVE');
  insertEmployee.run('E-1061', '渡辺 真一', '技術部', 'ACTIVE');
  insertEmployee.run('E-1077', '中村 美咲', '技術部', 'ACTIVE');
  insertEmployee.run('E-1090', '小林 優子', '管理部', 'LEAVE');

  const insertDevice = db.prepare(
    'INSERT INTO devices (asset_no, model_name, device_type, status, purchased_at) VALUES (?, ?, ?, ?, ?)',
  );
  const models = ['ThinkPad X1 Carbon', 'Latitude 5440', 'VAIO SX14', 'dynabook G83', 'ProBook 450'];
  for (let i = 1; i <= 10; i += 1) {
    const status = { 3: 'LENT', 4: 'LENT', 5: 'REPAIR', 6: 'DISPOSED' }[i] || 'AVAILABLE';
    insertDevice.run(`PC-${String(i).padStart(4, '0')}`, models[i % models.length], 'LAPTOP', status, '2024-04-01');
  }
  insertDevice.run('PC-0011', 'iPad Air', 'TABLET', 'AVAILABLE', '2024-04-01');
  insertDevice.run('PC-0012', 'EIZO FlexScan', 'MONITOR', 'AVAILABLE', '2024-04-01');

  const insertLending = db.prepare(
    'INSERT INTO lendings (device_id, user_id, lent_at, due_date, returned_at, purpose) VALUES (?, ?, ?, ?, ?, ?)',
  );
  // 高橋(E-1042)が PC-0003 を借りたまま延滞中 / 伊藤(E-1055)が PC-0004 を貸出中
  insertLending.run(3, 4, at(-10, '09:15:00'), addDays(today, -3), null, '出張');
  insertLending.run(4, 5, at(-1, '10:00:00'), addDays(today, 6), null, '研修');
  // 返却済みの履歴(過去分)
  insertLending.run(1, 1, at(-20, '09:00:00'), addDays(today, -13), at(-14, '17:00:00'), '検証');
}

// 動作確認用:貸出可能なノートPCを 0 件にする(E-07 の確認)
function makeNoAvailableDevices(db) {
  db.prepare("UPDATE devices SET status = 'REPAIR' WHERE device_type = 'LAPTOP' AND status = 'AVAILABLE'").run();
}

function openDb({ reset = false, filePath = DEFAULT_DB_PATH, clock } = {}) {
  if (reset) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(filePath + suffix, { force: true });
  }
  const db = new Database(filePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  // N-02:書き込みロックの待ち時間は 5 秒(超えたら E-32)
  db.pragma(`busy_timeout = ${Number(process.env.DB_BUSY_TIMEOUT_MS) || 5000}`);
  db.exec(SCHEMA);
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM employees').get();
  if (count === 0) seed(db, clock);
  return db;
}

module.exports = { openDb, seed, makeNoAvailableDevices, DEFAULT_DB_PATH };

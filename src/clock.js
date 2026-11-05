// 時刻の取得(N-06:サーバー時刻の日本時間のみを基準にする)
// 動作確認用に FAKE_NOW=2026-04-10T10:00:00+09:00 で現在時刻を固定できる
const FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function systemClock() {
  return { now: () => (process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date()) };
}

// Date → { date: 'YYYY-MM-DD', dateTime: 'YYYY-MM-DD HH:mm:ss' }(日本時間)
function jst(date) {
  const p = Object.fromEntries(FORMATTER.formatToParts(date).map((x) => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  return { date: day, dateTime: `${day} ${p.hour}:${p.minute}:${p.second}` };
}

// 'YYYY-MM-DD HH:mm:ss'(日本時間)→ Date
function parseJst(dateTime) {
  return new Date(`${dateTime.replace(' ', 'T')}+09:00`);
}

module.exports = { systemClock, jst, parseJst };

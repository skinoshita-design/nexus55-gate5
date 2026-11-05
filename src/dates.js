// 日付の解析・計算(返却予定日 R-05 / 延滞判定 R-13)
// 日付は 'YYYY-MM-DD' の文字列で扱う

function dayNumber(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(2000, m - 1, d));
  date.setUTCFullYear(y);
  return Math.round(date.getTime() / 86400000);
}

// b - a の日数
function daysBetween(a, b) {
  return dayNumber(b) - dayNumber(a);
}

function addDays(isoDate, n) {
  const date = new Date((dayNumber(isoDate) + n) * 86400000);
  return date.toISOString().slice(0, 10);
}

// 0=日 ... 6=土
function dayOfWeek(isoDate) {
  return new Date(dayNumber(isoDate) * 86400000).getUTCDay();
}

function isWeekend(isoDate) {
  const w = dayOfWeek(isoDate);
  return w === 0 || w === 6;
}

// 前後の空白(半角・全角)を除去
function trim(value) {
  return String(value ?? '').replace(/^[\s　]+|[\s　]+$/g, '');
}

// I-02:返却予定日の形式チェック。YYYY/MM/DD または YYYY-MM-DD(半角)
// 戻り値 { ok: true, value: 'YYYY-MM-DD' } | { ok: false, reason: 'EMPTY' | 'FORMAT' }
function parseDateInput(raw) {
  const text = trim(raw);
  if (text === '') return { ok: false, reason: 'EMPTY' };
  const m = /^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/.exec(text);
  if (!m) return { ok: false, reason: 'FORMAT' };
  const [y, mo, d] = [Number(m[1]), Number(m[3]), Number(m[4])];
  const check = new Date(Date.UTC(2000, mo - 1, d));
  check.setUTCFullYear(y);
  const real = check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d;
  if (!real) return { ok: false, reason: 'FORMAT' };
  const pad = (n, w) => String(n).padStart(w, '0');
  return { ok: true, value: `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}` };
}

// 'YYYY-MM-DD' → 'YYYY/MM/DD'
function slash(isoDate) {
  return isoDate.replace(/-/g, '/');
}

// 'YYYY-MM-DD HH:mm:ss' → 'YYYY/MM/DD HH:mm'
function slashDateTime(dateTime) {
  const [date, time] = dateTime.split(' ');
  return `${slash(date)} ${time.slice(0, 5)}`;
}

module.exports = {
  daysBetween, addDays, dayOfWeek, isWeekend, trim, parseDateInput, slash, slashDateTime,
};

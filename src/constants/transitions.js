// devices.status の状態遷移表(要件定義書 4.)。画面・サーバー共通で使う
const STATUS_LABELS = {
  AVAILABLE: '貸出可能',
  LENT: '貸出中',
  REPAIR: '修理中',
  DISPOSED: '廃棄済み',
};

// 遷移可能な組み合わせ(これ以外は不可)
const TRANSITIONS = {
  AVAILABLE: { LENT: true, REPAIR: true, DISPOSED: true },
  LENT: { AVAILABLE: true },
  REPAIR: { AVAILABLE: true, DISPOSED: true },
  DISPOSED: {},
};

function canTransition(from, to) {
  return !!(TRANSITIONS[from] && TRANSITIONS[from][to]);
}

module.exports = { STATUS_LABELS, TRANSITIONS, canTransition };

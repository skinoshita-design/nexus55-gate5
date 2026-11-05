// DBを削除してシードデータで作り直す: npm run seed
// 貸出可能なノートPCを 0 件にして作り直す: npm run seed:empty
const { openDb, makeNoAvailableDevices } = require('./db');

const db = openDb({ reset: true });
if (process.argv[2] === 'empty') makeNoAvailableDevices(db);
console.log(process.argv[2] === 'empty'
  ? 'DBを初期化しました(貸出可能なノートPC 0 件)。'
  : 'DBを初期化しました。');
db.close();

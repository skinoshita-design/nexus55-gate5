// DBの中身を表示する: npm run db
const { openDb } = require('./db');

const db = openDb();
console.log('--- devices ---');
console.table(db.prepare('SELECT id, asset_no, model_name, device_type, status FROM devices').all());
console.log('--- lendings ---');
console.table(db.prepare(`
  SELECT l.id, d.asset_no, e.employee_code, l.lent_at, l.due_date, l.returned_at, l.purpose
    FROM lendings l
    JOIN devices d ON d.id = l.device_id
    JOIN employees e ON e.id = l.user_id
   ORDER BY l.id
`).all());
console.log('--- lending_requests ---');
console.table(db.prepare('SELECT token, user_id, device_id, due_date, created_at, used_at, lending_id FROM lending_requests').all());
db.close();

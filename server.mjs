import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseCsv, toTrades, byOrder, roundTrips, report } from './journal.mjs';

const dir = import.meta.dirname;
const db = new DatabaseSync(path.join(dir, 'journal.db'));
db.exec(`CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY, ord TEXT, symbol TEXT, side TEXT, qty REAL, price REAL, time INTEGER)`);
const insert = db.prepare('INSERT OR IGNORE INTO trades VALUES (?, ?, ?, ?, ?, ?, ?)');

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/')
      return send(res, 200, fs.readFileSync(path.join(dir, 'index.html')), 'text/html; charset=utf-8');

    if (req.method === 'POST' && req.url === '/api/import') {
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 50e6) return send(res, 413, { error: 'file too large' });
      }
      const { trades, skipped } = toTrades(parseCsv(text));
      let added = 0;
      db.exec('BEGIN');
      for (const t of trades) added += insert.run(t.id, t.order, t.symbol, t.side, t.qty, t.price, t.time).changes;
      db.exec('COMMIT');
      return send(res, 200, { added, duplicates: trades.length - added, skipped });
    }

    if (req.method === 'GET' && req.url === '/api/report') {
      const rows = db.prepare('SELECT id, ord AS "order", symbol, side, qty, price, time FROM trades').all();
      const { trips, open } = roundTrips(byOrder(rows));
      const r = report(trips);
      return send(res, 200, { ...r, trips: r.trips.slice(-300).reverse(), open, fills: rows.length });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(4310, '127.0.0.1', () => console.log('Trading journal on http://127.0.0.1:4310'));

import assert from 'node:assert/strict';
import { parseCsv, toTrades, byOrder, roundTrips, report } from './journal.mjs';

const csv = `symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time
INFY,X,2026-11-02,NSE,EQ,EQ,buy,false,5,100,t1,o1,2026-11-02T09:20:00
INFY,X,2026-11-02,NSE,EQ,EQ,buy,false,5,102,t2,o1,2026-11-02T09:20:01
INFY,X,2026-11-02,NSE,EQ,EQ,sell,false,10,95,t3,o2,2026-11-02T10:20:00
NIFTY26NOVFUT,X,2026-11-02,NFO,FO,,sell,false,50,200,t4,o3,2026-11-02T10:25:00
NIFTY26NOVFUT,X,2026-11-02,NFO,FO,,buy,false,30,190,t5,o4,2026-11-02T10:40:00
"BAD ROW",X,2026-11-02,NSE,EQ,EQ,hold,false,1,1,t6,o5,2026-11-02T11:00:00`;

const { trades, skipped } = toTrades(parseCsv(csv));
assert.equal(skipped, 1);
const merged = byOrder(trades);
assert.equal(merged.length, 4, 'partial fills of o1 merged');
assert.equal(merged[0].price, 101, 'vwap of fills');

const { trips, open } = roundTrips(merged);
assert.equal(trips.length, 2);
assert.equal(trips[0].pnl, (95 - 101) * 10, 'long loss');
assert.equal(trips[1].side, 'short');
assert.equal(trips[1].pnl, (200 - 190) * 30, 'short win');
assert.deepEqual(open.map(o => [o.symbol, o.qty]), [['NIFTY26NOVFUT', -20]], 'partial short still open');

const r = report(trips, { revengeMin: 15 });
assert.equal(r.summary.pnl, -60 + 300);
assert.equal(r.summary.maxDD, 60);
assert.equal(r.equity.at(-1), 240);

// revenge flag: 3 trades opened within 15 min of a loss
const t0 = Date.parse('2026-11-03T09:30:00');
const mk = (openMin, closeMin, pnl) => ({ symbol: 'X', side: 'long', qty: 1, entry: 0, exit: 0, openedAt: t0 + openMin * 60e3, closedAt: t0 + closeMin * 60e3, pnl });
const r2 = report([mk(0, 5, -100), mk(10, 12, -50), mk(14, 20, -30), mk(22, 30, 10), mk(120, 130, 40)]);
assert.match(r2.flags[0], /^3 trades opened within 15 min of a loss/);

console.log('all checks passed');

import assert from 'node:assert/strict';
import { indicators, simulate, backtest, scan, paperStatus, parseYahoo, SETUPS, verdict, scoreboard, isSymbol, paperReadiness } from './scanner.mjs';

const DAY = 86400e3;
// 300 days of steady uptrend with small wiggles, then a volume breakout on the last day
const k = Array.from({ length: 300 }, (_, i) => {
  const c = 100 + i * 0.2 + (i % 5) - 2;
  return { t: i * DAY, o: c - 0.5, h: c + 1, l: c - 1, c, v: 1000 };
});
k.push({ t: 300 * DAY, o: 162, h: 175, l: 161, c: 174, v: 5000 });

const x = indicators(k);
assert.ok(Math.abs(x.sma200[299] - k.slice(100, 300).reduce((s, d) => s + d.c, 0) / 200) < 1e-9, 'sma200');
assert.ok(x.atr[299] > 0 && x.atr[299] < 5, 'atr sane');

const sigs = scan('TEST', k, { capital: 100000, riskPct: 1 });
assert.ok(sigs.some(s => s.setup === 'breakout'), 'breakout fires on last day');
const b = sigs.find(s => s.setup === 'breakout');
assert.ok(b.stop < b.close && b.target > b.close);
assert.ok(b.qty * (b.close - b.stop) <= 1000 + 1e-6, 'risk capped at 1% of capital');

// simulate: stop checked first, gap-down fills at open
const flat = [{ o: 100, h: 101, l: 99, c: 100 }, { o: 100, h: 102, l: 98, c: 101 }];
const t = simulate(flat, 0, 2); // stop 96, target 106
assert.equal(t, null, 'not finished within data (no stop/target hit day 0, data ends)');
const t2 = simulate([{ o: 100, h: 101, l: 99, c: 100 }, ...Array(25).fill({ o: 90, h: 91, l: 85, c: 88 })], 0, 2);
assert.deepEqual([t2.reason, t2.exit, t2.exitIdx], ['stop', 90, 1], 'gap below stop exits at open');
const t3 = simulate([{ o: 100, h: 107, l: 99, c: 106 }, ...Array(25).fill(k[0])], 0, 2);
assert.equal(t3.reason, 'target');

assert.equal(verdict({ n: 5, avgPct: 3, winRate: 80 }).label, 'Not enough history');
assert.equal(verdict({ n: 30, avgPct: -0.2, winRate: 50 }).tone, 'bad');

const h = backtest(x, SETUPS[0]);
assert.ok(h.n >= 0 && h.winRate <= 100);

// paper trade: pending until a candle after the signal exists
const trade = { signalDate: k.at(-1).t, atr: 2, qty: 10 };
assert.equal(paperStatus(trade, k).status, 'pending');
const later = [...k, { t: 301 * DAY, o: 175, h: 183, l: 174, c: 182, v: 1 }];
const p = paperStatus(trade, later); // entry 175, target 181 -> hit
assert.equal(p.status, 'target');
assert.ok(Math.abs(p.pnl - ((181 - 175) * 10 - 0.0025 * 175 * 10)) < 1e-9);

// today's candle dropped before 4 pm IST, kept after
const today930 = Date.parse('2026-11-16T09:15:00+05:30') / 1000, prev = today930 - 3 * 86400;
const yj = { chart: { result: [{ timestamp: [prev, today930], indicators: { quote: [{ open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], volume: [1, 1] }] } }] } };
assert.equal(parseYahoo(yj, Date.parse('2026-11-16T11:00:00+05:30')).length, 1, 'mid-session candle dropped');
assert.equal(parseYahoo(yj, Date.parse('2026-11-16T17:00:00+05:30')).length, 2, 'after close kept');

const sb = scoreboard({ A: k, B: k, short: k.slice(0, 100) });
assert.equal(sb.length, SETUPS.length);
const one = backtest(x, SETUPS[1]);
assert.equal(sb.find(r => r.id === SETUPS[1].id).n, one.n * 2, 'pools trades across stocks, skips short history');
assert.ok(isSymbol('M&M') && isSymbol('BAJAJ-AUTO') && !isSymbol('reliance') && !isSymbol('A B'));

assert.equal(b.recent.length, 60);
assert.equal(b.recent.at(-1), 174);
const pr = (n, pnl) => Array.from({ length: n }, () => ({ pnl, entry: 100, qty: 10 }));
assert.equal(paperReadiness(pr(5, 50)).ready, false);
assert.match(paperReadiness(pr(19, 50)).label, /^1 more closed paper trade before/);
assert.equal(paperReadiness(pr(20, 50)).ready, true);
assert.equal(paperReadiness([...pr(10, 50), ...pr(10, -80)]).ready, false, 'net loser is not ready');
assert.equal(paperReadiness(pr(20, 50)).avgPct, 5);

assert.throws(() => parseYahoo({ chart: { error: { description: 'No data found' } } }), /No data found/);
console.log('scanner checks passed');

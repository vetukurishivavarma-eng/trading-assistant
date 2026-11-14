// Pure journal logic: CSV -> trades -> round trips -> report. No I/O here.

export function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map(c => c.trim()));
  }
  const [head = [], ...body] = rows;
  const keys = head.map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

const pick = (r, ...names) => { for (const n of names) if (r[n]) return r[n]; return ''; };

// Zerodha tradebook columns first; aliases cover most other Indian brokers' exports.
export function toTrades(rows) {
  const trades = [];
  let skipped = 0;
  for (const r of rows) {
    const side = pick(r, 'tradetype', 'transactiontype', 'type', 'side', 'buysell').toLowerCase();
    let when = pick(r, 'orderexecutiontime', 'tradetime', 'executiontime', 'datetime', 'time') || pick(r, 'tradedate', 'date');
    if (/^\d{4}-\d{2}-\d{2}$/.test(when)) when += 'T00:00'; // date-only file: hour stats meaningless
    const t = {
      symbol: pick(r, 'symbol', 'tradingsymbol', 'scrip', 'instrument'),
      side: side.startsWith('b') ? 'buy' : side.startsWith('s') ? 'sell' : '',
      qty: Number(pick(r, 'quantity', 'qty', 'filledqty')),
      price: Number(pick(r, 'price', 'tradeprice', 'averageprice', 'avgprice')),
      time: new Date(when.replace(' ', 'T')).getTime(),
      order: pick(r, 'orderid'),
    };
    // ponytail: without a trade_id, identical fills at the same second collapse into one
    t.id = pick(r, 'tradeid') || `${t.symbol}|${t.side}|${t.qty}|${t.price}|${t.time}`;
    if (t.symbol && t.side && t.qty > 0 && t.price >= 0 && Number.isFinite(t.time)) trades.push(t);
    else skipped++;
  }
  return { trades, skipped };
}

// Partial fills of one order -> one trade (vwap price, first fill time).
export function byOrder(trades) {
  const m = new Map();
  for (const t of trades) {
    const k = t.order || t.id;
    const a = m.get(k);
    if (!a) m.set(k, { ...t });
    else {
      a.price = (a.price * a.qty + t.price * t.qty) / (a.qty + t.qty);
      a.qty += t.qty;
      a.time = Math.min(a.time, t.time);
    }
  }
  return [...m.values()];
}

// FIFO matching per symbol, handles longs and shorts (option selling).
// ponytail: options that expired worthless have no closing trade, so they stay "open"
export function roundTrips(trades) {
  const open = new Map();
  const trips = [];
  for (const t of [...trades].sort((a, b) => a.time - b.time)) {
    if (!open.has(t.symbol)) open.set(t.symbol, []);
    const lots = open.get(t.symbol);
    let q = t.side === 'buy' ? t.qty : -t.qty;
    while (q && lots.length && Math.sign(lots[0].qty) !== Math.sign(q)) {
      const lot = lots[0];
      const dir = Math.sign(lot.qty);
      const n = Math.min(Math.abs(q), Math.abs(lot.qty));
      trips.push({
        symbol: t.symbol, side: dir > 0 ? 'long' : 'short', qty: n,
        entry: lot.price, exit: t.price, openedAt: lot.time, closedAt: t.time,
        pnl: dir * (t.price - lot.price) * n,
      });
      lot.qty -= dir * n;
      q += dir * n;
      if (!lot.qty) lots.shift();
    }
    if (q) lots.push({ qty: q, price: t.price, time: t.time });
  }
  const stillOpen = [...open].flatMap(([symbol, lots]) => lots.map(l => ({ symbol, ...l })));
  return { trips, open: stillOpen };
}

const day = ms => new Date(ms).toLocaleDateString('en-CA');
const inr = n => `₹${Math.round(n).toLocaleString('en-IN')}`;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function group(trips, key) {
  const m = {};
  for (const t of trips) {
    const g = (m[key(t)] ??= { n: 0, pnl: 0, wins: 0 });
    g.n++; g.pnl += t.pnl; if (t.pnl > 0) g.wins++;
  }
  return m;
}

const stat = list => ({
  n: list.length,
  pnl: list.reduce((s, t) => s + t.pnl, 0),
  winRate: pct(list.filter(t => t.pnl > 0).length, list.length),
});

export function report(trips, { revengeMin = 15, busyDay = 5 } = {}) {
  const sorted = [...trips].sort((a, b) => a.closedAt - b.closedAt);
  const wins = sorted.filter(t => t.pnl > 0), losses = sorted.filter(t => t.pnl < 0);
  const total = stat(sorted);
  const avgWin = wins.length ? stat(wins).pnl / wins.length : 0;
  const avgLoss = losses.length ? -stat(losses).pnl / losses.length : 0;

  let eq = 0, peak = 0, maxDD = 0;
  const equity = sorted.map(t => { eq += t.pnl; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); return eq; });

  // ponytail: O(n²) scan, fine for a personal journal of a few thousand trades
  const isRevenge = t => losses.some(l => l.closedAt <= t.openedAt && t.openedAt - l.closedAt <= revengeMin * 60e3);
  const revenge = stat(sorted.filter(isRevenge));
  const calm = stat(sorted.filter(t => !isRevenge(t)));

  const byDay = group(sorted, t => day(t.openedAt));
  const busy = Object.values(byDay).filter(d => d.n > busyDay);
  const normal = Object.values(byDay).filter(d => d.n <= busyDay);
  const sumDays = ds => ds.reduce((s, d) => s + d.pnl, 0);

  const mins = list => list.length ? list.reduce((s, t) => s + (t.closedAt - t.openedAt), 0) / list.length / 60e3 : 0;
  const holdWin = mins(wins), holdLoss = mins(losses);

  const byHour = group(sorted, t => String(new Date(t.openedAt).getHours()).padStart(2, '0') + ':00');
  const byWeekday = group(sorted, t => new Date(t.openedAt).toLocaleDateString('en-IN', { weekday: 'short' }));
  const bySymbol = group(sorted, t => t.symbol);

  const flags = [];
  if (revenge.n >= 3)
    flags.push(`${revenge.n} trades opened within ${revengeMin} min of a loss: net ${inr(revenge.pnl)}, win rate ${revenge.winRate}% (vs ${calm.winRate}% otherwise).`);
  if (busy.length && normal.length)
    flags.push(`Days with more than ${busyDay} trades: ${inr(sumDays(busy))} over ${busy.length} days. Other days: ${inr(sumDays(normal))} over ${normal.length} days.`);
  if (wins.length && losses.length && holdLoss > holdWin * 1.5)
    flags.push(`You hold losers ${(holdLoss / holdWin).toFixed(1)}x longer than winners (${Math.round(holdLoss)} vs ${Math.round(holdWin)} min).`);
  if (avgWin && avgLoss) {
    const needed = pct(avgLoss, avgWin + avgLoss);
    flags.push(`Avg win ${inr(avgWin)}, avg loss ${inr(avgLoss)}: you need a ${needed}% win rate to break even, you have ${total.winRate}%.`);
  }
  const worst = (m, label) => {
    const [k, g] = Object.entries(m).sort((a, b) => a[1].pnl - b[1].pnl)[0] ?? [];
    if (g && g.pnl < 0 && g.n >= 3) flags.push(`Worst ${label}: ${k}, ${inr(g.pnl)} over ${g.n} trades.`);
  };
  worst(byHour, 'entry hour'); worst(byWeekday, 'weekday'); worst(bySymbol, 'symbol');
  if (losses.length >= 5) {
    const big = Math.min(...losses.map(t => t.pnl));
    flags.push(`Your single biggest loss (${inr(big)}) is ${pct(big, stat(losses).pnl)}% of all losses.`);
  }

  return {
    summary: { ...total, avgWin, avgLoss, maxDD, profitFactor: avgLoss ? stat(wins).pnl / -stat(losses).pnl : null },
    flags, equity, byHour, byWeekday, bySymbol, byDay,
  };
}

// Swing-trade scanner: daily candles -> setups firing today -> each judged by its own history on that stock.
// Pure logic + one fetch helper. Shared by the web server and the Android app.

// ponytail: hand-kept Nifty 50 list (Nov 2026); edit when the index rebalances, failed symbols are just skipped
export const NIFTY50 = ['ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK', 'BAJAJ-AUTO', 'BAJFINANCE',
  'BAJAJFINSV', 'BEL', 'BHARTIARTL', 'CIPLA', 'COALINDIA', 'DRREDDY', 'EICHERMOT', 'ETERNAL', 'GRASIM', 'HCLTECH',
  'HDFCBANK', 'HDFCLIFE', 'HINDALCO', 'HINDUNILVR', 'ICICIBANK', 'INDIGO', 'INFY', 'ITC', 'JIOFIN', 'JSWSTEEL',
  'KOTAKBANK', 'LT', 'M&M', 'MARUTI', 'MAXHEALTH', 'NESTLEIND', 'NTPC', 'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE',
  'SBIN', 'SHRIRAMFIN', 'SUNPHARMA', 'TATACONSUM', 'TATASTEEL', 'TCS', 'TECHM', 'TITAN', 'TRENT', 'ULTRACEMCO', 'WIPRO'];

export const COST_PCT = 0.25;   // approx delivery round trip: STT 0.1%x2 + exchange/GST/stamp/DP
export const STOP_ATR = 2, TARGET_ATR = 3, MAX_HOLD = 20;

// ponytail: Yahoo's unofficial chart API, free + no key; swap for the broker's historical API once there is one
export async function fetchCandles(symbol, fetchFn = fetch) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.NS?range=10y&interval=1d`;
  const res = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  return parseYahoo(await res.json());
}

const IST = 5.5 * 3600e3;
const istDay = ms => Math.floor((ms + IST) / 86400e3);

// Drops today's still-forming candle before 4 pm IST, so signals only use finished days.
export function parseYahoo(json, now = Date.now()) {
  const r = json?.chart?.result?.[0];
  if (!r?.timestamp) throw new Error(json?.chart?.error?.description || 'no data');
  const q = r.indicators.quote[0];
  const k = r.timestamp
    .map((t, i) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] }))
    .filter(k => k.o != null && k.h != null && k.l != null && k.c != null);
  const marketOpen = ((now + IST) % 86400e3) < 16 * 3600e3;
  if (k.length && istDay(k.at(-1).t) === istDay(now) && marketOpen) k.pop();
  return k;
}

function sma(xs, n) {
  const out = Array(xs.length).fill(null);
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    s += xs[i];
    if (i >= n) s -= xs[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

function rsi(c, n) { // Wilder
  const out = Array(c.length).fill(null);
  let up = 0, down = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0);
    if (i <= n) { up += u / n; down += w / n; } else { up = (up * (n - 1) + u) / n; down = (down * (n - 1) + w) / n; }
    if (i >= n) out[i] = down === 0 ? 100 : 100 - 100 / (1 + up / down);
  }
  return out;
}

function atr(k, n) {
  const tr = k.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - k[i - 1].c), Math.abs(x.l - k[i - 1].c)) : x.h - x.l));
  return wilder(tr, n);
}
function wilder(xs, n) {
  const out = Array(xs.length).fill(null);
  let a = 0;
  for (let i = 0; i < xs.length; i++) {
    a = i < n ? a + xs[i] / n : (a * (n - 1) + xs[i]) / n;
    if (i >= n - 1) out[i] = a;
  }
  return out;
}

export function indicators(k) {
  const c = k.map(x => x.c), v = k.map(x => x.v || 0);
  const hi20 = k.map((_, i) => (i >= 20 ? Math.max(...k.slice(i - 20, i).map(x => x.h)) : null));
  return { k, c, sma50: sma(c, 50), sma200: sma(c, 200), rsi2: rsi(c, 2), atr: atr(k, 14), hi20, vol20: sma(v, 20), v };
}

export const SETUPS = [
  { id: 'breakout', name: '20-day breakout on volume',
    why: 'Closed above the highest high of the last 20 days with 1.5x normal volume, in a long-term uptrend.',
    test: (x, i) => x.sma200[i] != null && x.c[i] > x.hi20[i] && x.v[i] > 1.5 * x.vol20[i - 1] && x.c[i] > x.sma200[i] },
  { id: 'pullback', name: 'Dip in an uptrend',
    why: 'Long-term uptrend (above the 200-day average) but sold off sharply for 2 days (RSI-2 under 10).',
    test: (x, i) => x.sma200[i] != null && x.c[i] > x.sma200[i] && x.sma50[i] > x.sma200[i] && x.rsi2[i] < 10 },
  { id: 'golden', name: 'Golden cross',
    why: 'The 50-day average just crossed above the 200-day average: a new long-term uptrend may be starting.',
    test: (x, i) => x.sma200[i - 1] != null && x.sma50[i] > x.sma200[i] && x.sma50[i - 1] <= x.sma200[i - 1] },
];

// Enter at next day's open; stop 2 ATR below, target 3 ATR above, exit at close after MAX_HOLD days.
// Stop is checked before target on the same day (assume the worst).
export function simulate(k, entryIdx, atrValue) {
  const entry = k[entryIdx].o, stop = entry - STOP_ATR * atrValue, target = entry + TARGET_ATR * atrValue;
  for (let j = entryIdx; j < k.length && j < entryIdx + MAX_HOLD; j++) {
    const d = k[j];
    if (d.l <= stop) return { exitIdx: j, exit: Math.min(d.o, stop), reason: 'stop', entry };
    if (d.h >= target) return { exitIdx: j, exit: Math.max(d.o, target), reason: 'target', entry };
  }
  const last = entryIdx + MAX_HOLD - 1;
  if (last >= k.length) return null; // still running
  return { exitIdx: last, exit: k[last].c, reason: 'time', entry };
}

const netPct = t => (t.exit / t.entry - 1) * 100 - COST_PCT;

export function backtest(x, setup) {
  const rets = [];
  for (let i = 200; i < x.k.length - 1; i++) {
    if (!setup.test(x, i)) continue;
    const t = simulate(x.k, i + 1, x.atr[i]);
    if (!t) break;
    rets.push(netPct(t));
    i = t.exitIdx; // no overlapping trades: one position at a time
  }
  const n = rets.length;
  return {
    n,
    winRate: n ? Math.round((rets.filter(r => r > 0).length / n) * 100) : 0,
    avgPct: n ? rets.reduce((a, b) => a + b, 0) / n : 0,
    worstPct: n ? Math.min(...rets) : 0,
  };
}

export function verdict(h) {
  if (h.n < 10) return { label: 'Not enough history', tone: 'meh' };
  if (h.avgPct >= 0.5 && h.winRate >= 45) return { label: 'Worth a look', tone: 'good' };
  if (h.avgPct > 0) return { label: 'Weak edge', tone: 'meh' };
  return { label: 'Skip: lost money historically', tone: 'bad' };
}

// Setups firing on the latest candle, each with its own track record and a sized plan.
export function scan(symbol, k, { capital = 100000, riskPct = 1 } = {}) {
  if (k.length < 260) return [];
  const x = indicators(k), i = k.length - 1, a = x.atr[i], close = x.c[i];
  return SETUPS.filter(s => s.test(x, i)).map(s => {
    const history = backtest(x, s);
    const riskPerShare = STOP_ATR * a;
    const qty = Math.max(0, Math.min(Math.floor((capital * riskPct) / 100 / riskPerShare), Math.floor(capital / close)));
    return {
      symbol, setup: s.id, name: s.name, why: s.why, date: k[i].t, close, atr: a,
      stop: close - riskPerShare, target: close + TARGET_ATR * a, qty,
      history, verdict: verdict(history),
    };
  });
}

// Paper trade lifecycle, same rules as the backtest: fills at the open after the signal day.
export function paperStatus(trade, k) {
  const entryIdx = k.findIndex(d => d.t > trade.signalDate);
  if (entryIdx < 0) return { status: 'pending' };
  const t = simulate(k, entryIdx, trade.atr);
  const entry = k[entryIdx].o;
  if (!t) {
    const last = k.at(-1).c;
    return { status: 'open', entry, last, pnl: (last - entry) * trade.qty, stop: entry - STOP_ATR * trade.atr, target: entry + TARGET_ATR * trade.atr };
  }
  return { status: t.reason, entry, exit: t.exit, exitDate: k[t.exitIdx].t, pnl: (t.exit - entry) * trade.qty - (COST_PCT / 100) * entry * trade.qty };
}

// Small-concurrency fetch of the whole watchlist.
export async function fetchAll(symbols, fetchFn = fetch, onProgress = () => {}, limit = 5) {
  const out = {}, errors = [];
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < symbols.length) {
      const s = symbols[next++];
      try { out[s] = await fetchCandles(s, fetchFn); } catch (e) { errors.push(`${s}: ${e.message}`); }
      onProgress(++done, symbols.length);
    }
  }));
  return { candles: out, errors };
}

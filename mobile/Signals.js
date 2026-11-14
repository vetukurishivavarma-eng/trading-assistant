import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { NIFTY50, fetchAll, scan, paperStatus, scoreboard, isSymbol, paperReadiness } from '../scanner.mjs';
import { db, getSetting, setSetting } from './db';
import { showDialog } from './dialog';

const inr = n => (n < 0 ? '−₹' : '₹') + Math.abs(Math.round(n)).toLocaleString('en-IN');
const day = ms => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const pct = n => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

// Weekday 4 pm reminder to scan. ponytail: a reminder, not a background scan (Android kills those); add a server push if wanted
async function ensureReminder() {
  if (getSetting('reminder', '') === '1') return;
  const { granted } = await Notifications.requestPermissionsAsync();
  if (!granted) return;
  await Notifications.setNotificationChannelAsync('scan', { name: 'Daily scan reminder', importance: Notifications.AndroidImportance.DEFAULT });
  for (const weekday of [2, 3, 4, 5, 6]) // Mon..Fri (1 = Sunday)
    await Notifications.scheduleNotificationAsync({
      content: { title: 'Market closed', body: 'Open Trade Journal and scan today\'s setups.' },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.WEEKLY, weekday, hour: 16, minute: 0, channelId: 'scan' },
    });
  setSetting('reminder', '1');
}

// Last ~3 months of closes as thin bars, with entry/stop/target lines. Plain views, no chart library.
function MiniChart({ g, c }) {
  const H = 110, vals = g.recent;
  if (!vals?.length) return null;
  const lo = Math.min(...vals, g.stop), hi = Math.max(...vals, g.target), span = hi - lo || 1;
  const y = v => ((hi - v) / span) * H;
  const line = (v, color, label) => (
    <View key={label} style={{ position: 'absolute', left: 0, right: 0, top: y(v) }}>
      <View style={{ height: 1.5, backgroundColor: color, opacity: 0.9 }} />
      <Text style={{ position: 'absolute', right: 2, top: -15, fontSize: 10, color, fontWeight: '700' }}>{label} {Math.round(v)}</Text>
    </View>
  );
  return (
    <View style={{ height: H, marginTop: 10, flexDirection: 'row', alignItems: 'flex-end' }}>
      {vals.map((v, i) => (
        <View key={i} style={{ flex: 1, marginHorizontal: 0.5, height: Math.max(1, H - y(v)), backgroundColor: c.line }} />
      ))}
      {line(g.target, c.up, 'Target')}
      {line(g.close, c.accent, 'Entry ~')}
      {line(g.stop, c.down, 'Stop')}
    </View>
  );
}

const loadPaper = () => db.getAllSync('SELECT * FROM paper ORDER BY id DESC').map(p => ({ ...p, st: JSON.parse(p.status || '{"status":"pending"}') }));

export default function Signals({ c, s }) {
  const [capital, setCapital] = useState(getSetting('capital', '100000'));
  const [risk, setRisk] = useState(getSetting('risk', '1'));
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [skipped, setSkipped] = useState({});
  const [paper, setPaper] = useState(loadPaper);
  const [extra, setExtra] = useState(getSetting('extra', ''));
  const [help, setHelp] = useState(false);
  const tone = { good: c.up, meh: c.accent, bad: c.down };

  useEffect(() => { ensureReminder().catch(() => {}); }, []);

  async function runScan() {
    const cap = Math.max(1000, Number(capital) || 100000), rk = Math.min(5, Math.max(0.1, Number(risk) || 1));
    setSetting('capital', cap); setSetting('risk', rk);
    const mine = extra.toUpperCase().split(/[s,]+/).filter(Boolean);
    const bad = mine.filter(x => !isSymbol(x));
    if (bad.length) return showDialog('Check your stocks', `These don't look like NSE symbols: ${bad.join(', ')}

Use the NSE code, e.g. ZOMATO, IRCTC, TATAPOWER.`);
    setExtra(mine.join(', ')); setSetting('extra', mine.join(', '));
    const symbols = [...new Set([...NIFTY50, ...mine, ...paper.filter(p => !['stop', 'target', 'time'].includes(p.st.status)).map(p => p.symbol)])];
    setBusy('Starting…');
    try {
      const { candles, errors } = await fetchAll(symbols, fetch, (d, n) => setBusy(`Fetching ${d}/${n}`));
      setBusy('Checking setups against 10 years of history…');
      await new Promise(r => setTimeout(r, 30)); // let the label paint before the heavy loop
      const signals = Object.entries(candles).flatMap(([sym, k]) => scan(sym, k, { capital: cap, riskPct: rk }));
      const order = { good: 0, meh: 1, bad: 2 };
      signals.sort((a, b) => order[a.verdict.tone] - order[b.verdict.tone] || b.history.avgPct - a.history.avgPct);
      for (const p of paper) if (candles[p.symbol])
        db.runSync('UPDATE paper SET status = ? WHERE id = ?', JSON.stringify(paperStatus({ signalDate: p.signal_date, atr: p.atr, qty: p.qty }, candles[p.symbol])), p.id);
      const anyK = Object.values(candles)[0];
      setResult({ signals, errors, asOf: anyK?.at(-1)?.t, at: Date.now(), board: scoreboard(candles) });
      setPaper(loadPaper());
    } catch (e) {
      showDialog('Scan failed', e.message);
    }
    setBusy('');
  }

  function approve(g) {
    showDialog(`Paper trade ${g.symbol}?`,
      `Pretend-buy ${g.qty} shares at tomorrow's open (about ${inr(g.close)} each).\nStop ${inr(g.stop)} · Target ${inr(g.target)}\n\nNo real money. It tracks how this signal would have done.`,
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Approve', onPress: () => {
        db.runSync('INSERT INTO paper (symbol, setup, name, signal_date, atr, qty, plan_close, created, status) VALUES (?,?,?,?,?,?,?,?,?)',
          g.symbol, g.setup, g.name, g.date, g.atr, g.qty, g.close, Date.now(), '{"status":"pending"}');
        setSkipped(x => ({ ...x, [g.symbol + g.setup]: true }));
        setPaper(loadPaper());
      } }]);
  }

  function removePaper(p) {
    showDialog('Remove paper trade?', `${p.symbol}, ${p.name}`, [{ text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => { db.runSync('DELETE FROM paper WHERE id = ?', p.id); setPaper(loadPaper()); } }]);
  }

  const paperStats = useMemo(() => {
    const closed = paper.filter(p => ['stop', 'target', 'time'].includes(p.st.status));
    const open = paper.filter(p => p.st.status === 'open');
    return {
      readiness: paperReadiness(closed.map(p => ({ pnl: p.st.pnl, entry: p.st.entry, qty: p.qty }))),
      closed: closed.length, wins: closed.filter(p => p.st.pnl > 0).length,
      realised: closed.reduce((a, p) => a + p.st.pnl, 0), unrealised: open.reduce((a, p) => a + p.st.pnl, 0),
    };
  }, [paper]);

  const visible = (result?.signals || []).filter(g => !skipped[g.symbol + g.setup]);

  return (
    <>
      <Text style={s.h1}>Signals</Text>
      <Text style={s.mute}>Swing setups on Nifty 50 daily candles. Each one is checked against what happened the last times it fired on that stock. Rules and history, not advice: paper trade first.</Text>
      <Pressable onPress={() => setHelp(h => !h)} style={{ marginTop: 8 }}>
        <Text style={{ color: c.accent, fontWeight: '600' }}>{help ? 'Hide explanations' : 'What do these mean?'}</Text>
      </Pressable>
      {help && (
        <View style={[s.card, { width: '100%', marginTop: 8 }]}>
          {[
            ['Swing trade', 'Buy and hold for a few days to a few weeks, not intraday. You only need to check once a day after 4 pm.'],
            ['Stop-loss', 'The price where you accept you were wrong and sell, to keep a loss small. Here it is 2 × the stock’s normal daily move (ATR) below entry.'],
            ['Target', 'The price where you take profit: 3 × ATR above entry, so a win is bigger than a loss.'],
            ['Risk per trade %', 'How much of your capital one bad trade may cost. 1% of ₹1,00,000 = ₹1,000. The app sizes the quantity so hitting the stop loses about that.'],
            ['Win rate / average', 'From replaying the same rule on that stock’s last ~10 years: how often it made money, and the average result per trade after ~0.25% costs.'],
            ['Paper trade', 'Pretend money. The app tracks it with real prices so you learn whether the signals work before risking cash.'],
          ].map(([k, v]) => (
            <Text key={k} style={[s.cell, { marginBottom: 8, lineHeight: 20 }]}><Text style={{ fontWeight: '700' }}>{k}: </Text>{v}</Text>
          ))}
        </View>
      )}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
        <View style={{ flex: 1 }}>
          <Text style={s.small}>Capital (₹)</Text>
          <TextInput style={s.input} keyboardType="numeric" value={capital} onChangeText={setCapital} />
        </View>
        <View style={{ width: 110 }}>
          <Text style={s.small}>Risk per trade %</Text>
          <TextInput style={s.input} keyboardType="decimal-pad" value={risk} onChangeText={setRisk} />
        </View>
      </View>

      <Text style={[s.small, { marginTop: 10 }]}>Your extra stocks (NSE codes, comma separated)</Text>
      <TextInput style={s.input} autoCapitalize="characters" autoCorrect={false} placeholder="e.g. IRCTC, TATAPOWER" placeholderTextColor={c.mute} value={extra} onChangeText={setExtra} />

      <Pressable style={({ pressed }) => [s.btn, (pressed || busy) && { opacity: 0.6 }]} onPress={runScan} disabled={!!busy}>
        <Text style={s.btnText}>{busy || 'Scan Nifty 50'}</Text>
      </Pressable>

      {result && (
        <Text style={s.mute}>
          Candles up to {day(result.asOf)} · {result.signals.length} setup{result.signals.length === 1 ? '' : 's'} today
          {result.errors.length ? ` · ${result.errors.length} stocks failed to load` : ''}
        </Text>
      )}
      {result?.board && (
        <View style={[s.card, { width: '100%', marginTop: 10 }]}>
          <Text style={[s.cell, { fontWeight: '700', marginBottom: 6 }]}>How each setup did on these stocks (~10 years)</Text>
          {result.board.map(b => (
            <Text key={b.id} style={[s.cell, { lineHeight: 21 }]}>
              <Text style={{ fontWeight: '600' }}>{b.name}: </Text>
              <Text style={{ color: b.avgPct > 0 ? c.up : c.down }}>{pct(b.avgPct)}</Text> per trade, won {b.winRate}% of {b.n}, made money on {b.stocksUp}/{b.stocks} stocks
            </Text>
          ))}
          <Text style={[s.small, { marginTop: 6, lineHeight: 17 }]}>Small edges are normal: even good setups win only about half the time. The stop-loss keeps losers small so winners can pay for them.</Text>
        </View>
      )}
      {result && !visible.length && <Text style={[s.flag, { marginTop: 10 }]}>Nothing today. No setup is also a signal: sitting out is a position.</Text>}

      {visible.map(g => (
        <View key={g.symbol + g.setup} style={[s.card, { width: '100%', marginTop: 10, borderLeftWidth: 3, borderLeftColor: tone[g.verdict.tone] }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={[s.cell, { fontSize: 17, fontWeight: '700' }]}>{g.symbol}</Text>
            <Text style={{ color: tone[g.verdict.tone], fontWeight: '700' }}>{g.verdict.label}</Text>
          </View>
          <Text style={[s.cell, { marginTop: 2 }]}>{g.name}</Text>
          <Text style={[s.small, { marginTop: 4, lineHeight: 17 }]}>{g.why}</Text>
          <Text style={[s.cell, { marginTop: 8, lineHeight: 20 }]}>
            Past signals on {g.symbol}: {g.history.n} trades, won {g.history.winRate}%, average {pct(g.history.avgPct)} after costs, worst {pct(g.history.worstPct)}
          </Text>
          <Text style={[s.cell, { marginTop: 6, lineHeight: 20 }]}>
            Plan: buy {g.qty} at tomorrow's open (~{inr(g.close)}) · stop {inr(g.stop)} · target {inr(g.target)} · max loss ~{inr(g.qty * (g.close - g.stop))}
          </Text>
          <MiniChart g={g} c={c} />
          <Text style={[s.small, { marginTop: 4 }]}>Last 3 months of closing prices</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
            <Pressable onPress={() => approve(g)} style={[s.smallBtn, { backgroundColor: c.accent }]}><Text style={s.btnText}>Paper trade</Text></Pressable>
            <Pressable onPress={() => setSkipped(x => ({ ...x, [g.symbol + g.setup]: true }))} style={[s.smallBtn, { borderColor: c.line, borderWidth: 1 }]}><Text style={s.cell}>Skip</Text></Pressable>
          </View>
        </View>
      ))}

      <Text style={s.h2}>Paper trades</Text>
      {!paper.length ? <Text style={s.mute}>None yet. Approve a signal to start tracking it with pretend money.</Text> : (
        <>
          <Text style={[s.cell, { marginBottom: 8 }]}>
            Closed {paperStats.closed} (won {paperStats.wins}) · realised {inr(paperStats.realised)} · open {inr(paperStats.unrealised)}
          </Text>
          <View style={[s.flag, { borderLeftColor: paperStats.readiness.ready ? c.up : c.accent }]}>
            <Text style={[s.cell, { fontWeight: '700' }]}>Ready for real money?</Text>
            <Text style={[s.cell, { marginTop: 4, lineHeight: 20 }]}>
              {paperStats.readiness.n >= 20
                ? `${paperStats.readiness.n} closed: won ${paperStats.readiness.winRate}%, average ${pct(paperStats.readiness.avgPct)} per trade, total ${inr(paperStats.readiness.total)}. `
                : ''}{paperStats.readiness.label}
            </Text>
          </View>
          <View style={s.table}>
            {paper.map(p => {
              const st = p.st, label = { pending: 'waiting for next open', open: 'open', stop: 'stopped out', target: 'hit target', time: 'closed after 20 days' }[st.status];
              return (
                <Pressable key={p.id} onLongPress={() => removePaper(p)} style={s.trip}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.cell}>{p.symbol} · {p.qty} sh</Text>
                    <Text style={s.small}>{p.name} · {day(p.signal_date)} · {label}{st.entry ? ` · in ${st.entry.toFixed(1)}` : ''}{st.exit ? ` → ${st.exit.toFixed(1)}` : ''}</Text>
                  </View>
                  {st.pnl != null && <Text style={[s.cell, { fontWeight: '600', color: st.pnl >= 0 ? c.up : c.down }]}>{inr(st.pnl)}</Text>}
                </Pressable>
              );
            })}
          </View>
          <Text style={[s.small, { marginTop: 6 }]}>Scan again each day to update. Long-press a trade to remove it.</Text>
        </>
      )}
    </>
  );
}

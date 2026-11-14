import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { NIFTY50, fetchAll, scan, paperStatus } from '../scanner.mjs';
import { db, getSetting, setSetting } from './db';

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

const loadPaper = () => db.getAllSync('SELECT * FROM paper ORDER BY id DESC').map(p => ({ ...p, st: JSON.parse(p.status || '{"status":"pending"}') }));

export default function Signals({ c, s }) {
  const [capital, setCapital] = useState(getSetting('capital', '100000'));
  const [risk, setRisk] = useState(getSetting('risk', '1'));
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [skipped, setSkipped] = useState({});
  const [paper, setPaper] = useState(loadPaper);
  const tone = { good: c.up, meh: c.accent, bad: c.down };

  useEffect(() => { ensureReminder().catch(() => {}); }, []);

  async function runScan() {
    const cap = Math.max(1000, Number(capital) || 100000), rk = Math.min(5, Math.max(0.1, Number(risk) || 1));
    setSetting('capital', cap); setSetting('risk', rk);
    const symbols = [...new Set([...NIFTY50, ...paper.filter(p => !['stop', 'target', 'time'].includes(p.st.status)).map(p => p.symbol)])];
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
      setResult({ signals, errors, asOf: anyK?.at(-1)?.t, at: Date.now() });
      setPaper(loadPaper());
    } catch (e) {
      Alert.alert('Scan failed', e.message);
    }
    setBusy('');
  }

  function approve(g) {
    Alert.alert(`Paper trade ${g.symbol}?`,
      `Pretend-buy ${g.qty} shares at tomorrow's open (about ${inr(g.close)} each).\nStop ${inr(g.stop)} · Target ${inr(g.target)}\n\nNo real money. It tracks how this signal would have done.`,
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Approve', onPress: () => {
        db.runSync('INSERT INTO paper (symbol, setup, name, signal_date, atr, qty, plan_close, created, status) VALUES (?,?,?,?,?,?,?,?,?)',
          g.symbol, g.setup, g.name, g.date, g.atr, g.qty, g.close, Date.now(), '{"status":"pending"}');
        setSkipped(x => ({ ...x, [g.symbol + g.setup]: true }));
        setPaper(loadPaper());
      } }]);
  }

  function removePaper(p) {
    Alert.alert('Remove paper trade?', `${p.symbol}, ${p.name}`, [{ text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => { db.runSync('DELETE FROM paper WHERE id = ?', p.id); setPaper(loadPaper()); } }]);
  }

  const paperStats = useMemo(() => {
    const closed = paper.filter(p => ['stop', 'target', 'time'].includes(p.st.status));
    const open = paper.filter(p => p.st.status === 'open');
    return {
      closed: closed.length, wins: closed.filter(p => p.st.pnl > 0).length,
      realised: closed.reduce((a, p) => a + p.st.pnl, 0), unrealised: open.reduce((a, p) => a + p.st.pnl, 0),
    };
  }, [paper]);

  const visible = (result?.signals || []).filter(g => !skipped[g.symbol + g.setup]);

  return (
    <>
      <Text style={s.h1}>Signals</Text>
      <Text style={s.mute}>Swing setups on Nifty 50 daily candles. Each one is checked against what happened the last times it fired on that stock. Rules and history, not advice: paper trade first.</Text>

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

      <Pressable style={({ pressed }) => [s.btn, (pressed || busy) && { opacity: 0.6 }]} onPress={runScan} disabled={!!busy}>
        <Text style={s.btnText}>{busy || 'Scan Nifty 50'}</Text>
      </Pressable>

      {result && (
        <Text style={s.mute}>
          Candles up to {day(result.asOf)} · {result.signals.length} setup{result.signals.length === 1 ? '' : 's'} today
          {result.errors.length ? ` · ${result.errors.length} stocks failed to load` : ''}
        </Text>
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

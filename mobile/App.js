import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { parseCsv, toTrades, byOrder, roundTrips, report } from '../journal.mjs';
import { db } from './db';
import Signals from './Signals';
import { useAutoUpdate } from './update';

const LIGHT = { bg: '#f6f4ef', card: '#fff', ink: '#1d1c1a', mute: '#77736b', line: '#e4e0d7', up: '#1f7a4d', down: '#b3361f', accent: '#c98a12' };
const DARK = { bg: '#141413', card: '#1e1d1b', ink: '#ece9e2', mute: '#9a958b', line: '#2e2c29', up: '#4cc38a', down: '#f07a5f', accent: '#e0a42a' };

const inr = n => (n < 0 ? '−₹' : '₹') + Math.abs(Math.round(n)).toLocaleString('en-IN');
const dt = ms => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function load() {
  const rows = db.getAllSync('SELECT id, ord AS "order", symbol, side, qty, price, time FROM trades');
  const { trips, open } = roundTrips(byOrder(rows));
  return { ...report(trips), trips: trips.slice(-100).reverse(), open, fills: rows.length };
}

export default function App() {
  const c = useColorScheme() === 'dark' ? DARK : LIGHT;
  const s = useMemo(() => styles(c), [c]);
  const [tab, setTab] = useState('signals');
  const updating = useAutoUpdate();
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root} edges={['top', 'bottom']}>
        <StatusBar style={c === DARK ? 'light' : 'dark'} />
        <View style={s.tabs}>
          {[['signals', 'Signals'], ['journal', 'Journal']].map(([id, label]) => (
            <Pressable key={id} onPress={() => setTab(id)} style={[s.tab, tab === id && { borderBottomColor: c.accent }]}>
              <Text style={[s.tabText, tab === id && { color: c.ink }]}>{label}</Text>
            </Pressable>
          ))}
        </View>
        {!!updating && <Text style={[s.small, { textAlign: 'center', paddingVertical: 6, color: c.accent }]}>{updating}</Text>}
        <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
          {tab === 'signals' ? <Signals c={c} s={s} /> : <Journal c={c} s={s} />}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Journal({ c, s }) {
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const r = useMemo(load, [tick]);
  const pnlColor = n => (n > 0 ? c.up : n < 0 ? c.down : c.ink);

  async function importCsv() {
    const res = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
    if (res.canceled) return;
    setBusy(true);
    const msgs = [];
    for (const a of res.assets) {
      try {
        const { trades, skipped } = toTrades(parseCsv(await new File(a.uri).text()));
        let added = 0;
        db.withTransactionSync(() => {
          for (const t of trades)
            added += db.runSync('INSERT OR IGNORE INTO trades VALUES (?, ?, ?, ?, ?, ?, ?)', t.id, t.order, t.symbol, t.side, t.qty, t.price, t.time).changes;
        });
        msgs.push(`${a.name}: ${added} new, ${trades.length - added} already imported, ${skipped} unreadable`);
      } catch (e) {
        msgs.push(`${a.name}: ${e.message}`);
      }
    }
    setStatus(msgs.join('\n'));
    setBusy(false);
    setTick(t => t + 1);
  }

  function clearAll() {
    Alert.alert('Delete all trades?', 'This removes every imported trade from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { db.execSync('DELETE FROM trades'); setStatus(''); setTick(t => t + 1); } },
    ]);
  }

  const sum = r.summary;
  return (
    <>
          <Text style={s.h1}>Journal</Text>
          <Text style={s.mute}>Gross P&L before charges. Zerodha: Console → Reports → Tradebook → download CSV.</Text>

          <Pressable style={({ pressed }) => [s.btn, (pressed || busy) && { opacity: 0.6 }]} onPress={importCsv} disabled={busy}>
            <Text style={s.btnText}>{busy ? 'Importing…' : 'Import tradebook CSV'}</Text>
          </Pressable>
          {!!status && <Text style={[s.mute, { marginBottom: 8 }]}>{status}</Text>}

          {!sum.n ? (
            <Text style={[s.mute, { marginTop: 20 }]}>No closed trades yet. {r.fills} fills imported.</Text>
          ) : (
            <>
              <View style={s.cards}>
                <Card s={s} label="Net P&L" value={inr(sum.pnl)} color={pnlColor(sum.pnl)} />
                <Card s={s} label="Trades" value={String(sum.n)} />
                <Card s={s} label="Win rate" value={`${sum.winRate}%`} />
                <Card s={s} label="Profit factor" value={sum.profitFactor == null ? '—' : sum.profitFactor.toFixed(2)} />
                <Card s={s} label="Avg win" value={inr(sum.avgWin)} color={c.up} />
                <Card s={s} label="Avg loss" value={inr(-sum.avgLoss)} color={c.down} />
                <Card s={s} label="Max drawdown" value={inr(-sum.maxDD)} color={c.down} />
              </View>

              <Text style={s.h2}>Equity curve</Text>
              <Equity eq={r.equity} c={c} s={s} />

              <Text style={s.h2}>What the numbers say</Text>
              {r.flags.length ? r.flags.map((f, i) => <Text key={i} style={s.flag}>{f}</Text>)
                : <Text style={s.flag}>Not enough trades for patterns yet.</Text>}

              <Group s={s} title="By entry hour" m={r.byHour} sortByKey pnlColor={pnlColor} />
              <Group s={s} title="By weekday" m={r.byWeekday} pnlColor={pnlColor} />
              <Group s={s} title="By symbol (worst 10)" m={r.bySymbol} limit={10} pnlColor={pnlColor} />

              {r.open.length > 0 && (
                <>
                  <Text style={s.h2}>Still open ({r.open.length}), incl. expired options</Text>
                  <View style={s.table}>
                    {r.open.map((o, i) => (
                      <Row key={i} s={s} cells={[o.symbol, String(o.qty), String(o.price), dt(o.time)]} />
                    ))}
                  </View>
                </>
              )}

              <Text style={s.h2}>Recent round trips</Text>
              <View style={s.table}>
                {r.trips.map((t, i) => (
                  <View key={i} style={s.trip}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.cell} numberOfLines={1}>{t.symbol}</Text>
                      <Text style={s.small}>{t.side} {t.qty} · {t.entry.toFixed(2)} → {t.exit.toFixed(2)} · {dt(t.openedAt)} · {Math.round((t.closedAt - t.openedAt) / 60e3)}m</Text>
                    </View>
                    <Text style={[s.cell, { color: pnlColor(t.pnl), fontWeight: '600' }]}>{inr(t.pnl)}</Text>
                  </View>
                ))}
              </View>
            </>
          )}

          {r.fills > 0 && (
            <Pressable onPress={clearAll} style={{ marginTop: 28, alignSelf: 'center' }}>
              <Text style={{ color: c.down }}>Delete all imported trades</Text>
            </Pressable>
          )}
    </>
  );
}

const Card = ({ s, label, value, color }) => (
  <View style={s.card}>
    <Text style={s.small}>{label}</Text>
    <Text style={[s.cardVal, color && { color }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
  </View>
);

const Row = ({ s, cells, colors = [] }) => (
  <View style={s.row}>
    {cells.map((x, i) => (
      <Text key={i} style={[s.cell, i ? s.num : { flex: 2 }, colors[i] && { color: colors[i] }]} numberOfLines={1}>{x}</Text>
    ))}
  </View>
);

function Group({ s, title, m, sortByKey, limit, pnlColor }) {
  const rows = Object.entries(m)
    .sort(sortByKey ? (a, b) => a[0].localeCompare(b[0]) : (a, b) => a[1].pnl - b[1].pnl)
    .slice(0, limit);
  return (
    <>
      <Text style={s.h2}>{title}</Text>
      <View style={s.table}>
        <Row s={s} cells={['', 'Trades', 'Win %', 'P&L']} />
        {rows.map(([k, g]) => (
          <Row key={k} s={s} cells={[k, String(g.n), String(Math.round((g.wins / g.n) * 100)), inr(g.pnl)]} colors={[, , , pnlColor(g.pnl)]} />
        ))}
      </View>
    </>
  );
}

// Bars from the zero line, downsampled to fit the screen. No chart library needed.
function Equity({ eq, c, s }) {
  if (eq.length < 2) return null;
  const n = Math.min(80, eq.length);
  const pts = Array.from({ length: n }, (_, i) => eq[Math.round((i / (n - 1)) * (eq.length - 1))]);
  const hi = Math.max(0, ...pts), lo = Math.min(0, ...pts), span = hi - lo || 1, H = 130;
  return (
    <View style={[s.chart, { height: H + 16 }]}>
      <View style={{ height: (hi / span) * H, flexDirection: 'row', alignItems: 'flex-end' }}>
        {pts.map((v, i) => <View key={i} style={{ flex: 1, marginHorizontal: 0.5, height: v > 0 ? (v / span) * H : 0, backgroundColor: c.up }} />)}
      </View>
      <View style={{ height: 1, backgroundColor: c.mute }} />
      <View style={{ height: (-lo / span) * H, flexDirection: 'row', alignItems: 'flex-start' }}>
        {pts.map((v, i) => <View key={i} style={{ flex: 1, marginHorizontal: 0.5, height: v < 0 ? (-v / span) * H : 0, backgroundColor: c.down }} />)}
      </View>
    </View>
  );
}

const styles = c => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  page: { padding: 16, paddingBottom: 48 },
  h1: { fontSize: 28, fontFamily: 'serif', fontWeight: '600', color: c.ink, marginTop: 8 },
  h2: { fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: c.mute, marginTop: 26, marginBottom: 8 },
  mute: { color: c.mute, fontSize: 13, lineHeight: 19 },
  small: { color: c.mute, fontSize: 12 },
  btn: { backgroundColor: c.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginVertical: 16 },
  btnText: { color: '#1d1c1a', fontWeight: '700', fontSize: 15 },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: { width: '48.5%', backgroundColor: c.card, borderColor: c.line, borderWidth: 1, borderRadius: 10, padding: 12 },
  cardVal: { fontSize: 20, fontWeight: '600', color: c.ink, marginTop: 2, fontVariant: ['tabular-nums'] },
  chart: { backgroundColor: c.card, borderColor: c.line, borderWidth: 1, borderRadius: 10, padding: 8, justifyContent: 'center' },
  flag: { backgroundColor: c.card, borderColor: c.line, borderWidth: 1, borderLeftColor: c.accent, borderLeftWidth: 3, borderRadius: 8, padding: 12, marginBottom: 8, color: c.ink, lineHeight: 20 },
  table: { backgroundColor: c.card, borderColor: c.line, borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  row: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, borderBottomColor: c.line, borderBottomWidth: StyleSheet.hairlineWidth },
  trip: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 9, borderBottomColor: c.line, borderBottomWidth: StyleSheet.hairlineWidth },
  cell: { color: c.ink, fontSize: 14, fontVariant: ['tabular-nums'] },
  num: { flex: 1, textAlign: 'right' },
  tabs: { flexDirection: 'row', borderBottomColor: c.line, borderBottomWidth: 1, paddingHorizontal: 8 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabText: { color: c.mute, fontWeight: '600', fontSize: 15 },
  input: { backgroundColor: c.card, borderColor: c.line, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, color: c.ink, fontSize: 15, marginTop: 4 },
  smallBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
});

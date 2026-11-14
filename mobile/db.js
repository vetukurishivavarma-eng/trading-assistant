import { openDatabaseSync } from 'expo-sqlite';

export const db = openDatabaseSync('journal.db');
db.execSync(`
CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, ord TEXT, symbol TEXT, side TEXT, qty REAL, price REAL, time INTEGER);
CREATE TABLE IF NOT EXISTS paper (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, setup TEXT, name TEXT,
  signal_date INTEGER, atr REAL, qty INTEGER, plan_close REAL, created INTEGER, status TEXT);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
`);

export const getSetting = (k, dflt) => db.getFirstSync('SELECT v FROM settings WHERE k = ?', k)?.v ?? dflt;
export const setSetting = (k, v) => db.runSync('INSERT OR REPLACE INTO settings VALUES (?, ?)', k, String(v));

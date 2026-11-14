# Trading assistant – progress

## RESUME HERE (paused 2026-11-14 ~21:50)

**Next step:** v1.4.0 code is committed and bundles cleanly but is NOT built or released yet.
Build + release it (see "Release" below), then the phone's in-app updater offers it.
1.4.0 = mini price chart (last 60 closes + entry/stop/target lines) on each signal card, and a
"Ready for real money?" paper-trading checkpoint (needs 20 closed paper trades; `paperReadiness` in scanner.mjs).

**Live now:** v1.3.0 is the latest GitHub release (the phone updates itself from 1.1.1 onwards).

### What it is
- User is a beginner with no broker yet; trades swing style. Self-use first, product later (product must NOT give buy/sell tips: SEBI RA/IA registration).
- `journal.mjs`: tradebook CSV -> round trips (FIFO, long+short) -> stats NET of estimated charges + behaviour flags.
- `scanner.mjs`: Nifty 50 (+ user's own NSE codes) daily candles from Yahoo (free) -> 3 setups (20-day breakout on volume,
  dip in uptrend RSI-2<10, golden cross) -> each judged by that stock's ~10y backtest (next-open entry, 2 ATR stop, 3 ATR target,
  20-day max hold, 0.25% costs) -> verdict + sized plan; scoreboard across stocks; paper trade lifecycle; drops today's
  unfinished candle before 4 pm IST.
- `mobile/` Expo 54 app (com.tradejournal.app): tabs Signals | Journal, imports `../journal.mjs` + `../scanner.mjs`
  (metro watchFolders), expo-sqlite, 4 pm weekday reminder, in-app auto-update (`update.js`), themed dialogs only
  (`dialog.js`, never Alert.alert).
- Web (`server.mjs` + `index.html`, port 4310): Journal only, no Signals yet.

### Release
```
cd mobile   # bump app.json version + versionCode first
JAVA_HOME="C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot" npm run apk   # prebuild + scripts/patch-android.mjs + gradle (~7-20 min)
```
Then copy `mobile/android/app/build/outputs/apk/release/app-release.apk` to `Downloads\trade-journal-X.Y.Z.apk` and create GitHub
release `vX.Y.Z` with that APK attached (API with token from `git credential fill`). Signing key: `~/trade-journal-keystore`
(NOT in repo, back it up; losing it = updates can't install over the app).

### Tests
`npm test` (root) = test.mjs (journal + charges) + test-scanner.mjs. All green at pause.

### Ideas not done
- Expired options: still shown as "open" (would need the underlying's close on expiry to settle ITM correctly).
- Signals on the web page; push notifications when a paper trade hits stop/target (needs a server).
- Broker API (live data + approved orders) once the user picks a broker.

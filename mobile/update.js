// In-app updates: the newest GitHub release of trading-assistant is the latest version.
// Publish a release (tag vX.Y.Z, .apk attached) and every installed copy offers it on next open.
// Installs over the old app only if signed with the same key (~/trade-journal-keystore).
import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';

const LATEST = 'https://api.github.com/repos/vetukurishivavarma-eng/trading-assistant/releases/latest';
const EVERY_MS = 6 * 3600e3;

export function newer(a, b) {
  const pa = a.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++)
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

async function install(url, tag, onProgress) {
  const target = `${FileSystem.cacheDirectory}trade-journal-${tag}.apk`;
  await FileSystem.deleteAsync(target, { idempotent: true });
  const dl = FileSystem.createDownloadResumable(url, target, {}, e =>
    onProgress(e.totalBytesExpectedToWrite ? `Downloading ${tag}… ${Math.round((e.totalBytesWritten / e.totalBytesExpectedToWrite) * 100)}%` : `Downloading ${tag}…`));
  const res = await dl.downloadAsync();
  if (!res || res.status !== 200) throw new Error(`download failed (${res?.status ?? 'cancelled'})`);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: await FileSystem.getContentUriAsync(res.uri), type: 'application/vnd.android.package-archive', flags: 1, // grant read
  });
}

// Checks on launch and when the app returns to the front (at most every 6 hours). Returns a status line or ''.
export function useAutoUpdate() {
  const [status, setStatus] = useState('');
  const last = useRef(0), asking = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const check = async () => {
      if (asking.current || Date.now() - last.current < EVERY_MS) return;
      last.current = Date.now();
      try {
        const res = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok) return;
        const r = await res.json();
        const current = Constants.expoConfig?.version ?? '0';
        const apk = (r.assets || []).find(a => a.name.toLowerCase().endsWith('.apk'));
        if (!apk || !newer(r.tag_name, current)) return;
        asking.current = true;
        Alert.alert(`Update available: ${r.tag_name}`, `You have ${current}.`, [
          { text: 'Later', style: 'cancel', onPress: () => { asking.current = false; } },
          { text: 'Update', onPress: () => install(apk.browser_download_url, r.tag_name, setStatus)
              .catch(e => Alert.alert('Update failed', String(e?.message ?? e)))
              .finally(() => { asking.current = false; setStatus(''); }) },
        ]);
      } catch { /* offline: try next time */ }
    };
    check();
    const sub = AppState.addEventListener('change', st => { if (st === 'active') check(); });
    return () => sub.remove();
  }, []);
  return status;
}

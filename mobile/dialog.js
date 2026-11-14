// Themed dialog replacing Android's stock Alert. Call showDialog() from anywhere; <DialogHost/> renders it.
import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

let push = null;
const queue = [];

// buttons: [{ text, style?: 'cancel' | 'destructive', onPress? }]
export function showDialog(title, message = '', buttons = [{ text: 'OK' }]) {
  queue.push({ title, message, buttons });
  push?.();
}

export function DialogHost({ c }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    push = () => setD(cur => cur || queue.shift() || null);
    push();
    return () => { push = null; };
  }, []);
  const close = btn => { setD(queue.shift() || null); btn?.onPress?.(); };
  if (!d) return null;
  const cancel = d.buttons.find(b => b.style === 'cancel');
  return (
    <Modal transparent animationType="fade" visible statusBarTranslucent onRequestClose={() => close(cancel)}>
      <Pressable onPress={() => cancel && close(cancel)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 }}>
        <Pressable style={{ backgroundColor: c.card, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: c.line }}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: c.accent, marginBottom: 14 }} />
          <Text style={{ color: c.ink, fontSize: 19, fontWeight: '700', fontFamily: 'serif' }}>{d.title}</Text>
          {!!d.message && <Text style={{ color: c.mute, fontSize: 14, lineHeight: 21, marginTop: 8 }}>{d.message}</Text>}
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
            {d.buttons.map((b, i) => {
              const primary = !b.style && i === d.buttons.length - 1;
              const bg = b.style === 'destructive' ? c.down : primary ? c.accent : 'transparent';
              return (
                <Pressable key={i} onPress={() => close(b)}
                  style={({ pressed }) => ({ paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: bg, opacity: pressed ? 0.7 : 1,
                    borderWidth: bg === 'transparent' ? 1 : 0, borderColor: c.line })}>
                  <Text style={{ fontWeight: '700', color: b.style === 'destructive' ? '#fff' : primary ? '#1d1c1a' : c.ink }}>{b.text}</Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

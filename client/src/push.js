// Browser-side Web Push management. Permission is only ever requested from a
// user gesture (the Enable Notifications button), never on page load.
import { api } from './api.js';

export function pushSupport() {
  if (typeof window === 'undefined') return { supported: false, reason: 'Not a browser' };
  if (!window.isSecureContext) return { supported: false, reason: 'Notifications need a secure (HTTPS) connection.' };
  if (!('serviceWorker' in navigator)) return { supported: false, reason: 'This browser does not support service workers.' };
  if (!('PushManager' in window)) {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    return { supported: false, reason: ios ? 'On iPhone/iPad, add TradeOS to your Home Screen (Share → Add to Home Screen), then enable notifications from the installed app (iOS 16.4+).' : 'This browser does not support Web Push.' };
  }
  if (!('Notification' in window)) return { supported: false, reason: 'This browser does not support notifications.' };
  return { supported: true };
}

export function permissionState() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch (e) { console.warn('SW registration failed', e); return null; }
}

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function currentSubscription() {
  if (!pushSupport().supported) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Must be called from a click handler. */
export async function enablePush() {
  const s = pushSupport();
  if (!s.supported) throw new Error(s.reason);
  const perm = await Notification.requestPermission();
  if (perm === 'denied') throw new Error('Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.');
  if (perm !== 'granted') throw new Error('Permission was not granted.');
  const reg = (await navigator.serviceWorker.getRegistration('/')) || (await registerServiceWorker());
  if (!reg) throw new Error('Could not register the service worker.');
  await navigator.serviceWorker.ready;
  const { publicKey } = await api.get('/api/push/vapid-public-key');
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with a different VAPID key cannot be reused.
  if (sub && sub.options?.applicationServerKey) {
    const existing = new Uint8Array(sub.options.applicationServerKey);
    const wanted = urlBase64ToUint8Array(publicKey);
    if (existing.length !== wanted.length || existing.some((b, i) => b !== wanted[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    } catch (e) {
      throw new Error(`The browser could not create a push subscription (${e.message}). Some browsers block push in private windows or without a push service.`);
    }
  }
  await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
  return sub;
}

export async function disablePushOnThisDevice() {
  const sub = await currentSubscription();
  if (!sub) return;
  try { await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* still unsubscribe locally */ }
  await sub.unsubscribe();
}

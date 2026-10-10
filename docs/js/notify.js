// 通知: 「すぐメモ」のボタンを通知欄に出しておく機能と、原稿を通知欄に留める「クリップ」。
// Android のホーム画面ウィジェット（小窓）は Web アプリでは作れないので、いつでも押せる場所として通知欄を使う。
// 通知は端末ごとの許可が要る。許可を求めるのは、ボタンを押したときだけ。
import * as db from './db.js';

const CLIP_KEY = 'clips';
const MEMO_TAG = 'memo-button';
const clipTag = (id) => `clip:${id}`;
const lastShown = new Map(); // 書くたびに出し直さないための間引き

export const supported = () => 'Notification' in window && 'serviceWorker' in navigator;
export const permission = () => (supported() ? Notification.permission : 'denied');

// 許可を求める（ボタンなど、ユーザーの操作の直後に呼ぶこと）
export async function ensurePermission() {
  if (!supported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

const reg = () => navigator.serviceWorker.getRegistration();
export const getClips = () => db.kvGet(CLIP_KEY, []);
export const setClips = (ids) => db.kvSet(CLIP_KEY, ids);

async function closeTag(tag) {
  const r = await reg();
  if (!r) return;
  for (const n of await r.getNotifications({ tag })) n.close();
}

// 通知に出す本文（記号を外して短く）
function preview(content) {
  const t = content
    .replace(/^#{1,6}[ \t　]+/gm, '')
    .replace(/《《(.+?)》》/g, '$1')
    .replace(/[|｜]([^|｜《\n]+?)《[^》\n]*?》/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return t ? t.slice(0, 400) : '（まだ何も書かれていません）';
}

export async function showClip(doc, { force = false } = {}) {
  const r = await reg();
  if (!r || permission() !== 'granted') return false;
  const now = Date.now();
  if (!force && now - (lastShown.get(doc.id) || 0) < 5000) return false; // 書いている最中に出し直しすぎない
  lastShown.set(doc.id, now);
  await r.showNotification(doc.name, {
    body: preview(doc.content),
    tag: clipTag(doc.id),
    renotify: false,
    silent: true,
    requireInteraction: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: `./?doc=${encodeURIComponent(doc.id)}`, clip: doc.id },
    actions: [{ action: 'open', title: '開く' }, { action: 'memo', title: 'すぐメモ' }],
  });
  return true;
}

export async function hideClip(id) {
  lastShown.delete(id);
  await closeTag(clipTag(id));
}

// 留めている原稿の通知を出し直す（起動したときや、同期で中身が変わったとき）
export async function refreshClips(getDoc) {
  if (permission() !== 'granted') return [];
  const ids = await getClips();
  const alive = [];
  for (const id of ids) {
    const doc = await getDoc(id);
    if (doc && !doc.trashed) { alive.push(id); await showClip(doc, { force: true }); }
    else await hideClip(id);
  }
  if (alive.length !== ids.length) await setClips(alive); // 消された原稿はクリップからも外す
  return alive;
}

export async function showMemoButton() {
  const r = await reg();
  if (!r || permission() !== 'granted') return false;
  await r.showNotification('すぐメモ', {
    body: 'ここを押すと、新しいメモがすぐ開きます',
    tag: MEMO_TAG,
    renotify: false,
    silent: true,
    requireInteraction: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: './?new=memo', keep: true },
    actions: [{ action: 'memo', title: 'メモを書く' }, { action: 'app', title: 'アプリを開く' }],
  });
  return true;
}

export const hideMemoButton = () => closeTag(MEMO_TAG);

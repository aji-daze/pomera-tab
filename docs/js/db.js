// IndexedDB の薄いラッパー。原稿・設定・辞書はすべて端末内に保存する。
const DB_NAME = 'pomera-tab';
const DB_VER = 1;
let dbp = null;

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      const mk = (name, opts) => { if (!db.objectStoreNames.contains(name)) return db.createObjectStore(name, opts); };
      mk('docs', { keyPath: 'id' });            // 原稿
      mk('tombs', { keyPath: 'path' });         // 削除・改名した原稿の同期用の墓標
      const snaps = mk('snaps', { keyPath: 'id', autoIncrement: true }); // 版の履歴
      if (snaps) snaps.createIndex('doc', 'docId');
      mk('kv');                                  // 設定など
      const dict = mk('dict', { keyPath: 'k' }); // オフライン辞書: 見出し語 → 読み・語義・類語
      if (dict) dict.createIndex('r', 'r', { multiEntry: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(name, key) { return wrap((await store(name)).get(key)); }
export async function getAll(name) { return wrap((await store(name)).getAll()); }
export async function put(name, value, key) { return wrap((await store(name, 'readwrite')).put(value, key)); }
export async function del(name, key) { return wrap((await store(name, 'readwrite')).delete(key)); }
export async function clear(name) { return wrap((await store(name, 'readwrite')).clear()); }
export async function count(name) { return wrap((await store(name)).count()); }

export async function getByIndex(name, index, value, limit) {
  return wrap((await store(name)).index(index).getAll(value, limit));
}

// 前方一致でキーだけを取り出す（キーが文字列のストア用）
export async function prefixKeys(name, text, limit = 50) {
  const range = IDBKeyRange.bound(text, text + '￿');
  return wrap((await store(name)).getAllKeys(range, limit));
}

// 読み込みと書き込みを1トランザクションで行う。fn が値を返したときだけ書き込む。
// 編集中の保存と同期が同じ原稿を同時に触っても、古い内容で上書きしないための仕組み。
export async function update(name, key, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    let result;
    const r = s.get(key);
    r.onsuccess = () => {
      if (r.result === undefined) return;
      result = fn(r.result);
      if (result) s.put(result);
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

// まとめて書き込む（辞書の取り込み用）
export async function bulkPut(name, values) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    for (const v of values) s.put(v);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function kvGet(key, fallback = null) {
  const v = await get('kv', key);
  return v === undefined ? fallback : v;
}
export async function kvSet(key, value) { return put('kv', value, key); }

// 端末のストレージ整理で原稿が消されないよう、永続化を要求する
export async function requestPersist() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch { return false; }
  }
  return false;
}

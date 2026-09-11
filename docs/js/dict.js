// 辞書: 端末に取り込んだオフライン辞書 ＋ 自作の用語集（_辞書 フォルダの原稿）＋ Web辞書へのリンク
import * as db from './db.js';

export const GLOSSARY_FOLDER = '_辞書';
const SRC = { W: 'ウィクショナリー', N: 'WordNet' };

export const ONLINE = [
  ['Weblio', (q) => `https://www.weblio.jp/content/${encodeURIComponent(q)}`],
  ['類語', (q) => `https://thesaurus.weblio.jp/content/${encodeURIComponent(q)}`],
  ['コトバンク', (q) => `https://kotobank.jp/search?q=${encodeURIComponent(q)}`],
  ['Wiktionary', (q) => `https://ja.wiktionary.org/wiki/${encodeURIComponent(q)}`],
];

export const dictInfo = () => db.kvGet('dict.info', null);

export async function publishedDict() {
  try {
    const r = await fetch('dict/index.json', { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// gzip の JSON を読む。サーバーが自動で展開して返した場合にも対応する。
async function fetchJson(url, onBytes) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`辞書データを取得できません（${res.status}）`);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes?.(got);
  }
  const blob = new Blob(chunks);
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  const stream = gz ? blob.stream().pipeThrough(new DecompressionStream('gzip')) : blob.stream();
  return JSON.parse(await new Response(stream).text());
}

export async function installDict(onProgress) {
  const index = await publishedDict();
  if (!index) throw new Error('辞書データが公開されていません');
  const total = index.shards.reduce((a, s) => a + s.bytes, 0);
  let base = 0, count = 0;
  await db.clear('dict');
  await db.kvSet('dict.info', null);
  for (const shard of index.shards) {
    const rows = await fetchJson(`dict/${shard.file}`, (n) => onProgress?.('ダウンロード中', base + n, total));
    base += shard.bytes;
    onProgress?.('取り込み中', base, total);
    const values = rows.map(([k, r, e]) => ({ k, r, e }));
    for (let i = 0; i < values.length; i += 4000) await db.bulkPut('dict', values.slice(i, i + 4000));
    count += values.length;
  }
  const info = { version: index.version, sources: index.sources, entries: count, installed: Date.now() };
  await db.kvSet('dict.info', info);
  return info;
}

export async function removeDict() {
  await db.clear('dict');
  await db.kvSet('dict.info', null);
}

const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// 活用形から辞書形の候補を作る（走った→走る、優しかった→優しい、歩きます→歩く、勉強した→勉強）
const RULES = [
  ['かった', ['い']], ['くない', ['い']], ['くて', ['い']], ['ければ', ['い']], ['さ', ['い']], ['く', ['い']], ['そう', ['い', 'る']],
  ['った', ['う', 'つ', 'る']], ['って', ['う', 'つ', 'る']], ['んだ', ['む', 'ぶ', 'ぬ']], ['んで', ['む', 'ぶ', 'ぬ']],
  ['いた', ['く']], ['いて', ['く']], ['いだ', ['ぐ']], ['いで', ['ぐ']],
  ['した', ['す', 'する', '']], ['して', ['す', 'する', '']], ['します', ['す', 'する', '']], ['する', ['']], ['され', ['する', '']], ['させ', ['する', '']],
  ['ている', ['て']], ['ていた', ['て']], ['ています', ['て']], ['てる', ['て']], ['ました', ['ます']], ['ません', ['ます']], ['なかった', ['ない']],
  ['た', ['る']], ['て', ['る']], ['ない', ['る']], ['ます', ['る']], ['られる', ['る']], ['させる', ['る']], ['よう', ['る']], ['れば', ['る']],
];
const U = 'うくぐすつぬぶむる';
const ROWS = [
  ['ない', 'わかがさたなばまら'], ['れる', 'わかがさたなばまら'], ['せる', 'わかがさたなばまら'],
  ['ます', 'いきぎしちにびみり'], ['たい', 'いきぎしちにびみり'],
  ['ば', 'えけげせてねべめれ'], ['る', 'えけげせてねべめれ'], ['う', 'おこごそとのぼもろ'],
];

export function deinflect(word) {
  const seen = new Set([word]);
  const queue = [word];
  const out = [];
  const push = (c) => { if (c && !seen.has(c)) { seen.add(c); out.push(c); queue.push(c); } };
  while (queue.length && out.length < 40) {
    const w = queue.shift();
    for (const [suffix, reps] of RULES) {
      if (w.length > suffix.length && w.endsWith(suffix)) reps.forEach((r) => push(w.slice(0, -suffix.length) + r));
    }
    for (const [suffix, row] of ROWS) {
      if (w.length <= suffix.length + 1 || !w.endsWith(suffix)) continue;
      const stem = w.slice(0, -suffix.length);
      const i = row.indexOf(stem.slice(-1));
      if (i >= 0) push(stem.slice(0, -1) + U[i]);
    }
  }
  return out;
}

// 用語集: _辞書 フォルダ内の「- 語（よみ）: 説明」形式の行を読む
let glossaryCache = { key: '', entries: [] };
async function glossaryEntries() {
  const docs = (await db.getAll('docs')).filter((d) => !d.trashed
    && (d.folder === GLOSSARY_FOLDER || d.folder.startsWith(GLOSSARY_FOLDER + '/')));
  const key = docs.map((d) => `${d.id}:${d.updated}`).join('|');
  if (key === glossaryCache.key) return glossaryCache.entries;
  const entries = [];
  for (const d of docs) {
    for (const raw of d.content.split('\n')) {
      const m = raw.replace(/^[ \t　]*[-*・][ \t　]*/, '').match(/^([^:：#]+?)[ \t　]*[:：][ \t　]*(.*)$/);
      if (!m) continue;
      let word = m[1].trim(), reading = '';
      const r = word.match(/^(.+?)[（(]([^）)]+)[）)]$/);
      if (r) { word = r[1].trim(); reading = r[2].trim(); }
      entries.push({ word, reading, note: m[2].trim(), file: d.name });
    }
  }
  glossaryCache = { key, entries };
  return entries;
}

export async function glossaryWords() {
  return (await glossaryEntries()).map((e) => e.word);
}

export async function lookup(q) {
  const word = q.trim();
  const res = { word, glossary: [], entries: [], near: [] };
  if (!word) return res;

  const hira = toHira(word);
  res.glossary = (await glossaryEntries()).filter((e) =>
    e.word.includes(word) || (e.reading && toHira(e.reading).includes(hira)) || ([...word].length >= 2 && e.note.includes(word))).slice(0, 30);

  const seen = new Set();
  const add = (row) => { if (row && !seen.has(row.k)) { seen.add(row.k); res.entries.push(row); } };
  add(await db.get('dict', word));
  if (/^[ぁ-ゖァ-ヶー]+$/.test(word)) (await db.getByIndex('dict', 'r', hira, 30)).forEach(add);
  if (!res.entries.length) {
    for (const cand of deinflect(word)) {
      const row = await db.get('dict', cand);
      if (row) { res.base = res.base || cand; add(row); }
      if (res.entries.length >= 3) break;
    }
  }

  // 近い見出し（複合語などを拾うため、見つかるまで1字ずつ短くする）
  let chars = [...word];
  const min = Math.min(/^[ぁ-ゖァ-ヶー]/.test(word) ? 2 : 1, chars.length);
  while (chars.length >= min) {
    const keys = (await db.prefixKeys('dict', chars.join(''), 40)).filter((k) => !seen.has(k));
    if (keys.length) { res.near = keys; break; }
    if (res.entries.length) break;
    chars = chars.slice(0, -1);
  }
  return res;
}

export function sourceName(code) { return SRC[code] || code; }

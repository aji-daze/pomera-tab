// 原稿の同期。同期先は2種類:
// ・GitHub の非公開リポジトリ（タブレット・スマホ）。PC 側の pc/pomera_sync.py も同じ規則で動き、Obsidian の保管庫と中身をそろえる。
// ・PC のフォルダを直接（パソコンの Chrome／Edge）。localfs.js
//
// 各原稿は「前回同期したときの内容のハッシュ（baseSha）」を覚えておき、
// 端末側・同期先のどちらが変わったかで処理を決める（3方向比較）。
// 両方が変わっていたら、端末の内容を残したうえで相手の版を「(競合 …)」の別ファイルとして保存する。
import * as db from './db.js';
import { compactStamp } from './text.js';
import * as LocalFS from './localfs.js';

const API = 'https://api.github.com';
const TEXT_FILE = /\.(md|txt)$/i;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function docPath(doc) {
  return (doc.folder ? doc.folder + '/' : '') + doc.name + (doc.ext || '.md');
}

export function splitPath(path) {
  const i = path.lastIndexOf('/');
  const folder = i >= 0 ? path.slice(0, i) : '';
  const file = i >= 0 ? path.slice(i + 1) : path;
  const m = file.match(/^(.*)(\.(?:md|txt))$/i);
  return { folder, name: m ? m[1] : file, ext: m ? m[2].toLowerCase() : '.md' };
}

export function newDoc({ folder = '', name = '無題', ext = '.md', content = '' } = {}) {
  const now = Date.now();
  return { id: crypto.randomUUID(), folder, name, ext, content, created: now, updated: now, baseSha: null, trashed: null, caret: 0 };
}

// git と同じ方式のハッシュ。ダウンロードせずに変更の有無を判定できる。
export async function blobSha(text) {
  const body = enc.encode(text);
  const head = enc.encode(`blob ${body.length}\0`);
  const buf = new Uint8Array(head.length + body.length);
  buf.set(head);
  buf.set(body, head.length);
  const h = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64encode(text) {
  const bytes = enc.encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const rootOf = (cfg) => (cfg.root || '').replace(/^\/+|\/+$/g, '').replace(/(.)$/, '$1/');

export const isFolderMode = (cfg) => cfg?.mode === 'folder';

export function isConfigured(cfg) {
  if (isFolderMode(cfg)) return !!cfg.folderName;
  return !!(cfg && cfg.owner && cfg.repo && cfg.token);
}

async function gh(cfg, method, url, body) {
  let res;
  try {
    res = await fetch(API + url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    const e = new Error('通信できません（オフライン）');
    e.offline = true;
    throw e;
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = { 401: 'トークンが無効か期限切れです', 403: 'トークンに書き込み権限がありません', 404: 'リポジトリが見つかりません（名前・権限を確認）' }[res.status];
    const e = new Error(msg ? `${msg}（${res.status}）` : `GitHub ${res.status}: ${data?.message || res.statusText}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

// GitHub を同期先にするときの読み書き（フォルダ版は localfs.js の backend が同じ形で用意する）
function githubBackend(cfg) {
  const repo = `/repos/${cfg.owner}/${cfg.repo}`;
  return {
    label: 'PC版',
    async tree(state) {
      const root = rootOf(cfg);
      let tree;
      try {
        tree = await gh(cfg, 'GET', `${repo}/git/trees/${encodeURIComponent(cfg.branch || 'main')}?recursive=1`);
      } catch (e) {
        if (e.status !== 409 && e.status !== 404) throw e;
        await gh(cfg, 'GET', repo); // リポジトリ自体が見えなければここで 404
        state.empty = true; // まだファイルが1つもない
        return new Map();
      }
      if (tree.truncated) throw new Error('リポジトリのファイルが多すぎて一覧を取得できません');
      const map = new Map();
      for (const t of tree.tree) {
        if (t.type !== 'blob' || !TEXT_FILE.test(t.path) || !t.path.startsWith(root)) continue;
        const rel = t.path.slice(root.length);
        if (rel.split('/').some((seg) => seg.startsWith('.'))) continue; // .obsidian などは対象外
        map.set(rel, t.sha);
      }
      return map;
    },
    async read(path, sha) {
      const blob = await gh(cfg, 'GET', `${repo}/git/blobs/${sha}`);
      return b64decode(blob.content);
    },
    async write(state, path, content, sha) {
      const body = { message: `${sha ? 'update' : 'add'}: ${path} (tablet)`, content: b64encode(content) };
      if (sha) body.sha = sha;
      if (!state.empty) body.branch = cfg.branch || 'main';
      const res = await gh(cfg, 'PUT', `${repo}/contents/${encPath(rootOf(cfg) + path)}`, body);
      state.empty = false;
      return res.content.sha;
    },
    async remove(path, sha) {
      await gh(cfg, 'DELETE', `${repo}/contents/${encPath(rootOf(cfg) + path)}`, {
        message: `delete: ${path} (tablet)`, sha, branch: cfg.branch || 'main',
      });
    },
  };
}

const setBase = (id, sha) => db.update('docs', id, (d) => { d.baseSha = sha; return d; });

function uniquePath(path, taken) {
  if (!taken.has(path)) return path;
  const { folder, name, ext } = splitPath(path);
  for (let n = 2; ; n++) {
    const p = (folder ? folder + '/' : '') + `${name} (${n})${ext}`;
    if (!taken.has(p)) return p;
  }
}

async function syncAll(cfg, hooks) {
  const be = isFolderMode(cfg) ? await LocalFS.backend(cfg) : githubBackend(cfg);
  const state = { empty: false };
  const stats = { pushed: 0, pulled: 0, deleted: 0, conflicts: [] };
  const remote = await be.tree(state);
  const docs = (await db.getAll('docs')).filter((d) => !d.trashed);
  const byPath = new Map(docs.map((d) => [docPath(d), d]));
  const tombs = new Map((await db.getAll('tombs')).map((t) => [t.path, t]));
  const taken = new Set([...remote.keys(), ...byPath.keys()]);

  // 選んだフォルダやリポジトリを間違えたときに、端末の原稿をまとめてゴミ箱へ送らないための歯止め
  const synced = docs.filter((d) => d.baseSha);
  const vanished = synced.filter((d) => !remote.has(docPath(d))).length;
  if (!hooks.force && vanished >= 10 && vanished > synced.length / 2) {
    const e = new Error(`同期先で、前回まであった原稿の半分以上（${vanished}件）が見つかりません。同期先のフォルダ・リポジトリを確認してください`);
    e.massDelete = true;
    throw e;
  }

  const createFromRemote = async (path, sha) => {
    const text = await be.read(path, sha);
    const d = newDoc({ ...splitPath(path), content: text });
    d.baseSha = sha;
    d.sha = sha;
    d.shaAt = d.updated;
    await db.put('docs', d);
    stats.pulled++;
  };

  const paths = [...new Set([...remote.keys(), ...byPath.keys(), ...tombs.keys()])];
  for (const [i, path] of paths.entries()) {
    hooks.onProgress?.(i + 1, paths.length);
    const R = remote.get(path) || null;
    const doc = byPath.get(path);
    const tomb = tombs.get(path);

    if (doc) {
      const content = doc.content;
      // 内容のハッシュは更新日時ごとに覚えておき、変わっていない原稿は計算し直さない
      const L = doc.sha && doc.shaAt === doc.updated ? doc.sha : await blobSha(content);
      if (doc.shaAt !== doc.updated) {
        await db.update('docs', doc.id, (d) => { if (d.updated === doc.updated) { d.sha = L; d.shaAt = d.updated; } return d; });
      }
      let B = doc.baseSha || null;
      if (!B && tomb && tomb.baseSha === R) B = R; // 削除したのと同じ名前で作り直した
      if (tomb) await db.del('tombs', path);

      if (R && L === R) {
        if (doc.baseSha !== R) await setBase(doc.id, R);
      } else if (R && B === R) {
        await setBase(doc.id, await be.write(state, path, content, R));
        stats.pushed++;
      } else if (R && B === L) {
        const text = await be.read(path, R);
        // 同期中に書き足されていたら取り込まない（次回の同期で競合として扱う）
        const applied = await db.update('docs', doc.id, (d) => {
          if (d.content !== content) return;
          d.content = text; d.baseSha = R; d.updated = Date.now(); d.sha = R; d.shaAt = d.updated;
          return d;
        });
        if (applied) { stats.pulled++; hooks.onPulled?.(doc.id, content, text); }
      } else if (R) {
        // 両方で変更あり: 相手の版を別名で残し、端末の版を正とする
        const text = await be.read(path, R);
        const { folder, name, ext } = splitPath(path);
        const cPath = uniquePath((folder ? folder + '/' : '') + `${name} (競合 ${be.label} ${compactStamp()})${ext}`, taken);
        taken.add(cPath);
        const copy = newDoc({ ...splitPath(cPath), content: text });
        copy.baseSha = await be.write(state, cPath, text, null);
        await db.put('docs', copy);
        await setBase(doc.id, await be.write(state, path, content, R));
        stats.conflicts.push(cPath);
      } else if (!B || B !== L) {
        // 同期先に無い: 新規、または相手が消したが端末で書き換えてある
        await setBase(doc.id, await be.write(state, path, content, null));
        stats.pushed++;
      } else {
        // 相手が消していて、端末では変更なし → ゴミ箱へ
        await db.update('docs', doc.id, (d) => { d.trashed = Date.now(); d.baseSha = null; return d; });
        stats.deleted++;
        hooks.onTrashed?.(doc.id);
      }
    } else if (tomb) {
      if (R && R === tomb.baseSha) { await be.remove(path, R); stats.deleted++; }
      else if (R) await createFromRemote(path, R); // 端末で消した後に相手が書き換えた
      await db.del('tombs', path);
    } else if (R) {
      await createFromRemote(path, R);
    }
  }
  await db.kvSet('lastSync', Date.now());
  return stats;
}

let running = null;
export function sync(cfg, hooks = {}) {
  if (!running) running = syncAll(cfg, hooks).finally(() => { running = null; });
  return running;
}
export const isSyncing = () => !!running;

// 同期済みの原稿を消す・改名するときは、旧パスを墓標として残す
export async function leaveTomb(doc) {
  if (doc.baseSha) await db.put('tombs', { path: docPath(doc), baseSha: doc.baseSha });
}

export async function testConnection(cfg) {
  if (isFolderMode(cfg)) return LocalFS.test(cfg);
  const repo = await gh(cfg, 'GET', `/repos/${cfg.owner}/${cfg.repo}`);
  if (!repo.private) return { ok: true, warn: 'このリポジトリは公開（Public）です。原稿が誰でも読める状態になります。' };
  if (repo.permissions && !repo.permissions.push) return { ok: false, warn: 'トークンに書き込み権限（Contents: Read and write）がありません。' };
  return { ok: true };
}

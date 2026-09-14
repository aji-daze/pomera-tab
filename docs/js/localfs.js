// パソコン用の同期先: PC のフォルダ（OneDrive など）を直接読み書きする。
// Chrome／Edge のパソコン版だけが対応している File System Access API を使う。トークンは要らない。
// タブレットへは、PC の同期スクリプト（pc/pomera_sync.py）がこのフォルダを GitHub 経由で届ける。
//
// 同期の規則は GitHub のときと同じ（sync.js の3方向比較）。ハッシュも同じ git blob 方式で計算するので、
// 同期先を GitHub からフォルダへ切り替えても、同じ内容の原稿は「変更なし」と判定される。
import * as db from './db.js';
import { blobSha } from './sync.js';

const TEXT_FILE = /\.(md|txt)$/i;
const MAX_BYTES = 5 * 1024 * 1024;
const TRASH = '.trash'; // Obsidian のゴミ箱と同じ名前。先頭が「.」なので同期の対象外
// pc/config.json の exclude と同じ（どの階層でも、この名前のフォルダは読まない）
export const DEFAULT_EXCLUDE = ['Personal Vault', 'Microsoft Copilot Chat ファイル', 'アプリ', 'Desktop', '画像', '動画', 'music'];

export const supported = () => typeof window.showDirectoryPicker === 'function';
export const getHandle = () => db.kvGet('folderHandle');

export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ id: 'pomera-folder', mode: 'readwrite', startIn: 'documents' });
  const prev = await getHandle();
  if (!prev || !(await prev.isSameEntry(handle))) await db.kvSet('folderMeta', {});
  await db.kvSet('folderHandle', handle);
  return handle;
}

// ブラウザを起動し直すと許可が「確認」に戻ることがある。request はボタンを押したときなど、ユーザー操作の直後だけ
export async function permission(handle, request = false) {
  const opts = { mode: 'readwrite' };
  let p = await handle.queryPermission(opts);
  if (p !== 'granted' && request) p = await handle.requestPermission(opts);
  return p === 'granted';
}

const fatal = new TextDecoder('utf-8', { fatal: true });
async function readText(file) {
  if (file.size > MAX_BYTES) return null;
  try { return fatal.decode(await file.arrayBuffer()); } catch { return null; } // UTF-8 でないファイルは扱わない
}

const notFound = (e) => e.name === 'NotFoundError' || e.name === 'TypeMismatchError';
const splitName = (name) => { const m = name.match(/^(.*?)(\.[^.]*)?$/); return [m[1], m[2] || '']; };

export async function backend(cfg) {
  const root = await getHandle();
  if (!root) throw new Error('同期するフォルダが選ばれていません（⚙ →「同期」で選んでください）');
  if (!(await permission(root))) {
    const e = new Error('フォルダへの接続の許可が必要です');
    e.needPermission = true;
    throw e;
  }
  const exclude = new Set(cfg.exclude?.length ? cfg.exclude : DEFAULT_EXCLUDE);
  let meta = await db.kvGet('folderMeta', {}); // パス → { m: 更新日時, s: 大きさ, sha }（変わっていないファイルは読み直さない）

  const locate = async (path, create = false) => {
    const parts = path.split('/');
    const name = parts.pop();
    let dir = root;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return { dir, name };
  };
  const fileAt = async (path) => {
    try {
      const { dir, name } = await locate(path);
      return await (await dir.getFileHandle(name)).getFile();
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  };
  const shaOf = async (path, file) => {
    const m = meta[path];
    if (m && m.m === file.lastModified && m.s === file.size) return m.sha;
    const text = await readText(file);
    const sha = text === null ? null : await blobSha(text);
    meta[path] = { m: file.lastModified, s: file.size, sha };
    return sha;
  };
  const changedError = (path) => new Error(`「${path}」が同期の途中で書き換えられました。もう一度同期してください`);

  return {
    label: 'ファイル版',
    async tree() {
      const files = [];
      const walk = async (dir, prefix) => {
        for await (const [name, h] of dir.entries()) {
          if (name.startsWith('.')) continue; // .obsidian・.trash など
          if (h.kind === 'directory') {
            if (!exclude.has(name)) await walk(h, `${prefix}${name}/`);
          } else if (TEXT_FILE.test(name)) {
            files.push([prefix + name, h]);
          }
        }
      };
      await walk(root, '');
      const map = new Map();
      const next = {};
      for (const [path, h] of files) {
        const sha = await shaOf(path, await h.getFile());
        next[path] = meta[path];
        if (sha) map.set(path, sha); // 大きすぎる・UTF-8 でないファイルは同期しない
      }
      meta = next;
      await db.kvSet('folderMeta', meta);
      return map;
    },
    async read(path) {
      const file = await fileAt(path);
      const text = file && await readText(file);
      if (text == null) throw changedError(path);
      return text;
    },
    // 前回見た内容（prevSha）のままのときだけ書き込む。null は「まだ無いはず」
    async write(state, path, content, prevSha) {
      const file = await fileAt(path);
      const cur = file ? await shaOf(path, file) : null;
      if (file && cur === null) throw new Error(`「${path}」は UTF-8 でないか大きすぎるため、上書きしません`);
      if ((prevSha || null) !== cur) throw changedError(path);
      const { dir, name } = await locate(path, true);
      const h = await dir.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(content);
      await w.close();
      const saved = await h.getFile();
      const sha = await blobSha(content);
      meta[path] = { m: saved.lastModified, s: saved.size, sha };
      await db.kvSet('folderMeta', meta);
      return sha;
    },
    // 完全には消さず、フォルダ直下の .trash へ移す
    async remove(path, sha) {
      const file = await fileAt(path);
      if (!file) return;
      if ((await shaOf(path, file)) !== sha) throw changedError(path);
      const trash = await root.getDirectoryHandle(TRASH, { create: true });
      const { dir, name } = await locate(path);
      const [stem, ext] = splitName(name);
      let tname = name;
      for (let n = 2; ; n++) {
        try { await trash.getFileHandle(tname); } catch (e) { if (notFound(e)) break; throw e; }
        tname = `${stem} (${n})${ext}`;
      }
      const th = await trash.getFileHandle(tname, { create: true });
      const w = await th.createWritable();
      await w.write(await file.arrayBuffer());
      await w.close();
      await dir.removeEntry(name);
      delete meta[path];
      await db.kvSet('folderMeta', meta);
    },
  };
}

// 接続テスト（ボタンから呼ぶので、許可の確認もここで出す）
export async function test(cfg) {
  const root = await getHandle();
  if (!root) return { ok: false, warn: 'フォルダが選ばれていません。' };
  if (!(await permission(root, true))) return { ok: false, warn: 'フォルダへの書き込みが許可されませんでした。' };
  const be = await backend(cfg);
  const n = (await be.tree()).size;
  let hasObsidian = false;
  try { await root.getDirectoryHandle('Obsidian'); hasObsidian = true; } catch { /* 無い */ }
  const info = `「${root.name}」を読み書きできます（.md・.txt ${n}件）。`;
  if (!hasObsidian) {
    return { ok: true, warn: `${info}ただし中に「Obsidian」フォルダがありません。タブレットとそろえるには、OneDrive フォルダそのもの（pc/config.json の local と同じ場所）を選んでください。` };
  }
  return { ok: true, info };
}

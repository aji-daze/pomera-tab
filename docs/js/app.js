// ポメラタブ本体: 編集・ファイル管理・アウトライン・辞書・検索・設定・同期の画面
import * as db from './db.js';
import * as T from './text.js';
import * as Sync from './sync.js';
import * as Dict from './dict.js';
import * as Proof from './proof.js';
import { createDictView } from './dictview.js';
import * as QR from './qr.js';
import * as Print from './print.js';
import * as Speech from './speech.js';

const VERSION = '1.0.0';
const $ = (s, root = document) => root.querySelector(s);
const editor = $('#editor');
const preview = $('#preview');
const panel = $('#panel');
const proofLayer = $('#proofLayer');

const DEFAULTS = {
  theme: 'paper', font: 'mincho', fontSize: 20, lineHeight: 1.8, cols: 0, vertical: false,
  genkoCols: 20, genkoRows: 20, chapters: true, autoIndent: true, tabFullwidth: true,
  typewriter: false, wakeLock: true, focusStatus: true, autoSyncMin: 5, fileSort: 'name',
  proofCats: { ...Proof.DEFAULT_CATS }, proofDialogue: true, proofMaxLen: 120,
  memoFolder: 'Obsidian/ポメラ/メモ', driveName: 'OneDrive',
  dvVertical: true, dvCols: 0, dvFont: 15, // dvCols 0 = 段数を画面の大きさに合わせる
  penName: '', pdfFormat: 'a4_40x30', pdfNombre: 'center', pdfChapterBreak: true, pdfRuby: true, pdfCover: true,
  readRate: 1, readVoice: '', qrBytes: 600,
};
const OPEN_BRACKETS = '「『（(〈《【［〔“‘';
const WEBFONTS = {
  shippori: 'https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@400;600&display=swap',
  bizud: 'https://fonts.googleapis.com/css2?family=BIZ+UDPGothic&display=swap',
};

const S = {
  settings: { ...DEFAULTS },
  sync: { owner: '', repo: '', branch: 'main', root: '', token: '' },
  doc: null,
  savedContent: '',
  saveTimer: 0,
  saveCount: 0,
  statsTimer: 0,
  stats: null,
  panel: null,
  focus: false,
  preview: false,
  composing: false,
  applying: false,
  unsynced: false,
  lastSyncTry: 0,
  syncState: 'none',
  today: null,
  openChars: 0,
  indentStyle: false,
  autoIndentAt: -1,
  snapAt: 0,
  firstEdit: true,
  lastInput: Date.now(),
  wakeLock: null,
  fileFilter: '',
  fileDir: '',
  showTrash: false,
  dictRange: [0, 0],
  dictPick: null,
  find: { q: '', r: '', regex: false },
  proof: false,
  proofIssues: [],
  proofTimer: 0,
  proofIgnoreGlobal: new Set(),
};

const dictView = createDictView({
  h,
  toast,
  settings: () => S.settings,
  saveSettings: () => saveSettings(),
  insert: (text) => insertText(text),
  menu: (title, items) => menu(title, items),
  exportVocab: (items) => exportVocab(items),
  onClose: () => { if (!S.panel) editor.focus({ preventScroll: true }); },
});

const reader = Speech.createReader({
  onSentence: (item, i, n) => showReadSentence(item, i, n),
  onState: (state) => readStateChanged(state),
});

// ---------------------------------------------------------------- 小道具

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (typeof v !== 'string' && k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : String(kid));
  }
  return el;
}

let toastTimer = 0;
function toast(msg, ms = 2600, action) {
  const el = $('#toast');
  el.replaceChildren(h('span', {}, msg));
  if (action) el.append(h('button', { onclick: () => { el.hidden = true; action[1](); } }, action[0]));
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function dialog(build) {
  const dlg = $('#dialog');
  return new Promise((resolve) => {
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      dlg.close();
      resolve(value);
      if (!S.panel && !dictView.isOpen()) setTimeout(() => editor.focus(), 0);
    };
    dlg.replaceChildren();
    dlg.className = '';
    dlg.onkeydown = null;
    dlg.oncancel = (e) => { e.preventDefault(); close(null); };
    build(dlg, close);
    dlg.showModal();
  });
}

function form(title, fields, okLabel = 'OK') {
  return dialog((dlg, close) => {
    const inputs = {};
    const body = fields.map((f) => {
      const id = `f-${f.key}`;
      const listId = f.list ? `${id}-list` : null;
      const input = h('input', { type: 'text', id, value: f.value ?? '', placeholder: f.placeholder || '', list: listId, inputmode: f.inputmode });
      inputs[f.key] = input;
      return [h('label', { for: id }, f.label), input, f.list ? h('datalist', { id: listId }, f.list.map((v) => h('option', { value: v }))) : null];
    });
    dlg.append(h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        close(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()])));
      },
    },
    h('h3', {}, title), body,
    h('div', { class: 'row end' },
      h('button', { type: 'button', onclick: () => close(null) }, 'キャンセル'),
      h('button', { type: 'submit', class: 'primary' }, okLabel))));
    setTimeout(() => { const first = Object.values(inputs)[0]; first.focus(); first.select(); }, 30);
  });
}

function confirmBox(message, okLabel = 'OK', danger = false) {
  return dialog((dlg, close) => {
    const ok = h('button', { class: danger ? 'primary danger' : 'primary', onclick: () => close(true) }, okLabel);
    dlg.append(h('h3', {}, message), h('div', { class: 'row end' }, h('button', { onclick: () => close(false) }, 'キャンセル'), ok));
    setTimeout(() => ok.focus(), 30);
  });
}

function menu(title, items) {
  return dialog((dlg, close) => {
    const buttons = items.filter(Boolean).map(([label, value, cls]) => h('button', { class: cls, onclick: () => close(value) }, label));
    dlg.append(h('h3', {}, title), h('div', { class: 'menu' }, buttons), h('div', { class: 'row end' }, h('button', { onclick: () => close(null) }, '閉じる')));
    setTimeout(() => buttons[0]?.focus(), 30);
  });
}

const fmt = (n) => n.toLocaleString('ja-JP');
const signed = (n) => (n >= 0 ? '+' : '−') + fmt(Math.abs(n));
const quickChars = (s) => s.replace(/\n/g, '').length;
const hhmm = (t) => { const d = new Date(t); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

function relTime(t) {
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return 'たった今';
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return hhmm(t);
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

// ---------------------------------------------------------------- 本文の書き換え（元に戻す履歴を残す）

function replaceRange(start, end, text) {
  S.applying = true;
  editor.focus();
  editor.setSelectionRange(start, end);
  const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
  if (!ok) {
    editor.setRangeText(text, start, end, 'end');
  }
  S.applying = false;
  onEdited();
}

function insertText(text) {
  replaceRange(editor.selectionStart, editor.selectionEnd, text);
}

// 変わった部分だけを差し替える（全置換・節の移動・同期での取り込み）
function applyText(next, caret) {
  const old = editor.value;
  if (old === next) return;
  const max = Math.min(old.length, next.length);
  let s = 0;
  while (s < max && old.charCodeAt(s) === next.charCodeAt(s)) s++;
  if (s > 0 && /[\uD800-\uDBFF]/.test(old[s - 1])) s--;
  let e = 0;
  while (e < max - s && old.charCodeAt(old.length - 1 - e) === next.charCodeAt(next.length - 1 - e)) e++;
  if (e > 0 && /[\uDC00-\uDFFF]/.test(old[old.length - e])) e--;
  const scroll = [editor.scrollTop, editor.scrollLeft];
  replaceRange(s, old.length - e, next.slice(s, next.length - e));
  [editor.scrollTop, editor.scrollLeft] = scroll;
  if (caret != null) editor.setSelectionRange(caret, caret);
}

// ---------------------------------------------------------------- カーソル位置へのスクロール

const mirror = h('div', { class: 'mirror', 'aria-hidden': 'true' });
document.body.append(mirror);
const MIRROR_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'textIndent', 'whiteSpace',
  'wordBreak', 'overflowWrap', 'lineBreak', 'writingMode', 'textOrientation', 'tabSize',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];

function scrollToCaret(pos = editor.selectionStart, ratio = 0.35) {
  const cs = getComputedStyle(editor);
  for (const p of MIRROR_PROPS) mirror.style[p] = cs[p];
  mirror.style.boxSizing = 'border-box';
  const vertical = cs.writingMode.startsWith('vertical');
  if (vertical) { mirror.style.width = 'auto'; mirror.style.height = `${editor.clientHeight}px`; }
  else { mirror.style.height = 'auto'; mirror.style.width = `${editor.clientWidth}px`; }
  mirror.textContent = editor.value.slice(0, pos);
  const mark = h('span', {}, '｜');
  mirror.append(mark);
  if (vertical) {
    const fromRight = mirror.offsetWidth - mark.offsetLeft - mark.offsetWidth;
    return { vertical, at: fromRight, apply: () => { editor.scrollLeft = -(fromRight - editor.clientWidth * ratio); } };
  }
  return { vertical, at: mark.offsetTop, apply: () => { editor.scrollTop = mark.offsetTop - editor.clientHeight * ratio; } };
}

function revealCaret(pos, ratio) {
  scrollToCaret(pos, ratio).apply();
  mirror.textContent = '';
}

let typewriterFrame = 0;
function typewriter() {
  if (!S.settings.typewriter || typewriterFrame) return;
  typewriterFrame = requestAnimationFrame(() => {
    typewriterFrame = 0;
    const c = scrollToCaret(editor.selectionEnd, 0.45);
    const visible = c.vertical ? c.at + editor.scrollLeft : c.at - editor.scrollTop;
    const size = c.vertical ? editor.clientWidth : editor.clientHeight;
    if (visible > size * 0.55) c.apply();
    mirror.textContent = '';
  });
}

// ---------------------------------------------------------------- 設定と表示

async function loadSettings() {
  S.settings = { ...DEFAULTS, ...(await db.kvGet('settings', {})) };
  S.sync = { ...S.sync, ...(await db.kvGet('sync', {})) };
}
const saveSettings = () => db.kvSet('settings', S.settings);

const isVertical = () => (S.doc && typeof S.doc.vertical === 'boolean' ? S.doc.vertical : S.settings.vertical);

function applyView() {
  const st = S.settings;
  const root = document.documentElement;
  root.dataset.theme = st.theme;
  root.dataset.font = st.font;
  root.style.setProperty('--fs', `${st.fontSize}px`);
  root.style.setProperty('--lh', st.lineHeight);
  root.style.setProperty('--cols', st.cols || 0);
  const b = document.body.classList;
  b.toggle('vertical', isVertical());
  b.toggle('fixed-cols', !!st.cols);
  b.toggle('typewriter', !!st.typewriter);
  b.toggle('focus', S.focus);
  b.toggle('focus-status', S.focus && st.focusStatus);
  $('#btnVertical').textContent = isVertical() ? '横' : '縦';
  $('#btnPreview').textContent = S.preview ? '編集' : '表示';
  if (WEBFONTS[st.font] && !document.getElementById(`wf-${st.font}`)) {
    document.head.append(h('link', { id: `wf-${st.font}`, rel: 'stylesheet', href: WEBFONTS[st.font] }));
  }
  if (S.preview) renderPreview();
  proofLayer.hidden = !S.proof || S.preview;
  $('#btnProof').classList.toggle('active', S.proof);
  if (S.proof && !S.preview) renderProofLayer();
}

function updateTitle() {
  const t = $('#docTitle');
  t.replaceChildren();
  if (!S.doc) return;
  if (S.doc.folder) t.append(h('small', {}, S.doc.folder));
  t.append(S.doc.name + (S.doc.ext === '.txt' ? '.txt' : ''));
  document.title = `${S.doc.name} - ポメラタブ`;
}

// ---------------------------------------------------------------- 文字数・本日の執筆量

async function loadToday() {
  const t = await db.kvGet('today', null);
  S.today = t && t.date === T.todayKey() ? t : { date: T.todayKey(), base: {}, cur: {}, added: 0, minutes: 0 };
}

function trackToday(chars) {
  if (S.today.date !== T.todayKey()) S.today = { date: T.todayKey(), base: {}, cur: {}, added: 0, minutes: 0 };
  const id = S.doc.id;
  if (!(id in S.today.base)) S.today.base[id] = S.openChars;
  // 執筆記録: 書き足した分（消した分は差し引かない）と、手を動かした分数
  const prev = S.today.cur[id] ?? S.today.base[id];
  if (chars > prev) S.today.added = (S.today.added || 0) + (chars - prev);
  S.today.cur[id] = chars;
  const minute = Math.floor(Date.now() / 60000);
  if (S.today.lastMinute !== minute) {
    S.today.lastMinute = minute;
    S.today.minutes = (S.today.minutes || 0) + 1;
  }
}

const todayTotal = () => Object.keys(S.today.base).reduce((a, id) => a + ((S.today.cur[id] ?? S.today.base[id]) - S.today.base[id]), 0);

function updateStats(fromInput = false) {
  if (!S.doc) return;
  const text = editor.value;
  S.stats = T.stats(text, S.settings.genkoCols, S.settings.genkoRows);
  if (fromInput) trackToday(S.stats.chars);
  $('#stPages').textContent = `原稿用紙 ${fmt(S.stats.pages)}枚`;
  $('#stPages').title = `${S.settings.genkoCols}字×${S.settings.genkoRows}行換算 ${fmt(S.stats.lines)}行／空白を除く ${fmt(S.stats.noSpace)}字`;
  $('#stToday').textContent = `本日 ${signed(todayTotal())}字`;
  const goal = S.doc.goal || 0;
  $('#stGoal').textContent = goal ? `目標 ${Math.floor((S.stats.chars / goal) * 100)}%` : '';
  $('#goalBar').style.width = goal ? `${Math.min(100, (S.stats.chars / goal) * 100)}%` : '0';
  updateSelection();
  if (S.panel === 'outline') renderOutline();
}

function updateSelection() {
  if (!S.stats) return;
  const [a, b] = [editor.selectionStart, editor.selectionEnd];
  const all = `${fmt(S.stats.chars)}字`;
  $('#stChars').textContent = a !== b ? `選択 ${fmt(T.stats(editor.value.slice(a, b)).chars)}字／${all}` : all;
}

function setSaveState(saved) {
  const el = $('#stSave');
  el.textContent = saved ? '保存済' : '入力中';
  el.classList.toggle('dirty', !saved);
}

// ---------------------------------------------------------------- 保存・版の履歴

function onEdited() {
  if (S.applying || !S.doc) return;
  S.lastInput = Date.now();
  keepAwake();
  setSaveState(false);
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveNow, 400);
  clearTimeout(S.statsTimer);
  S.statsTimer = setTimeout(() => updateStats(true), editor.value.length > 50000 ? 600 : 200);
  typewriter();
  if (S.proof) {
    proofLayer.classList.add('dim'); // 入力中は波線の位置がずれるので隠し、手が止まったら検査し直す
    clearTimeout(S.proofTimer);
    S.proofTimer = setTimeout(runProof, 800);
  }
}

async function saveNow() {
  clearTimeout(S.saveTimer);
  S.saveTimer = 0;
  if (!S.doc) return;
  const doc = S.doc;
  const content = editor.value;
  const caret = editor.selectionStart;
  const changed = content !== S.savedContent;
  if (!changed && caret === doc.caret) { setSaveState(true); return; }
  if (changed && S.firstEdit) {
    S.firstEdit = false;
    await takeSnapshot(doc.id, S.savedContent); // 開いたときの内容を残しておく
  }
  doc.content = content;
  doc.caret = caret;
  S.savedContent = content;
  await db.update('docs', doc.id, (d) => {
    if (changed) { d.content = content; d.updated = Date.now(); }
    d.caret = caret;
    return d;
  });
  if (changed) {
    S.saveCount++;
    S.unsynced = true;
    setSyncState(S.syncState === 'running' ? 'running' : 'pending');
    db.kvSet('today', S.today);
    recordLog();
    if (Date.now() - S.snapAt > 10 * 60 * 1000) takeSnapshot(doc.id, content);
  }
  setSaveState(true);
}

async function takeSnapshot(docId, content) {
  if (content == null) return;
  const sha = await Sync.blobSha(content);
  const d = await db.get('docs', docId);
  if (!d || d.snapSha === sha) return;
  S.snapAt = Date.now();
  await db.put('snaps', { docId, time: Date.now(), content, sha });
  await db.update('docs', docId, (x) => { x.snapSha = sha; return x; });
  const snaps = (await db.getByIndex('snaps', 'doc', docId)).sort((a, b) => b.time - a.time);
  for (const old of snaps.slice(60)) await db.del('snaps', old.id);
}

// ---------------------------------------------------------------- 原稿の管理

async function activeDocs() {
  return (await db.getAll('docs')).filter((d) => !d.trashed);
}

async function uniqueName(folder, name, ext, exceptId) {
  const same = (await activeDocs()).filter((d) => d.id !== exceptId && d.folder === folder && d.ext === ext)
    .map((d) => d.name.toLowerCase());
  if (!same.includes(name.toLowerCase())) return name;
  for (let n = 2; ; n++) if (!same.includes(`${name} (${n})`.toLowerCase())) return `${name} (${n})`;
}

async function openDoc(id, { focus = true } = {}) {
  if (!$('#readBar').hidden) stopReading();
  if (S.doc) {
    await saveNow();
    if (S.doc.id !== id) takeSnapshot(S.doc.id, editor.value);
  }
  const d = await db.get('docs', id);
  if (!d || d.trashed) return false;
  S.doc = d;
  S.savedContent = d.content;
  S.firstEdit = true;
  S.snapAt = Date.now();
  S.indentStyle = /^　/m.test(d.content);
  S.autoIndentAt = -1;
  S.applying = true;
  editor.value = d.content;
  S.applying = false;
  const caret = Math.min(d.caret ?? d.content.length, d.content.length);
  editor.setSelectionRange(caret, caret);
  S.stats = T.stats(d.content, S.settings.genkoCols, S.settings.genkoRows);
  S.openChars = S.today.base[d.id] != null ? (S.today.cur[d.id] ?? S.stats.chars) : S.stats.chars;
  if (S.today.base[d.id] != null) S.openChars = S.today.base[d.id];
  applyView();
  updateTitle();
  updateStats();
  setSaveState(true);
  if (S.proof) runProof();
  await db.kvSet('lastDocId', id);
  if (focus && !S.panel) editor.focus({ preventScroll: true });
  requestAnimationFrame(() => revealCaret(caret, 0.35));
  return true;
}

async function createDoc({ folder = '', name = '無題', content = '', open = true, caret = content.length } = {}) {
  folder = T.safeFolder(folder);
  name = await uniqueName(folder, T.safeName(name), '.md');
  const d = Sync.newDoc({ folder, name, content });
  d.caret = caret;
  await db.put('docs', d);
  S.unsynced = true;
  if (open) await openDoc(d.id);
  return d;
}

async function folderList() {
  return [...new Set((await activeDocs()).map((d) => d.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
}

async function newDocDialog() {
  const r = await form('新しい原稿', [
    { key: 'name', label: '名前', value: '' , placeholder: '例：第一章' },
    { key: 'folder', label: 'フォルダ（「/」で階層。例：Obsidian/pvo）', value: S.panel === 'files' ? S.fileDir : (S.doc?.folder || ''), list: await folderList() },
  ], '作成');
  if (!r) return;
  closePanel();
  await createDoc({ folder: r.folder, name: r.name || T.dateStamp(new Date(), false) });
}

// 辞書の単語帳を、すぐメモの保存先と同じ階層の「単語帳」原稿に書き出す（Obsidian にも同期される）
async function exportVocab(items) {
  const folder = T.safeFolder(S.settings.memoFolder.split('/').slice(0, -1).join('/')) || 'ポメラ';
  const lines = items.map((v) => `- ${v.h ? `${v.h.split('・')[0]}（${v.y}）` : v.y}${v.p ? `〘${v.p}〙` : ''}: ${v.d}${v.known ? '　✓覚えた' : ''}`);
  const content = `# 単語帳\n\n${lines.join('\n')}\n`;
  const existing = (await activeDocs()).find((d) => d.folder === folder && d.name === '単語帳');
  if (!existing) {
    await createDoc({ folder, name: '単語帳', content, open: false });
  } else if (S.doc?.id === existing.id) {
    applyText(content, 0);
    await saveNow();
  } else {
    await db.update('docs', existing.id, (d) => { d.content = content; d.updated = Date.now(); return d; });
  }
  S.unsynced = true;
  setSyncState('pending');
  toast(`「${folder}/単語帳」に${items.length}語を書き出しました`, 3000);
}

async function quickMemo(text = '') {
  await createDoc({ folder: S.settings.memoFolder, name: T.compactStamp(), content: text });
}

async function relocateDoc(id, folder, name) {
  const d = await db.get('docs', id);
  folder = T.safeFolder(folder);
  name = await uniqueName(folder, T.safeName(name), d.ext, id);
  if (folder === d.folder && name === d.name) return;
  await Sync.leaveTomb(d);
  const next = await db.update('docs', id, (x) => { x.folder = folder; x.name = name; x.baseSha = null; return x; });
  if (S.doc?.id === id) { S.doc.folder = next.folder; S.doc.name = next.name; updateTitle(); }
  S.unsynced = true;
  setSyncState('pending');
}

async function renameDialog(id) {
  if (S.doc?.id === id) await saveNow();
  const d = await db.get('docs', id);
  const r = await form('名前とフォルダ', [
    { key: 'name', label: '名前', value: d.name },
    { key: 'folder', label: 'フォルダ', value: d.folder, list: await folderList() },
  ], '変更');
  if (r) await relocateDoc(id, r.folder, r.name || d.name);
  if (S.panel === 'files') renderFiles();
}

async function trashDoc(id) {
  if (S.doc?.id === id) await saveNow();
  const d = await db.get('docs', id);
  await Sync.leaveTomb(d);
  await db.update('docs', id, (x) => { x.trashed = Date.now(); x.baseSha = null; return x; });
  S.unsynced = true;
  toast(`「${d.name}」をゴミ箱に移しました`, 4000, ['元に戻す', () => restoreDoc(id)]);
  if (S.doc?.id === id) await openFallback();
}

async function restoreDoc(id) {
  const d = await db.get('docs', id);
  const name = await uniqueName(d.folder, d.name, d.ext, id);
  await db.update('docs', id, (x) => { x.trashed = null; x.name = name; x.baseSha = null; return x; });
  S.unsynced = true;
  if (S.panel === 'files') renderFiles();
}

async function purgeDoc(id) {
  await db.del('docs', id);
  for (const s of await db.getByIndex('snaps', 'doc', id)) await db.del('snaps', s.id);
}

async function openFallback() {
  const docs = (await activeDocs()).sort((a, b) => b.updated - a.updated);
  S.doc = null;
  if (docs.length) await openDoc(docs[0].id);
  else await createDoc({ name: '無題' });
}

async function duplicateDoc(id) {
  const d = await db.get('docs', id);
  const copy = await createDoc({ folder: d.folder, name: `${d.name} のコピー`, content: d.content, open: false });
  toast(`「${copy.name}」を作りました`);
  if (S.panel === 'files') renderFiles();
}

async function setGoal(id) {
  const d = await db.get('docs', id);
  const r = await form('目標文字数', [{ key: 'goal', label: '字数（0で解除）', value: String(d.goal || ''), inputmode: 'numeric' }], '設定');
  if (!r) return;
  const goal = Math.max(0, parseInt(r.goal.replace(/[^0-9]/g, ''), 10) || 0);
  await db.update('docs', id, (x) => { x.goal = goal; return x; });
  if (S.doc?.id === id) { S.doc.goal = goal; updateStats(); }
}

async function shareDoc(id) {
  if (S.doc?.id === id) await saveNow();
  const d = await db.get('docs', id);
  const filename = `${d.name}${d.ext}`;
  try {
    const file = new File([d.content], filename, { type: 'text/markdown' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: d.name });
    else if (navigator.share) await navigator.share({ title: d.name, text: d.content });
    else downloadBlob(new Blob([d.content], { type: 'text/markdown' }), filename);
  } catch (e) {
    if (e.name !== 'AbortError') toast('共有できませんでした');
  }
}

function downloadBlob(blob, filename) {
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function fileMenu(id) {
  const d = await db.get('docs', id);
  if (d.trashed) {
    const v = await menu(d.name, [['元に戻す', 'restore'], ['完全に削除', 'purge', 'danger']]);
    if (v === 'restore') await restoreDoc(id);
    if (v === 'purge' && await confirmBox(`「${d.name}」を完全に削除しますか？`, '削除', true)) await purgeDoc(id);
    renderFiles();
    return;
  }
  const vertical = typeof d.vertical === 'boolean' ? d.vertical : S.settings.vertical;
  const v = await menu(d.name, [
    ['開く', 'open'],
    ['名前・フォルダを変更', 'rename'],
    ['複製', 'dup'],
    [`目標文字数${d.goal ? `（${fmt(d.goal)}字）` : ''}`, 'goal'],
    [vertical ? 'この原稿は横書きで開く' : 'この原稿は縦書きで開く', 'dir'],
    ['版の履歴', 'history'],
    ['共有・書き出し', 'share'],
    ['PDF（応募原稿）にする', 'pdf'],
    ['QRコードで渡す', 'qr'],
    ['ゴミ箱へ', 'trash', 'danger'],
  ]);
  if (v === 'open') { closePanel(); await openDoc(id); }
  if (v === 'rename') await renameDialog(id);
  if (v === 'dup') await duplicateDoc(id);
  if (v === 'goal') await setGoal(id);
  if (v === 'dir') {
    await db.update('docs', id, (x) => { x.vertical = !vertical; return x; });
    if (S.doc?.id === id) { S.doc.vertical = !vertical; applyView(); }
  }
  if (v === 'history') await openHistory(id);
  if (v === 'share') await shareDoc(id);
  if (v === 'pdf') await openPdfPanel(id);
  if (v === 'qr') await openQr(id);
  if (v === 'trash') { await trashDoc(id); renderFiles(); }
}

// ---------------------------------------------------------------- パネル

function openPanel(name, side = 'right') {
  S.panel = name;
  panel.className = `panel ${side}`;
  panel.hidden = false;
  panel.replaceChildren();
}

function closePanel() {
  if (!S.panel) return;
  S.panel = null;
  S.dictPick = null;
  panel.hidden = true;
  panel.replaceChildren();
  if (!S.preview) editor.focus({ preventScroll: true });
}

function togglePanel(name, open) {
  if (S.panel === name) closePanel();
  else open();
}

function panelHead(title, ...extra) {
  return h('div', { class: 'panel-head' }, h('h2', {}, title), extra, h('button', { onclick: closePanel, title: '閉じる（Esc）' }, '×'));
}

// 一覧の上下キー移動
panel.addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp'].includes(e.key) || e.altKey) return;
  if (e.target.matches('input')) {
    if (e.key === 'ArrowDown') { const first = panel.querySelector('.item, .chip, .match'); if (first) { e.preventDefault(); first.focus(); } }
    return;
  }
  const items = [...panel.querySelectorAll('.item, .match')];
  const i = items.indexOf(e.target.closest('.item, .match'));
  if (i < 0) return;
  e.preventDefault();
  const next = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next) next.focus();
  else if (e.key === 'ArrowUp') panel.querySelector('input')?.focus();
});

// ---- ファイル一覧

async function openFiles() {
  await saveNow();
  openPanel('files', 'left');
  S.showTrash = false;
  S.fileDir = S.doc?.folder || '';
  await renderFiles(true);
}

const joinDir = (a, b) => (a ? `${a}/${b}` : b);
const parentDir = (dir) => dir.split('/').slice(0, -1).join('/');
const enterClick = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.click(); } };

// ドライブ（OneDrive など）のフォルダを1階層ずつたどる一覧。検索中とゴミ箱は全体を一覧にする
async function renderFiles(focusCurrent = false) {
  if (S.panel !== 'files') return;
  const all = await db.getAll('docs');
  const active = all.filter((d) => !d.trashed);
  const trashed = all.filter((d) => d.trashed).sort((a, b) => b.trashed - a.trashed);
  const byName = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true });
  const sorter = S.settings.fileSort === 'updated' ? (a, b) => b.updated - a.updated : byName;

  const search = h('input', {
    type: 'search', placeholder: 'すべてのフォルダから、名前・本文で探す', value: S.fileFilter,
    oninput: (e) => { S.fileFilter = e.target.value; renderList(); },
  });
  const crumbs = h('div', { class: 'crumbs' });
  const list = h('div', {
    class: 'panel-body',
    onkeydown: (e) => {
      if (e.key === 'Backspace' && S.fileDir && !S.fileFilter && !S.showTrash) { e.preventDefault(); goTo(parentDir(S.fileDir)); }
    },
  });
  const sortBtn = h('button', {
    onclick: () => { S.settings.fileSort = S.settings.fileSort === 'name' ? 'updated' : 'name'; saveSettings(); renderFiles(); },
  }, S.settings.fileSort === 'name' ? '名前順' : '更新順');

  const goTo = (dir) => {
    S.fileDir = dir;
    renderList();
    list.querySelector('.item')?.focus();
  };

  const fileItem = (d, showFolder) => h('div', {
    class: `item${S.doc?.id === d.id ? ' current' : ''}`, tabindex: '0',
    onclick: async () => { if (d.trashed) return fileMenu(d.id); closePanel(); await openDoc(d.id); },
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.click(); }
      if (e.key === 'F2') { e.preventDefault(); renameDialog(d.id); }
      if (e.key === 'Delete') { e.preventDefault(); if (!d.trashed) trashDoc(d.id).then(() => renderFiles()); }
      if (e.key === 'ContextMenu' || (e.key === 'Enter' && e.shiftKey)) { e.preventDefault(); fileMenu(d.id); }
    },
  },
  h('div', { class: 'main' },
    h('div', { class: 'name' }, d.name + (d.ext === '.txt' ? '.txt' : '')),
    h('div', { class: 'meta' }, `${showFolder && d.folder ? `📁 ${d.folder}・` : ''}約${fmt(d.content.length)}字・${relTime(d.trashed || d.updated)}${d.baseSha ? '' : '・未同期'}`)),
  h('button', { title: 'メニュー', onclick: (e) => { e.stopPropagation(); fileMenu(d.id); } }, '⋯'));

  const folderItem = (label, dir, count) => h('div', { class: 'item folder-item', tabindex: '0', onclick: () => goTo(dir), onkeydown: enterClick },
    h('div', { class: 'main' }, h('div', { class: 'name' }, label), count != null ? h('div', { class: 'meta' }, `${count}件`) : null));

  const renderList = () => {
    const q = S.fileFilter.trim();
    list.replaceChildren();
    crumbs.replaceChildren();
    if (S.showTrash || q) {
      crumbs.hidden = true;
      const docs = (S.showTrash ? trashed : active.filter((d) => d.name.includes(q) || d.folder.includes(q) || d.content.includes(q)).sort(sorter));
      if (!docs.length) list.append(h('p', { class: 'hint' }, S.showTrash ? 'ゴミ箱は空です。' : '該当する原稿がありません。'));
      docs.slice(0, 300).forEach((d) => list.append(fileItem(d, true)));
      return;
    }
    crumbs.hidden = false;
    const dir = S.fileDir;
    const parts = dir ? dir.split('/') : [];
    crumbs.append(h('button', { class: 'crumb', onclick: () => goTo('') }, `☁ ${S.settings.driveName || 'ドライブ'}`));
    parts.forEach((p, i) => crumbs.append(h('span', { class: 'sep' }, '›'), h('button', { class: 'crumb', onclick: () => goTo(parts.slice(0, i + 1).join('/')) }, p)));

    const sub = new Map();
    const files = [];
    const prefix = dir ? `${dir}/` : '';
    for (const d of active) {
      if (d.folder === dir) files.push(d);
      else if (!dir || d.folder.startsWith(prefix)) {
        const name = d.folder.slice(prefix.length).split('/')[0];
        sub.set(name, (sub.get(name) || 0) + 1);
      }
    }
    if (dir) list.append(folderItem('↑ 上のフォルダへ', parentDir(dir)));
    [...sub.keys()].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true })).forEach((name) => list.append(folderItem(`📁 ${name}`, joinDir(dir, name), sub.get(name))));
    files.sort(sorter).forEach((d) => list.append(fileItem(d, false)));
    if (!sub.size && !files.length) list.append(h('p', { class: 'hint' }, 'このフォルダには、まだ原稿がありません。「＋ 新規」でここに作れます。'));
  };

  panel.replaceChildren(
    panelHead(S.showTrash ? 'ゴミ箱' : 'ファイル'),
    h('div', { class: 'panel-tools' },
      S.showTrash ? null : h('button', { class: 'primary', onclick: newDocDialog }, '＋ 新規'),
      S.showTrash ? null : h('button', {
        onclick: async () => {
          const r = await form('新しいフォルダ', [{ key: 'name', label: `「${S.fileDir || S.settings.driveName}」の中に作るフォルダの名前`, value: '' }], '作成');
          if (r?.name) goTo(joinDir(S.fileDir, T.safeFolder(r.name)));
        },
      }, '＋ フォルダ'),
      S.showTrash ? null : h('button', { onclick: () => openProgress(S.fileDir) }, '進捗'),
      S.showTrash ? null : sortBtn,
      h('button', { onclick: () => { S.showTrash = !S.showTrash; renderFiles(); } }, S.showTrash ? '← ファイルに戻る' : `ゴミ箱（${trashed.length}）`),
      S.showTrash && trashed.length ? h('button', {
        class: 'danger',
        onclick: async () => {
          if (!await confirmBox(`ゴミ箱の${trashed.length}件を完全に削除しますか？`, '空にする', true)) return;
          for (const d of trashed) await purgeDoc(d.id);
          renderFiles();
        },
      }, '空にする') : null,
      search),
    crumbs,
    list);
  renderList();
  if (focusCurrent) {
    const current = list.querySelector('.item.current') || list.querySelector('.item');
    (current || search).focus();
    current?.scrollIntoView({ block: 'center' });
  }
}

// ---- アウトライン

function openOutline() {
  openPanel('outline', 'left');
  renderOutline(true);
}

let outlineFrame = 0;
function renderOutline(focusCurrent = false) {
  if (S.panel !== 'outline') return;
  if (!focusCurrent) {
    if (outlineFrame) return;
    outlineFrame = setTimeout(() => { outlineFrame = 0; renderOutline(true); }, 700);
    return;
  }
  const text = editor.value;
  const items = T.outline(text, S.settings.chapters);
  const caret = editor.selectionStart;
  let cur = -1;
  items.forEach((it, i) => { if (it.start <= caret) cur = i; });
  const focused = document.activeElement?.closest?.('.item')?.dataset.i;
  const body = h('div', { class: 'panel-body' });
  if (!items.length) {
    body.append(h('p', { class: 'hint' }, '「# 見出し」「## 小見出し」の行や、「第一章」「プロローグ」などの章題の行がここに並びます。',
      h('br'), '見出しを選んで Alt+↑／↓ で、その節ごと順番を入れ替えられます。'));
  }
  items.forEach((it, i) => {
    body.append(h('div', {
      class: `item ol${i === cur ? ' current' : ''}`, style: `--lv:${it.level}`, tabindex: '0', 'data-i': String(i),
      onclick: () => jumpTo(it.start),
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); jumpTo(it.start); }
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveSection(i, e.key === 'ArrowUp' ? -1 : 1, true); }
      },
    },
    h('div', { class: 'main' },
      h('div', { class: 'name' }, it.title),
      h('div', { class: 'meta' }, `${fmt(T.stats(text.slice(it.start, it.end)).chars)}字`)),
    h('button', { title: '前へ移動', onclick: (e) => { e.stopPropagation(); moveSection(i, -1, true); } }, '↑'),
    h('button', { title: '後ろへ移動', onclick: (e) => { e.stopPropagation(); moveSection(i, 1, true); } }, '↓')));
  });
  panel.replaceChildren(panelHead('アウトライン'), body);
  const target = focused != null ? body.querySelector(`[data-i="${focused}"]`) : null;
  if (target) target.focus();
  body.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
}

function jumpTo(pos) {
  closePanel();
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(pos, pos);
  revealCaret(pos, 0.15);
  updateSelection();
}

function moveSection(index, dir, fromPanel = false) {
  const items = T.outline(editor.value, S.settings.chapters);
  if (index == null) {
    const caret = editor.selectionStart;
    items.forEach((it, i) => { if (it.start <= caret) index = i; });
    if (index == null) { toast('見出しの中で使ってください'); return; }
  }
  const r = T.moveSection(editor.value, items, index, dir);
  if (!r) { toast('同じ階層にはこれ以上移動できません'); return; }
  const newIndex = T.outline(r.text, S.settings.chapters).findIndex((it) => it.start === r.caret);
  applyText(r.text, r.caret);
  if (fromPanel) {
    renderOutline(true);
    panel.querySelector(`[data-i="${newIndex}"]`)?.focus();
  } else {
    revealCaret(r.caret, 0.15);
  }
}

// ---- 辞書

async function openDict(query) {
  const [a, b] = [editor.selectionStart, editor.selectionEnd];
  S.dictRange = [a, b];
  const q = query ?? (a !== b ? editor.value.slice(a, b).trim().slice(0, 40) : '');
  openPanel('dict');
  const input = h('input', {
    type: 'search', placeholder: '調べる語（ひらがなでも可）', value: q, enterkeyhint: 'search',
    onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runLookup(input.value); } },
  });
  const body = h('div', { class: 'panel-body', id: 'dictBody' });
  const pick = h('div', { class: 'pickbar', id: 'pickbar', hidden: true });
  panel.append(panelHead('辞書'),
    h('div', { class: 'panel-tools' }, input,
      h('button', { onclick: () => { const q = input.value; closePanel(); dictView.open(q); } }, '紙の辞書で開く')),
    body, pick);
  input.focus();
  if (q) runLookup(q);
  else renderDictHome(body);
}

async function renderDictHome(body) {
  const info = await Dict.dictInfo();
  body.replaceChildren(
    h('p', { class: 'hint' }, '本文で語を選んでから Alt+D を押すと、その語を調べます。類語を選ぶと、本文の選択部分と置き換えられます。'),
    info
      ? h('p', { class: 'hint' }, `オフライン辞書：${fmt(info.entries)}語（${info.sources.map((s) => s.name).join('／')}）`)
      : h('p', { class: 'hint' }, 'オフライン辞書がまだ取り込まれていません。', h('button', { onclick: () => { closePanel(); openSettings('dict'); } }, '辞書を取り込む')),
    h('p', { class: 'hint' }, `自作の用語集：「${Dict.GLOSSARY_FOLDER}」フォルダに原稿を作り、「- 語（よみ）: 説明」の形で1行ずつ書くと、ここで引けます。`));
}

async function runLookup(q) {
  const body = $('#dictBody');
  if (!body) return;
  q = q.trim();
  if (!q) return renderDictHome(body);
  S.dictPick = null;
  renderPick();
  const res = await Dict.lookup(q);
  const chip = (word) => h('button', {
    class: 'chip', onclick: (e) => { panel.querySelectorAll('.chip.picked').forEach((c) => c.classList.remove('picked')); e.currentTarget.classList.add('picked'); S.dictPick = word; renderPick(); },
  }, word);

  const out = [];
  if (res.base) out.push(h('p', { class: 'hint' }, `「${q}」を「${res.base}」の形で調べました。`));
  if (res.glossary.length) {
    out.push(h('div', { class: 'folder' }, h('span', {}, '用語集')));
    for (const g of res.glossary) {
      out.push(h('div', { class: 'entry' }, h('h3', {}, chip(g.word), g.reading ? h('small', {}, g.reading) : null), g.note ? h('div', {}, g.note) : null));
    }
  }
  for (const e of res.entries) {
    const readings = e.r?.length ? `【${e.r.join('・')}】` : '';
    out.push(h('div', { class: 'entry' },
      h('h3', {}, e.k, h('small', {}, readings), ' ', chip(e.k)),
      e.e.map(([src, pos, defs, syns, ants]) => h('div', {},
        h('div', {}, h('span', { class: 'badge' }, Dict.sourceName(src)), pos ? h('span', { class: 'badge' }, pos) : null),
        defs?.length ? h('ol', {}, defs.map((d) => h('li', {}, d))) : null,
        syns?.length ? h('div', { class: 'chips' }, h('span', { class: 'hint' }, '類語 '), syns.slice(0, 40).map(chip)) : null,
        ants?.length ? h('div', { class: 'chips' }, h('span', { class: 'hint' }, '対義語 '), ants.map(chip)) : null))));
  }
  if (!res.entries.length && !res.glossary.length) {
    const info = await Dict.dictInfo();
    out.push(h('p', { class: 'hint' }, info ? `「${q}」は見つかりませんでした。` : 'オフライン辞書が未導入です（設定 → 辞書）。'));
  }
  if (res.near.length) {
    out.push(h('div', { class: 'folder' }, h('span', {}, '近い見出し')),
      h('div', { class: 'chips' }, res.near.map((w) => h('button', { class: 'chip', onclick: () => { panel.querySelector('input').value = w; runLookup(w); } }, w))));
  }
  out.push(h('div', { class: 'folder' }, h('span', {}, navigator.onLine ? 'Web辞書' : 'Web辞書（オフライン中は開けません）')),
    h('div', { class: 'links' }, Dict.ONLINE.map(([name, url]) => h('a', { href: url(q), target: '_blank', rel: 'noopener' }, name))));
  body.replaceChildren(...out);
  body.scrollTop = 0;
}

function renderPick() {
  const bar = $('#pickbar');
  if (!bar) return;
  bar.hidden = !S.dictPick;
  if (!S.dictPick) return;
  const [a, b] = S.dictRange;
  bar.replaceChildren(
    h('strong', {}, S.dictPick),
    h('button', { onclick: () => { panel.querySelector('input').value = S.dictPick; runLookup(S.dictPick); } }, '調べる'),
    h('button', {
      class: 'primary',
      onclick: () => {
        const word = S.dictPick;
        replaceRange(a, b, word);
        S.dictRange = [a, a + word.length];
        editor.setSelectionRange(a, a + word.length);
        toast(a !== b ? `「${word}」に置き換えました` : `「${word}」を挿入しました`);
      },
    }, a !== b ? '選択部分と置換' : 'カーソル位置に挿入'));
}

// ---- 検索・置換

function openFind(replace = false) {
  const [a, b] = [editor.selectionStart, editor.selectionEnd];
  if (a !== b && !editor.value.slice(a, b).includes('\n')) S.find.q = editor.value.slice(a, b);
  openPanel('find');
  const q = h('input', { type: 'search', placeholder: '検索', value: S.find.q, enterkeyhint: 'search' });
  const r = h('input', { type: 'text', placeholder: '置換後', value: S.find.r });
  const regex = h('input', { type: 'checkbox', checked: S.find.regex, id: 'findRegex' });
  const count = h('span', { class: 'hint' });
  const body = h('div', { class: 'panel-body' });
  const refresh = () => {
    S.find = { q: q.value, r: r.value, regex: regex.checked };
    renderMatches(body, count);
  };
  q.addEventListener('input', refresh);
  r.addEventListener('input', () => { S.find.r = r.value; });
  regex.addEventListener('change', refresh);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); } });
  r.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); replaceOne(); } });
  panel.append(
    panelHead('検索・置換'),
    h('div', { class: 'panel-tools' }, q, r,
      h('label', { class: 'hint', for: 'findRegex' }, regex, ' 正規表現'), count),
    h('div', { class: 'panel-tools' },
      h('button', { onclick: () => findNext(-1) }, '↑ 前'),
      h('button', { onclick: () => findNext(1) }, '↓ 次'),
      h('button', { onclick: replaceOne }, '置換'),
      h('button', { onclick: replaceAll }, 'すべて置換')),
    body);
  (replace && S.find.q ? r : q).focus();
  refresh();
}

function findPattern() {
  const { q, regex } = S.find;
  if (!q) return null;
  try {
    return new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu');
  } catch {
    return null;
  }
}

function findMatches(limit = 5000) {
  const re = findPattern();
  if (!re) return [];
  const text = editor.value;
  const out = [];
  let m;
  while ((m = re.exec(text)) && out.length < limit) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

function renderMatches(body, count) {
  const ms = findMatches();
  const text = editor.value;
  count.textContent = S.find.q ? (findPattern() ? `${ms.length}件` : '正規表現が不正です') : '';
  body.replaceChildren(...ms.slice(0, 300).map(([s, e]) => {
    const ls = Math.max(text.lastIndexOf('\n', s - 1) + 1, s - 24);
    let le = text.indexOf('\n', e);
    if (le < 0 || le > e + 24) le = Math.min(text.length, e + 24);
    return h('div', { class: 'match', tabindex: '0', onclick: () => selectMatch(s, e, true), onkeydown: (ev) => { if (ev.key === 'Enter') selectMatch(s, e, true); } },
      text.slice(ls, s), h('mark', {}, text.slice(s, e)), text.slice(e, le));
  }));
}

function selectMatch(s, e, close = false) {
  if (close) closePanel();
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(s, e);
  revealCaret(s, 0.35);
  updateSelection();
}

function findNext(dir = 1) {
  const ms = findMatches();
  if (!ms.length) { toast(S.find.q ? '見つかりません' : '検索語を入れてください'); return; }
  const pos = dir > 0 ? editor.selectionEnd : editor.selectionStart;
  let m = dir > 0 ? ms.find(([s]) => s >= pos) : [...ms].reverse().find(([, e]) => e <= pos);
  if (!m) { m = dir > 0 ? ms[0] : ms[ms.length - 1]; toast(dir > 0 ? '先頭に戻りました' : '末尾に戻りました', 1200); }
  selectMatch(m[0], m[1], false);
}

function replacement(matchText) {
  if (!S.find.regex) return S.find.r;
  return matchText.replace(new RegExp(findPattern().source, 'u'), S.find.r);
}

function replaceOne() {
  const [a, b] = [editor.selectionStart, editor.selectionEnd];
  const hit = findMatches().find(([s, e]) => s === a && e === b);
  if (hit) {
    const rep = replacement(editor.value.slice(a, b));
    replaceRange(a, b, rep);
    editor.setSelectionRange(a + rep.length, a + rep.length);
  }
  findNext(1);
}

async function replaceAll() {
  const re = findPattern();
  if (!re) return;
  const n = findMatches().length;
  if (!n) { toast('見つかりません'); return; }
  if (!await confirmBox(`${n}件をすべて置換しますか？`, '置換')) return;
  await saveNow();
  await takeSnapshot(S.doc.id, editor.value);
  const next = editor.value.replace(re, S.find.regex ? S.find.r : () => S.find.r);
  applyText(next, Math.min(editor.selectionStart, next.length));
  toast(`${n}件置換しました（Ctrl+Z で戻せます）`);
  if (S.panel === 'find') openFind();
}

// ---- 校正モード

function proofOptions() {
  return {
    cats: { ...Proof.DEFAULT_CATS, ...S.settings.proofCats },
    excludeDialogue: S.settings.proofDialogue,
    maxLen: S.settings.proofMaxLen,
    ignore: new Set([...S.proofIgnoreGlobal, ...(S.doc?.proofIgnore || [])]),
  };
}

function runProof() {
  clearTimeout(S.proofTimer);
  S.proofTimer = 0;
  if (!S.proof || !S.doc) return;
  S.proofIssues = Proof.check(editor.value, proofOptions());
  renderProofLayer();
  const st = $('#stProof');
  st.hidden = false;
  st.textContent = `校正 ${S.proofIssues.length}件`;
  if (S.panel === 'proof') renderProofPanel();
}

// 本文の真下に同じ体裁の層を置き、指摘の位置に波線を引く
function renderProofLayer() {
  if (!S.proof || S.preview) return;
  const text = editor.value;
  const frag = document.createDocumentFragment();
  let pos = 0;
  S.proofIssues.forEach((is, i) => {
    if (is.start < pos) return;
    frag.append(text.slice(pos, is.start), h('mark', { class: `pf-${is.cat}`, 'data-i': String(i) }, text.slice(is.start, is.end)));
    pos = is.end;
  });
  frag.append(`${text.slice(pos)}\n​`);
  proofLayer.replaceChildren(frag);
  const cs = getComputedStyle(editor);
  Object.assign(proofLayer.style, {
    left: `${editor.offsetLeft}px`, top: `${editor.offsetTop}px`,
    width: `${editor.clientWidth}px`, height: `${editor.clientHeight}px`,
    paddingTop: cs.paddingTop, paddingRight: cs.paddingRight, paddingBottom: cs.paddingBottom, paddingLeft: cs.paddingLeft,
  });
  syncProofScroll();
  proofLayer.classList.remove('dim');
}

function syncProofScroll() {
  if (!S.proof) return;
  proofLayer.scrollTop = editor.scrollTop;
  proofLayer.scrollLeft = editor.scrollLeft;
}

function toggleProof(force) {
  S.proof = force ?? !S.proof;
  if (S.proof) {
    applyView();
    runProof();
    openProofPanel();
  } else {
    S.proofIssues = [];
    proofLayer.replaceChildren();
    $('#stProof').hidden = true;
    if (S.panel === 'proof') closePanel();
    applyView();
  }
}

function openProofPanel() {
  openPanel('proof');
  renderProofPanel(0);
}

function renderProofPanel(focusIndex) {
  if (S.panel !== 'proof') return;
  const focused = document.activeElement?.closest?.('.pf-item')?.dataset.i;
  if (focusIndex == null && focused != null) focusIndex = +focused;
  const text = editor.value;
  const issues = S.proofIssues;
  const cats = { ...Proof.DEFAULT_CATS, ...S.settings.proofCats };
  const counts = {};
  issues.forEach((is) => { counts[is.cat] = (counts[is.cat] || 0) + 1; });

  const chips = h('div', { class: 'chips' }, Proof.CATEGORIES.map(([k, label, desc]) => h('label', { class: `chip pf-chip pf-${k}`, title: desc },
    h('input', {
      type: 'checkbox', checked: !!cats[k],
      onchange: (e) => { S.settings.proofCats = { ...cats, [k]: e.target.checked }; saveSettings(); runProof(); },
    }),
    `${label}${counts[k] ? ` ${counts[k]}` : ''}`)));

  const body = h('div', { class: 'panel-body' });
  if (!issues.length) body.append(h('p', { class: 'hint' }, '指摘はありません。'));
  issues.slice(0, 300).forEach((is, i) => {
    const ls = Math.max(text.lastIndexOf('\n', is.start - 1) + 1, is.start - 14);
    let le = text.indexOf('\n', is.end);
    if (le < 0 || le > is.end + 14) le = Math.min(text.length, is.end + 14);
    const label = Proof.CATEGORIES.find(([k]) => k === is.cat)[1];
    body.append(h('div', {
      class: 'item pf-item', tabindex: '0', 'data-i': String(i),
      onclick: (e) => { if (!e.target.closest('button')) selectIssue(i); },
      onkeydown: (e) => {
        if (e.target.closest('button')) return;
        if (e.key === 'Enter') { e.preventDefault(); if (is.sugg.length) applyIssue(i, is.sugg[0]); else selectIssue(i); }
        if (e.key === 'Delete') { e.preventDefault(); ignoreIssue(i, 'doc'); }
      },
    },
    h('div', { class: 'main' },
      h('div', {}, h('span', { class: `badge pf-${is.cat}` }, label), is.msg),
      h('div', { class: 'pf-context' }, text.slice(ls, is.start), h('mark', { class: `pf-${is.cat}` }, text.slice(is.start, is.end)), text.slice(is.end, le)),
      h('div', { class: 'row pf-actions' },
        is.sugg.map((s) => h('button', { class: 'primary', onclick: () => applyIssue(i, s) }, s === '' ? '削除する' : `→ ${s}`)),
        h('button', { title: 'この原稿では同じ指摘を出さない', onclick: () => ignoreIssue(i, 'doc') }, '無視'),
        h('button', { title: 'すべての原稿で同じ指摘を出さない', onclick: () => ignoreIssue(i, 'all') }, '常に無視')))));
  });
  if (issues.length > 300) body.append(h('p', { class: 'hint' }, `ほか ${issues.length - 300}件`));

  panel.replaceChildren(
    panelHead(`校正（${issues.length}件）`),
    h('div', { class: 'panel-tools' }, chips,
      h('p', { class: 'hint', style: 'margin:0' }, '指摘を選ぶと本文の該当箇所へ移動します。Enter で1つ目の候補に修正、F8 で次の指摘へ。'),
      h('button', { onclick: () => toggleProof(false) }, '校正モードを終わる')),
    body);
  if (focusIndex != null && issues.length) {
    const items = body.querySelectorAll('.pf-item');
    const target = items[Math.min(focusIndex, items.length - 1)];
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  }
}

function selectIssue(i) {
  const is = S.proofIssues[i];
  if (!is) return;
  const [s, e] = is.sel || [is.start, is.end];
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(s, e);
  revealCaret(s, 0.35);
  updateSelection();
  proofLayer.querySelectorAll('mark.current').forEach((m) => m.classList.remove('current'));
  proofLayer.querySelector(`mark[data-i="${i}"]`)?.classList.add('current');
}

function applyIssue(i, suggestion) {
  const is = S.proofIssues[i];
  if (!is || editor.value.slice(is.start, is.end) !== is.text) { runProof(); return; }
  replaceRange(is.start, is.end, suggestion);
  runProof();
  renderProofPanel(i);
}

async function ignoreIssue(i, scope) {
  const is = S.proofIssues[i];
  if (!is) return;
  const key = `${is.rule}|${is.text}`;
  if (scope === 'all') {
    S.proofIgnoreGlobal.add(key);
    await db.kvSet('proofIgnore', [...S.proofIgnoreGlobal]);
  } else {
    S.doc.proofIgnore = [...new Set([...(S.doc.proofIgnore || []), key])];
    await db.update('docs', S.doc.id, (d) => { d.proofIgnore = S.doc.proofIgnore; return d; });
  }
  runProof();
  renderProofPanel(i);
}

function proofNext(dir = 1) {
  if (!S.proof) { S.proof = true; applyView(); }
  runProof();
  const list = S.proofIssues;
  if (!list.length) { toast('指摘はありません'); return; }
  const at = editor.selectionStart;
  let i = dir > 0 ? list.findIndex((is) => is.start > at) : list.map((is) => is.start < at).lastIndexOf(true);
  if (i < 0) i = dir > 0 ? 0 : list.length - 1;
  selectIssue(i);
  const is = list[i];
  toast(`${is.msg}${is.sugg.length ? `（→ ${is.sugg[0] || '削除'}）` : ''}`, 3500);
}

// ---- QRコードで渡す（ポメラの QRコード変換に相当。ネットがなくても使える）

async function openQr(docId = S.doc?.id) {
  if (!docId) return;
  await saveNow();
  const d = await db.get('docs', docId);
  const isCurrent = docId === S.doc?.id;
  const [a, b] = [editor.selectionStart, editor.selectionEnd];
  const useSel = isCurrent && a !== b;
  const text = useSel ? editor.value.slice(a, b) : d.content;
  if (!text.trim()) { toast('本文が空です'); return; }
  const chunks = QR.splitForQr(text, S.settings.qrBytes || 600);
  await dialog((dlg, close) => {
    let idx = 0;
    dlg.className = 'qr-dialog';
    const holder = h('div', { class: 'qr-holder' });
    const count = h('div', { class: 'qr-count' });
    const excerpt = h('p', { class: 'hint qr-excerpt' });
    const prevBtn = h('button', { onclick: () => show(idx - 1) }, '‹ 前');
    const nextBtn = h('button', { onclick: () => show(idx + 1) }, '次 ›');
    function show(i) {
      idx = Math.max(0, Math.min(chunks.length - 1, i));
      const c = chunks[idx];
      try {
        holder.replaceChildren(QR.toSvg(QR.encode(c, { ecl: 'M' })));
      } catch (e) {
        holder.replaceChildren(h('p', {}, `QRコードを作れませんでした：${e.message}`));
      }
      count.textContent = chunks.length > 1 ? `${idx + 1} / ${chunks.length}` : '';
      excerpt.textContent = `${c.slice(0, 40).replace(/\n/g, ' ')}${c.length > 40 ? '…' : ''}（${fmt([...c].length)}字）`;
      prevBtn.disabled = idx === 0;
      nextBtn.disabled = idx === chunks.length - 1;
    }
    dlg.append(
      h('h3', {}, useSel ? 'QRコード：選択した部分' : `QRコード：${d.name}`),
      h('p', { class: 'hint' }, chunks.length > 1
        ? `長いので${chunks.length}枚に分けました。スマホのカメラで1枚ずつ読み取ってください（← → で切り替え）。`
        : 'スマホのカメラで読み取ると、文章をコピーできます。ネットにつながっていなくても使えます。'),
      holder, count, excerpt,
      h('div', { class: 'row end' },
        chunks.length > 1 ? prevBtn : null,
        chunks.length > 1 ? nextBtn : null,
        h('button', { class: 'primary', onclick: () => close(null) }, '閉じる')));
    dlg.onkeydown = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show(idx + (e.key === 'ArrowRight' ? 1 : -1)); }
    };
    show(0);
  });
}

// ---- PDF（応募原稿）

const byFolderAndName = (a, b) => a.folder.localeCompare(b.folder, 'ja', { numeric: true }) || a.name.localeCompare(b.name, 'ja', { numeric: true });

async function openPdfPanel(docId = S.doc?.id) {
  if (!docId) return;
  await saveNow();
  const d = await db.get('docs', docId);
  const st = S.settings;
  const folderDocs = d.folder
    ? (await activeDocs()).filter((x) => x.folder === d.folder || x.folder.startsWith(`${d.folder}/`)).sort(byFolderAndName)
    : [];
  openPanel('pdf');
  let scope = 'doc';
  const title = h('input', { type: 'text', value: d.name });
  const scopeDoc = h('input', { type: 'radio', name: 'pdf-scope', checked: true, onchange: () => { scope = 'doc'; title.value = d.name; } });
  const scopeFolder = h('input', { type: 'radio', name: 'pdf-scope', disabled: !folderDocs.length, onchange: () => { scope = 'folder'; title.value = d.folder.split('/').pop(); } });
  const format = h('select', {}, Object.entries(Print.FORMATS).map(([k, f]) => h('option', { value: k, selected: st.pdfFormat === k }, f.label)));
  const nombre = h('select', {}, [['center', '下の中央（- 1 -）'], ['right', '「1 / 全ページ数」'], ['none', 'なし']]
    .map(([v, l]) => h('option', { value: v, selected: st.pdfNombre === v }, l)));
  const chapterBreak = h('input', { type: 'checkbox', checked: st.pdfChapterBreak !== false });
  const ruby = h('input', { type: 'checkbox', checked: st.pdfRuby !== false });
  const coverOn = h('input', { type: 'checkbox', checked: st.pdfCover !== false });
  const author = h('input', { type: 'text', value: st.penName || '', placeholder: '筆名' });
  const status = h('p', { class: 'hint' });

  const build = async () => {
    Object.assign(st, {
      pdfFormat: format.value, pdfNombre: nombre.value, pdfChapterBreak: chapterBreak.checked,
      pdfRuby: ruby.checked, pdfCover: coverOn.checked, penName: author.value.trim(),
    });
    saveSettings();
    status.textContent = '組版しています…';
    await new Promise((r) => setTimeout(r, 30));
    const docs = scope === 'folder' ? folderDocs : [d];
    const sources = docs.map((x) => ({ title: x.name, text: x.id === S.doc?.id ? editor.value : x.content }));
    const pages = Print.layout(sources, { format: format.value, ruby: ruby.checked, chapterBreak: chapterBreak.checked });
    const total = sources.reduce((acc, s) => { const t = T.stats(s.text); return { chars: acc.chars + t.chars, pages: acc.pages + t.pages }; }, { chars: 0, pages: 0 });
    const cover = coverOn.checked
      ? { title: title.value.trim(), author: author.value.trim(), note: `${fmt(total.chars)}字（400字詰め原稿用紙換算 ${fmt(total.pages)}枚）` }
      : null;
    const root = Print.renderPages(pages, { format: format.value, cover, nombre: nombre.value });
    status.textContent = `本文 ${fmt(pages.length)}ページ${cover ? '＋表紙' : ''}`;
    Print.openPreview(root, { format: format.value, pages: pages.length + (cover ? 1 : 0) });
  };

  panel.append(panelHead('PDF（応募原稿）を作る'), h('div', { class: 'panel-body' },
    h('fieldset', { class: 'set' }, h('legend', {}, '範囲'),
      h('label', { class: 'field check' }, scopeDoc, h('span', {}, `この原稿（${d.name}）`)),
      h('label', { class: 'field check' }, scopeFolder, h('span', {}, folderDocs.length
        ? `フォルダ「${d.folder}」の${folderDocs.length}件をつなげる（名前順）`
        : 'フォルダに入っていない原稿です'))),
    h('fieldset', { class: 'set' }, h('legend', {}, '体裁'),
      h('label', { class: 'field' }, h('span', {}, '形式'), format),
      h('label', { class: 'field' }, h('span', {}, 'ページ番号'), nombre),
      h('label', { class: 'field check' }, chapterBreak, h('span', {}, '原稿（章）ごとに改ページする')),
      h('label', { class: 'field check' }, ruby, h('span', {}, 'ルビ・傍点の記法を反映する（外すと記法のまま印字）'))),
    h('fieldset', { class: 'set' }, h('legend', {}, '表紙'),
      h('label', { class: 'field check' }, coverOn, h('span', {}, '1枚目に題名・筆名・字数と枚数を入れる')),
      h('label', { class: 'field' }, h('span', {}, '題名'), title),
      h('label', { class: 'field' }, h('span', {}, '筆名'), author)),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: build }, 'プレビューしてPDFに保存')),
    status,
    h('p', { class: 'hint' }, '「PDFに保存（印刷）」を押すと端末の印刷画面が開きます。プリンターの代わりに「PDFとして保存」を選んでください。応募要項の用紙・字数・行数と合っているか、プレビューで確かめてから保存してください。')));
}

// ---- 作品の進捗

const statTile = (label, value, sub) => h('div', { class: 'tile' },
  h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), sub ? h('div', { class: 'tile-sub' }, sub) : null);

async function openProgress(folder) {
  await saveNow();
  folder = folder ?? (S.panel === 'files' ? S.fileDir : (S.doc?.folder || ''));
  openPanel('progress');
  const body = h('div', { class: 'panel-body' });
  panel.append(panelHead('作品の進捗'), body);
  if (!folder) {
    const input = h('input', { type: 'text', placeholder: '例：Obsidian/pvo', list: 'progress-folders' });
    body.append(
      h('p', { class: 'hint' }, '作品のフォルダを選んでください。そのフォルダの中（下の階層も含む）の原稿をまとめて数えます。'),
      input,
      h('datalist', { id: 'progress-folders' }, (await folderList()).map((f) => h('option', { value: f }))),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => { if (input.value.trim()) openProgress(T.safeFolder(input.value)); } }, '数える')));
    input.focus();
    return;
  }
  body.append(h('p', { class: 'hint' }, '数えています…'));
  await new Promise((r) => setTimeout(r, 30));
  const docs = (await activeDocs()).filter((x) => x.folder === folder || x.folder.startsWith(`${folder}/`)).sort(byFolderAndName);
  const rows = docs.map((d) => ({ d, s: T.stats(d.id === S.doc?.id ? editor.value : d.content) }));
  const total = rows.reduce((a, r) => ({ chars: a.chars + r.s.chars, noSpace: a.noSpace + r.s.noSpace, pages: a.pages + r.s.pages, lines: a.lines + r.s.lines }), { chars: 0, noSpace: 0, pages: 0, lines: 0 });
  const goals = await db.kvGet('goals', {});
  const goal = goals[folder] || {};

  const goalBox = h('div', { class: 'goal-box' });
  if (goal.pages) {
    const pct = Math.min(100, Math.round((total.pages / goal.pages) * 100));
    const remain = Math.max(0, goal.pages - total.pages);
    let pace = '';
    if (goal.deadline) {
      const days = Math.ceil((new Date(`${goal.deadline}T23:59:59`) - Date.now()) / 86400000);
      pace = days > 0
        ? `締切まで${days}日。1日あたり約${fmt(Math.ceil(remain / days))}枚（約${fmt(Math.ceil((remain * 400) / days))}字）`
        : '締切の日を過ぎています';
    }
    goalBox.append(
      h('div', { class: 'goal-head' }, h('strong', {}, `目標 ${fmt(goal.pages)}枚のうち ${pct}%`), h('span', { class: 'hint' }, remain ? `あと${fmt(remain)}枚` : '目標に届きました')),
      h('div', { class: 'meter', role: 'meter', 'aria-label': '目標枚数に対する進み具合', 'aria-valuemin': '0', 'aria-valuemax': String(goal.pages), 'aria-valuenow': String(total.pages) },
        h('span', { style: `width:${pct}%` })),
      pace ? h('p', { class: 'hint' }, pace) : null);
  }
  const goalPages = h('input', { type: 'number', min: '0', inputmode: 'numeric', value: goal.pages ? String(goal.pages) : '', placeholder: '例：300' });
  const deadline = h('input', { type: 'date', value: goal.deadline || '' });
  const maxPages = Math.max(1, ...rows.map((r) => r.s.pages));

  body.replaceChildren(
    h('p', { class: 'hint' }, `📁 ${folder}（下の階層も含む ${fmt(rows.length)}件）`),
    h('div', { class: 'tiles' },
      statTile('合計の字数', `${fmt(total.chars)}字`, `空白を除く ${fmt(total.noSpace)}字`),
      statTile('原稿用紙（章ごとに改ページ）', `${fmt(total.pages)}枚`, '400字詰め換算'),
      statTile('続けて組んだ場合', `${fmt(Math.ceil(total.lines / 20))}枚`, '改ページなし'),
      statTile('原稿の数', `${fmt(rows.length)}件`)),
    goalBox,
    h('fieldset', { class: 'set' }, h('legend', {}, '目標（応募規定の枚数など）'),
      h('label', { class: 'field' }, h('span', {}, '目標枚数'), goalPages),
      h('label', { class: 'field' }, h('span', {}, '締切'), deadline),
      h('div', { class: 'row' }, h('button', {
        onclick: async () => {
          const g = await db.kvGet('goals', {});
          const pages = parseInt(goalPages.value, 10) || 0;
          if (pages) g[folder] = { pages, deadline: deadline.value || '' };
          else delete g[folder];
          await db.kvSet('goals', g);
          openProgress(folder);
        },
      }, '保存'))),
    h('div', { class: 'folder' }, h('span', {}, '原稿ごと'), h('span', {}, '字数・枚数')),
    ...rows.map((r) => h('div', {
      class: 'prog-row', tabindex: '0', onkeydown: enterClick,
      onclick: async () => { closePanel(); await openDoc(r.d.id); },
    },
    h('div', { class: 'prog-name' }, r.d.folder !== folder ? `${r.d.folder.slice(folder.length + 1)}/${r.d.name}` : r.d.name),
    h('div', { class: 'prog-num' }, `${fmt(r.s.chars)}字・${fmt(r.s.pages)}枚`),
    h('div', { class: 'prog-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${(r.s.pages / maxPages) * 100}%` })))));
}

// ---- 執筆記録

async function recordLog() {
  if (!S.today) return;
  const log = await db.kvGet('writeLog', {});
  log[S.today.date] = { net: todayTotal(), added: S.today.added || 0, minutes: S.today.minutes || 0 };
  await db.kvSet('writeLog', log);
}

function niceMax(v) {
  if (v <= 0) return 1000;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p; // 上に余白が空きすぎない、きりのよい上限
  return 10 * p;
}

const WEEKDAY = '日月火水木金土';

async function openRecord() {
  await saveNow();
  await recordLog();
  const log = await db.kvGet('writeLog', {});
  openPanel('record');
  const body = h('div', { class: 'panel-body' });
  panel.append(panelHead('執筆記録'), body);

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const dayAt = (offset) => { const d = new Date(today); d.setDate(d.getDate() - offset); return d; };
  const entry = (d) => ({ added: 0, net: 0, minutes: 0, ...(log[T.todayKey(d)] || {}) });
  const days = [];
  for (let i = 29; i >= 0; i--) { const d = dayAt(i); days.push({ d, ...entry(d) }); }
  const sumDays = (n) => { let s = 0; for (let i = 0; i < n; i++) s += entry(dayAt(i)).added; return s; };
  const monthKey = T.todayKey(today).slice(0, 7);
  const monthSum = Object.entries(log).filter(([k]) => k.startsWith(monthKey)).reduce((a, [, v]) => a + (v.added || 0), 0);
  let streak = 0;
  for (let i = entry(today).added > 0 ? 0 : 1; i < 3650 && entry(dayAt(i)).added > 0; i++) streak++;
  const best = Object.entries(log).reduce((a, [k, v]) => ((v.added || 0) > a.added ? { k, added: v.added } : a), { k: '', added: 0 });
  const last = days[days.length - 1];

  body.append(
    h('div', { class: 'tiles' },
      statTile('今日', `${fmt(last.added)}字`, last.minutes ? `約${last.minutes}分` : null),
      statTile('直近7日', `${fmt(sumDays(7))}字`, `1日平均 ${fmt(Math.round(sumDays(7) / 7))}字`),
      statTile('今月', `${fmt(monthSum)}字`),
      statTile('続けて書いた日', `${streak}日`, best.added ? `最高 ${fmt(best.added)}字（${Number(best.k.slice(5, 7))}/${Number(best.k.slice(8))}）` : null)),
    h('div', { class: 'chart-title' }, '書いた字数（直近30日）'),
    recordChart(days),
    recordTable(days),
    recordMonths(log),
    h('p', { class: 'hint' }, '「書いた字数」は書き足した分の合計です（消した分は差し引きません）。記録はこの端末ごとに保存されます。'));
}

function recordChart(days) {
  const W = Math.max(280, Math.round(panel.clientWidth - 26) || 360);
  const H = 180, padL = 44, padR = 8, padT = 20, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = niceMax(Math.max(0, ...days.map((d) => d.added)));
  const slot = plotW / days.length;
  const bw = Math.min(24, Math.max(3, slot - 3));
  const ns = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs = {}, text = null) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text != null) e.textContent = text;
    return e;
  };
  const y = (v) => padT + plotH - (v / max) * plotH;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': '直近30日に書いた字数の棒グラフ。数値は下の「表で見る」でも確かめられます' });
  for (const t of [0, max / 2, max]) {
    svg.append(s('line', { class: t === 0 ? 'base' : 'grid', x1: padL, x2: W - padR, y1: y(t), y2: y(t) }));
    svg.append(s('text', { class: 'tick', x: padL - 6, y: y(t) + 3.5, 'text-anchor': 'end' }, fmt(t)));
  }
  const wrap = h('div', { class: 'chart' });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const hits = [];
  const off = () => { tip.hidden = true; svg.querySelectorAll('.bar.on').forEach((b) => b.classList.remove('on')); };
  days.forEach((d, i) => {
    const cx = padL + slot * i + slot / 2;
    if (d.added > 0) {
      const top = y(d.added), x = cx - bw / 2, hgt = padT + plotH - top, r = Math.min(4, bw / 2, hgt);
      svg.append(s('path', { class: 'bar', 'data-i': i, d: `M${x},${top + hgt}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${top + hgt}Z` }));
    }
    if (i % 7 === 1 || i === days.length - 1) {
      svg.append(s('text', { class: 'tick', x: cx, y: H - 7, 'text-anchor': 'middle' }, i === days.length - 1 ? '今日' : `${d.d.getMonth() + 1}/${d.d.getDate()}`));
    }
    const label = `${d.d.getMonth() + 1}月${d.d.getDate()}日（${WEEKDAY[d.d.getDay()]}）`;
    const hit = s('rect', { class: 'hit', x: padL + slot * i, y: padT, width: slot, height: plotH + padB, tabindex: 0, 'aria-label': `${label} ${d.added}字` });
    const on = () => {
      off();
      svg.querySelector(`.bar[data-i="${i}"]`)?.classList.add('on');
      tip.replaceChildren(h('strong', {}, `${fmt(d.added)}字`), h('span', {}, `${label}${d.minutes ? `・約${d.minutes}分` : ''}`));
      tip.hidden = false;
      const scale = svg.getBoundingClientRect().width / W || 1;
      tip.style.left = `${Math.min(Math.max(cx * scale, 70), W * scale - 70)}px`;
      tip.style.top = `${(d.added > 0 ? y(d.added) : padT + plotH) * scale - 8}px`;
    };
    hit.addEventListener('pointerenter', on);
    hit.addEventListener('pointerdown', on);
    hit.addEventListener('focus', on);
    hit.addEventListener('pointerleave', off);
    hit.addEventListener('blur', off);
    hits.push(hit);
  });
  // いちばん多く書いた日だけ数字を添える（すべての棒には付けない）
  const top = days.reduce((a, d) => (d.added > a.added ? d : a), days[0]);
  if (top.added > 0) {
    const i = days.indexOf(top);
    svg.append(s('text', { class: 'label', x: padL + slot * i + slot / 2, y: y(top.added) - 6, 'text-anchor': 'middle' }, fmt(top.added)));
  }
  hits.forEach((hit) => svg.append(hit));
  wrap.append(svg, tip);
  if (!days.some((d) => d.added > 0)) wrap.append(h('p', { class: 'hint chart-empty' }, 'まだ記録がありません。書くと、日ごとの字数がここに並びます。'));
  return wrap;
}

function recordTable(days) {
  return h('details', { class: 'rec-details' },
    h('summary', {}, '表で見る'),
    h('table', { class: 'rec-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '日付'), h('th', {}, '書いた字数'), h('th', {}, '増減'), h('th', {}, '時間'))),
      h('tbody', {}, [...days].reverse().map((d) => h('tr', {},
        h('td', {}, `${d.d.getMonth() + 1}/${d.d.getDate()}（${WEEKDAY[d.d.getDay()]}）`),
        h('td', {}, `${fmt(d.added)}字`),
        h('td', {}, d.net ? `${signed(d.net)}字` : '—'),
        h('td', {}, d.minutes ? `約${d.minutes}分` : '—'))))));
}

function recordMonths(log) {
  const months = new Map();
  for (const [k, v] of Object.entries(log)) {
    const m = k.slice(0, 7);
    const cur = months.get(m) || { added: 0, days: 0 };
    cur.added += v.added || 0;
    if ((v.added || 0) > 0) cur.days++;
    months.set(m, cur);
  }
  const list = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12);
  if (!list.length) return '';
  return h('details', { class: 'rec-details' },
    h('summary', {}, '月ごとの合計'),
    h('table', { class: 'rec-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '月'), h('th', {}, '書いた字数'), h('th', {}, '書いた日'))),
      h('tbody', {}, list.map(([m, v]) => h('tr', {},
        h('td', {}, `${m.slice(0, 4)}年${Number(m.slice(5))}月`), h('td', {}, `${fmt(v.added)}字`), h('td', {}, `${v.days}日`))))));
}

// ---- 読み上げ推敲

function startReading() {
  if (!Speech.supported()) { toast('この端末（ブラウザ）は読み上げに対応していません'); return; }
  const text = editor.value;
  const [a, b] = [editor.selectionStart, editor.selectionEnd];
  const from = a !== b ? a : text.lastIndexOf('\n', a - 1) + 1;
  const queue = Speech.sentences(text, from, a !== b ? b : text.length);
  if (!queue.length) { toast('読み上げる文がありません'); return; }
  renderReadBar();
  $('#readBar').hidden = false;
  reader.start(queue, { rate: S.settings.readRate || 1, voiceURI: S.settings.readVoice || '' });
  if (!Speech.japaneseVoices().length) {
    toast('日本語の音声が見つからないときは、端末の設定「テキスト読み上げ」で日本語を選んでください', 6000);
  }
}

function stopReading() {
  reader.stop();
  $('#readBar').hidden = true;
}

function toggleReading() {
  if ($('#readBar').hidden) startReading();
  else stopReading();
}

function renderReadBar() {
  const bar = $('#readBar');
  const rate = h('select', {
    title: '速さ',
    onchange: () => { S.settings.readRate = +rate.value; saveSettings(); reader.setRate(+rate.value); },
  }, [[0.8, 'ゆっくり'], [1, 'ふつう'], [1.2, '少し速く'], [1.5, '速く'], [1.8, 'とても速く']]
    .map(([v, l]) => h('option', { value: String(v), selected: (S.settings.readRate || 1) === v }, l)));
  const voices = Speech.japaneseVoices();
  const voice = h('select', {
    class: 'read-voice', title: '声', hidden: voices.length < 2,
    onchange: () => { S.settings.readVoice = voice.value; saveSettings(); reader.setVoice(voice.value); },
  }, voices.map((v) => h('option', { value: v.voiceURI, selected: v.voiceURI === S.settings.readVoice }, v.name)));
  bar.replaceChildren(
    h('button', { title: '前の文', onclick: () => reader.skip(-1) }, '⏮'),
    h('button', { class: 'read-play', title: '一時停止／再開', onclick: () => (reader.state.playing ? reader.pause() : reader.resume()) }, '⏸'),
    h('button', { title: '次の文', onclick: () => reader.skip(1) }, '⏭'),
    h('span', { class: 'read-count' }),
    h('span', { class: 'read-text' }),
    rate,
    voice,
    h('button', { title: '読み上げを終わる（Esc）', onclick: stopReading }, '■ 終わる'));
}

function showReadSentence(item, i, n) {
  const bar = $('#readBar');
  const count = bar.querySelector('.read-count');
  if (!count) return;
  count.textContent = `${i + 1}/${n}`;
  bar.querySelector('.read-text').textContent = item.say;
  if (editor.value.length >= item.end) {
    if (document.activeElement === editor) editor.setSelectionRange(item.start, item.end);
    revealCaret(item.start, 0.3);
  }
}

function readStateChanged(state) {
  const play = $('#readBar .read-play');
  if (play) play.textContent = state === 'play' ? '⏸' : '▶';
  if (state === 'end') toast('最後まで読み上げました', 2000);
}

if (Speech.supported()) {
  speechSynthesis.addEventListener('voiceschanged', () => {
    const select = $('#readBar .read-voice');
    if (!select || $('#readBar').hidden) return;
    const voices = Speech.japaneseVoices();
    select.replaceChildren(...voices.map((v) => h('option', { value: v.voiceURI, selected: v.voiceURI === S.settings.readVoice }, v.name)));
    select.hidden = voices.length < 2;
  });
}

// ---- 版の履歴

async function openHistory(id) {
  if (S.doc?.id === id) { await saveNow(); await takeSnapshot(id, editor.value); }
  const d = await db.get('docs', id);
  const snaps = (await db.getByIndex('snaps', 'doc', id)).sort((a, b) => b.time - a.time);
  openPanel('history');
  const view = h('div');
  const body = h('div', { class: 'panel-body' },
    h('p', { class: 'hint' }, '開いたとき・10分ごと・原稿を切り替えたときに自動で残ります（最新60件）。'),
    view,
    snaps.map((s) => h('div', {
      class: 'item', tabindex: '0',
      onclick: () => showSnap(s),
      onkeydown: (e) => { if (e.key === 'Enter') showSnap(s); },
    }, h('div', { class: 'main' },
      h('div', { class: 'name' }, `${new Date(s.time).toLocaleString('ja-JP')}`),
      h('div', { class: 'meta' }, `${fmt(quickChars(s.content))}字`)))));
  const showSnap = (s) => {
    view.replaceChildren(
      h('pre', { class: 'snap' }, s.content.slice(0, 3000) + (s.content.length > 3000 ? '\n…' : '')),
      h('div', { class: 'row' },
        h('button', {
          class: 'primary',
          onclick: async () => {
            if (!await confirmBox('この版に戻しますか？（今の内容も履歴に残ります）', '戻す')) return;
            if (S.doc?.id !== id) await openDoc(id, { focus: false });
            await takeSnapshot(id, editor.value);
            closePanel();
            applyText(s.content, 0);
            await saveNow();
            toast('この版に戻しました');
          },
        }, 'この版に戻す'),
        h('button', {
          onclick: async () => {
            closePanel();
            await createDoc({ folder: d.folder, name: `${d.name}（${T.compactStamp(new Date(s.time))}の版）`, content: s.content });
          },
        }, '別の原稿として開く')));
    body.scrollTop = 0;
  };
  panel.append(panelHead(`版の履歴：${d.name}`), body);
  body.querySelector('.item')?.focus();
}

// ---- 設定

async function openSettings(section) {
  openPanel('settings');
  const st = S.settings;
  const save = () => { saveSettings(); applyView(); updateStats(); if (S.proof) runProof(); };
  const select = (key, options, onChange) => h('select', {
    onchange: (e) => { st[key] = isNaN(+e.target.value) || e.target.value === '' ? e.target.value : +e.target.value; save(); onChange?.(); },
  }, options.map(([v, label]) => h('option', { value: String(v), selected: String(st[key]) === String(v) }, label)));
  const check = (key, label) => h('label', { class: 'field check' },
    h('input', { type: 'checkbox', checked: !!st[key], onchange: (e) => { st[key] = e.target.checked; save(); if (key === 'wakeLock') keepAwake(); } }), label);
  const range = (key, min, max, step, unit = '') => {
    const out = h('output', {}, `${st[key]}${unit}`);
    return [h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(st[key]), oninput: (e) => { st[key] = +e.target.value; out.textContent = `${st[key]}${unit}`; save(); } }), out];
  };
  const field = (label, ...control) => h('label', { class: 'field' }, h('span', {}, label), h('div', { class: 'row', style: 'margin:0;flex-wrap:nowrap' }, control));

  // 同期
  const cfg = { ...S.sync };
  const syncInput = (key, label, props = {}) => field(label, h('input', { type: 'text', value: cfg[key] || '', autocomplete: 'off', ...props, oninput: (e) => { cfg[key] = e.target.value.trim(); } }));
  const syncMsg = h('p', { class: 'hint' }, S.syncError ? `前回のエラー：${S.syncError}` : (await db.kvGet('lastSync')) ? `最終同期：${new Date(await db.kvGet('lastSync')).toLocaleString('ja-JP')}` : '');
  const saveSync = async () => { S.sync = { ...cfg, branch: cfg.branch || 'main' }; await db.kvSet('sync', S.sync); setSyncState(Sync.isConfigured(S.sync) ? 'pending' : 'none'); };

  // 辞書
  const dictBox = h('div');
  const renderDictBox = async () => {
    const info = await Dict.dictInfo();
    const browse = await Dict.browseInfo();
    const published = await Dict.publishedDict();
    const progress = h('progress', { max: '1', value: '0', hidden: true });
    const status = h('p', { class: 'hint' });
    const install = async () => {
      progress.hidden = false;
      try {
        const r = await Dict.installDict((label, done, total) => { progress.max = total || 1; progress.value = done; status.textContent = `${label} ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`; });
        status.textContent = `${fmt(r.entries)}語を取り込みました。オフラインで使えます。`;
        setTimeout(renderDictBox, 1500);
      } catch (e) {
        status.textContent = `失敗しました：${e.message}`;
      }
    };
    dictBox.replaceChildren(
      h('p', { class: 'hint' }, info
        ? `取り込み済み：${fmt(info.entries)}語（${new Date(info.installed).toLocaleDateString('ja-JP')}）`
        : '未導入です。Wi-Fi のあるところで一度だけ取り込めば、以後はオフラインで引けます。'),
      info ? h('p', { class: 'hint' }, browse
        ? `紙面（五十音順）：${fmt(browse.entries)}語`
        : '紙面（五十音順に眺める）のデータはまだです。上の「辞書」から紙の辞書を開くと取り込めます。') : null,
      published ? h('p', { class: 'hint' }, `公開中の辞書データ：${(published.shards.reduce((a, s) => a + s.bytes, 0) / 1048576).toFixed(1)} MB（版 ${published.version}）`) : h('p', { class: 'hint' }, navigator.onLine ? '辞書データが公開されていません。' : 'オフラインのため、公開中の辞書を確認できません。'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', disabled: !published, onclick: install }, info ? '最新版を取り込み直す' : '辞書を取り込む'),
        info ? h('button', { onclick: async () => { if (await confirmBox('オフライン辞書を端末から削除しますか？', '削除', true)) { await Dict.removeDict(); renderDictBox(); } } }, '削除') : null),
      progress, status,
      published ? h('p', { class: 'hint' }, '出典：', published.sources.map((s) => h('span', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.name), `（${s.license}） `))) : null);
  };
  renderDictBox();

  // バックアップ
  const importInput = h('input', {
    type: 'file', accept: '.json,application/json', hidden: true,
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        let added = 0;
        for (const d of data.docs || []) {
          if (await db.get('docs', d.id)) continue;
          d.baseSha = null;
          d.name = await uniqueName(d.folder || '', d.name, d.ext || '.md');
          await db.put('docs', d);
          added++;
        }
        S.unsynced = true;
        toast(`${added}件の原稿を復元しました（同じ原稿がすでにあるものは飛ばしました）`, 5000);
      } catch {
        toast('バックアップファイルを読めませんでした');
      }
    },
  });

  const keys = [
    ['Ctrl+S', '保存して同期'], ['Alt+O', 'ファイル一覧'], ['Alt+N', '新しい原稿'], ['Alt+M', 'すぐメモ（メモ フォルダに新規）'],
    ['Alt+L', 'アウトライン'], ['Alt+↑ / Alt+↓', 'カーソルのある節を前後へ移動'], ['Alt+Shift+↑ / ↓', '前後の見出しへ移動'],
    ['Alt+D', '紙の辞書を開く（語を選んでいれば、その語を横のパネルで調べる）'],
    ['辞書で ← → / Space', 'ページをめくる（縦組みは ← が次のページ）'], ['辞書で / ・ T ・ R ・ B', '検索・今日の言葉・パッと開く・単語帳'], ['Ctrl+F / Ctrl+H', '検索／置換'], ['F3 / Shift+F3', '次／前を検索'],
    ['Alt+V', '縦書き・横書きの切り替え'], ['Alt+P', 'プレビュー（ルビ・傍点・縦中横）'], ['Alt+Z / F11', '集中モード'],
    ['Alt+R', 'ルビ記法を挿入 ｜漢字《かんじ》'], ['Alt+B', '傍点記法を挿入 《《強調》》'], ['Alt+T', '日付と時刻を挿入'],
    ['F7 / Alt+K', '校正モード（誤字・表記ゆれに波線）'], ['F8 / Shift+F8', '次／前の指摘へ'],
    ['Alt+Y', '読み上げ推敲（選択部分、またはカーソルのある段落から）'], ['Alt+Q', 'QRコードで渡す'],
    ['Alt+E', 'PDF（応募原稿）を作る'], ['Alt+I ／ Alt+W', '作品の進捗／執筆記録'],
    ['Alt+H', '版の履歴'], ['Alt+G', '目標文字数'], ['Alt+＋ / Alt+−', '文字を大きく／小さく'], ['Alt+,', '設定'], ['Esc', 'パネルを閉じる'],
  ];

  const body = h('div', { class: 'panel-body' },
    h('fieldset', { class: 'set', id: 'set-view' }, h('legend', {}, '表示'),
      field('配色', select('theme', [['paper', '生成り'], ['white', '白'], ['dark', '黒'], ['navy', '紺']])),
      field('書体', select('font', [['mincho', '明朝（端末）'], ['gothic', 'ゴシック（端末）'], ['shippori', 'しっぽり明朝（Web）'], ['bizud', 'BIZ UDゴシック（Web）']])),
      field('文字の大きさ', ...range('fontSize', 12, 48, 1, 'px')),
      field('行間', ...range('lineHeight', 1.2, 2.6, 0.1)),
      field('1行の文字数', select('cols', [[0, '画面いっぱい'], [20, '20字'], [30, '30字'], [40, '40字'], [50, '50字']])),
      check('vertical', '新しく開く原稿を縦書きにする'),
      check('typewriter', 'タイプライター表示（入力中の行を画面の中ほどに保つ）'),
      check('focusStatus', '集中モードでも文字数などを薄く表示する'),
      check('wakeLock', '書いている間は画面を消さない（5分操作がなければ解除）')),
    h('fieldset', { class: 'set' }, h('legend', {}, '執筆'),
      check('autoIndent', '改行したとき段落の字下げ（全角空白）を引き継ぐ。「 などで始めると字下げを外す'),
      check('tabFullwidth', 'Tab キーで全角空白を入れる'),
      check('chapters', '「第一章」「プロローグ」などの行も見出しとして扱う'),
      field('すぐメモの保存先', h('input', {
        type: 'text', value: st.memoFolder, placeholder: '例：Obsidian/ポメラ/メモ',
        onchange: (e) => { st.memoFolder = T.safeFolder(e.target.value) || 'メモ'; e.target.value = st.memoFolder; saveSettings(); },
      })),
      field('原稿用紙換算', select('genkoCols', [[20, '20字'], [40, '40字']]), '×', select('genkoRows', [[20, '20行'], [30, '30行'], [40, '40行']]))),
    h('fieldset', { class: 'set', id: 'set-sync' }, h('legend', {}, '同期（GitHub 経由で PC の Obsidian へ）'),
      h('p', { class: 'hint' }, '原稿用の非公開リポジトリと、そのリポジトリだけに書き込めるトークンを入れます。手順はセットアップ手順書を見てください。トークンはこの端末の中にだけ保存されます。'),
      syncInput('owner', 'ユーザー名', { placeholder: '例：aji-daze' }),
      syncInput('repo', 'リポジトリ', { placeholder: '例：pomera-data' }),
      syncInput('branch', 'ブランチ', { placeholder: 'main' }),
      syncInput('root', 'フォルダ', { placeholder: '空欄でリポジトリ全体' }),
      syncInput('token', 'トークン', { type: 'password', placeholder: 'github_pat_…' }),
      field('自動同期', select('autoSyncMin', [[2, '2分ごと'], [5, '5分ごと'], [15, '15分ごと'], [60, '1時間ごと'], [0, 'しない（Ctrl+S のときだけ）']])),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => { await saveSync(); toast('保存しました'); } }, '保存'),
        h('button', {
          onclick: async () => {
            await saveSync();
            syncMsg.textContent = '確認中…';
            try {
              const r = await Sync.testConnection(S.sync);
              syncMsg.textContent = r.warn ? `注意：${r.warn}` : '接続できました。書き込みもできます。';
            } catch (e) { syncMsg.textContent = `接続できません：${e.message}`; }
          },
        }, '接続テスト'),
        h('button', { onclick: async () => { await saveSync(); await doSync({ manual: true }); } }, '今すぐ同期')),
      syncMsg),
    h('fieldset', { class: 'set', id: 'set-dict' }, h('legend', {}, 'オフライン辞書'), dictBox),
    h('fieldset', { class: 'set', id: 'set-proof' }, h('legend', {}, '校正モード（F7）'),
      h('p', { class: 'hint' }, '辞書を使わない規則で、誤字や表記ゆれの「候補」に波線を引きます。誤りとは限らないので、直すかどうかはご自身で判断してください。'),
      Proof.CATEGORIES.map(([k, label, desc]) => h('label', { class: 'field check' },
        h('input', {
          type: 'checkbox', checked: !!{ ...Proof.DEFAULT_CATS, ...st.proofCats }[k],
          onchange: (e) => { st.proofCats = { ...Proof.DEFAULT_CATS, ...st.proofCats, [k]: e.target.checked }; save(); },
        }),
        h('span', {}, `${label}：${desc}`))),
      check('proofDialogue', '会話文（「」の中）は、文体・読みやすさのチェックから外す'),
      field('長い文の目安', select('proofMaxLen', [[80, '80字'], [100, '100字'], [120, '120字'], [150, '150字'], [200, '200字']])),
      h('div', { class: 'row' }, h('button', {
        onclick: async () => {
          if (!await confirmBox('「無視」にした指摘をすべて元に戻しますか？', '戻す')) return;
          S.proofIgnoreGlobal = new Set();
          await db.kvSet('proofIgnore', []);
          for (const d of await db.getAll('docs')) {
            if (d.proofIgnore?.length) await db.update('docs', d.id, (x) => { x.proofIgnore = []; return x; });
          }
          if (S.doc) S.doc.proofIgnore = [];
          if (S.proof) runProof();
          toast('無視した指摘を元に戻しました');
        },
      }, '無視リストを消去'))),
    h('fieldset', { class: 'set' }, h('legend', {}, 'バックアップ'),
      h('p', { class: 'hint' }, '全原稿（ゴミ箱を含む）を1つのファイルに書き出します。同期を使っていなくても、ときどき書き出しておくと安心です。'),
      h('div', { class: 'row' },
        h('button', {
          onclick: async () => {
            await saveNow();
            const blob = new Blob([JSON.stringify({ app: 'pomera-tab', version: VERSION, exported: new Date().toISOString(), docs: await db.getAll('docs') })], { type: 'application/json' });
            downloadBlob(blob, `pomera-tab-backup-${T.compactStamp()}.json`);
          },
        }, '書き出す'),
        h('button', { onclick: () => importInput.click() }, '復元する'), importInput)),
    h('fieldset', { class: 'set', id: 'set-help' }, h('legend', {}, 'キー操作'),
      h('table', { class: 'keys' }, keys.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v)))),
      h('p', { class: 'hint' }, 'ルビは「｜漢字《かんじ》」、漢字だけなら「漢字《かんじ》」、傍点は「《《強調》》」。見出しは行頭の「# 」。'),
      h('p', { class: 'hint' }, `ポメラタブ ${VERSION}`)));

  panel.append(panelHead('設定'), body);
  if (section) body.querySelector(`#set-${section}`)?.scrollIntoView();
}

// ---------------------------------------------------------------- プレビュー・集中モード

function renderPreview() {
  preview.innerHTML = T.previewHTML(editor.value, isVertical());
}

function togglePreview(force) {
  S.preview = force ?? !S.preview;
  preview.hidden = !S.preview;
  editor.hidden = S.preview;
  applyView();
  if (S.preview) {
    renderPreview();
    preview.focus();
    if (isVertical()) preview.scrollLeft = 0;
  } else {
    editor.focus({ preventScroll: true });
    revealCaret(editor.selectionStart);
  }
}

function toggleFocus(force) {
  S.focus = force ?? !S.focus;
  applyView();
  if (S.focus && !document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  toast(S.focus ? '集中モード（Alt+Z で戻る／画面の上端をタップでメニュー）' : '集中モードを終了', 1800);
}

let revealTimer = 0;
$('#reveal').addEventListener('pointerdown', () => {
  document.body.classList.add('reveal');
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => document.body.classList.remove('reveal'), 3500);
});
$('#topbar').addEventListener('pointerenter', () => clearTimeout(revealTimer));

// ---------------------------------------------------------------- 画面を消さない・電池・時計

async function keepAwake() {
  if (!S.settings.wakeLock || !('wakeLock' in navigator) || document.hidden || S.wakeLock) return;
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
  } catch { /* 省電力モードなどで拒否されることがある */ }
}

setInterval(() => {
  if (S.wakeLock && Date.now() - S.lastInput > 5 * 60 * 1000) S.wakeLock.release();
}, 30 * 1000);

function tickClock() { $('#stClock').textContent = hhmm(Date.now()); }
setInterval(tickClock, 15 * 1000);
tickClock();

navigator.getBattery?.().then((b) => {
  const upd = () => { $('#stBattery').textContent = `${b.charging ? '⚡' : '電池'} ${Math.round(b.level * 100)}%`; };
  upd();
  b.addEventListener('levelchange', upd);
  b.addEventListener('chargingchange', upd);
});

// ---------------------------------------------------------------- 同期

function setSyncState(kind) {
  S.syncState = kind;
  const el = $('#stSync');
  const btn = $('#btnSync');
  const last = S.lastSyncOk ? hhmm(S.lastSyncOk) : '';
  const text = {
    none: '同期：未設定',
    pending: '未同期',
    running: '同期中…',
    ok: `同期済 ${last}`,
    offline: 'オフライン',
    error: '同期エラー',
  }[kind];
  el.textContent = text;
  btn.classList.toggle('pending', kind === 'pending' || (kind === 'offline' && S.unsynced));
  btn.classList.toggle('error', kind === 'error');
}

async function doSync({ manual = false } = {}) {
  if (!Sync.isConfigured(S.sync)) {
    if (manual) { toast('同期が未設定です'); openSettings('sync'); }
    return;
  }
  S.lastSyncTry = Date.now();
  if (!navigator.onLine) {
    setSyncState('offline');
    if (manual) toast('オフラインです。つながったら自動で同期します');
    return;
  }
  await saveNow();
  const before = S.saveCount;
  setSyncState('running');
  try {
    const st = await Sync.sync(S.sync, {
      onPulled,
      onTrashed,
      onProgress: (i, n) => { if (n > 30 && i % 5 === 0) $('#stSync').textContent = `同期中 ${i}/${n}`; },
    });
    S.syncError = null;
    S.lastSyncOk = Date.now();
    S.unsynced = S.saveCount !== before;
    setSyncState(S.unsynced ? 'pending' : 'ok');
    const parts = [];
    if (st.pushed) parts.push(`送信${st.pushed}`);
    if (st.pulled) parts.push(`受信${st.pulled}`);
    if (st.deleted) parts.push(`削除${st.deleted}`);
    if (st.conflicts.length) {
      toast(`両方で書き換えられた原稿が${st.conflicts.length}件ありました。PC側の版を「(競合 PC版 …)」として残しました`, 8000, ['一覧', openFiles]);
    } else if (manual || parts.length) {
      toast(parts.length ? `同期しました（${parts.join('・')}）` : '同期済みです', 2000);
    }
    if (S.panel === 'files') renderFiles();
  } catch (e) {
    const first = S.syncError !== e.message;
    S.syncError = e.message;
    setSyncState(e.offline ? 'offline' : 'error');
    if (manual || (first && !e.offline)) toast(`同期できませんでした：${e.message}`, 6000);
  }
}

function onPulled(id, oldContent, newContent) {
  if (S.doc?.id !== id) return;
  if (editor.value === oldContent && !S.composing && !S.saveTimer) {
    const caret = Math.min(editor.selectionStart, newContent.length);
    const focused = document.activeElement === editor;
    applyText(newContent, caret);
    S.doc.content = newContent;
    S.savedContent = newContent;
    if (!focused) editor.blur();
    updateStats();
    toast('PCでの変更を取り込みました', 2500);
  } else {
    // 取り込む瞬間に書き足していた: 次の同期で両方の版を残す
    db.update('docs', id, (d) => { d.baseSha = null; return d; });
    S.unsynced = true;
  }
}

async function onTrashed(id) {
  if (S.doc?.id !== id) return;
  toast('この原稿はPC側で削除されたため、ゴミ箱に移しました', 5000);
  await openFallback();
}

async function hasUnsynced() {
  if ((await db.count('tombs')) > 0) return true;
  for (const d of await activeDocs()) {
    const sha = d.sha && d.shaAt === d.updated ? d.sha : await Sync.blobSha(d.content);
    if (!d.baseSha || d.baseSha !== sha) return true;
  }
  return false;
}

setInterval(() => {
  const min = S.settings.autoSyncMin;
  if (!min || document.hidden || S.syncState === 'running') return;
  if (Date.now() - S.lastSyncTry >= min * 60 * 1000) doSync();
}, 30 * 1000);

window.addEventListener('online', () => doSync());
window.addEventListener('offline', () => setSyncState(Sync.isConfigured(S.sync) ? 'offline' : 'none'));

document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    await saveNow();
    if (S.doc) takeSnapshot(S.doc.id, editor.value);
    if (S.unsynced && S.settings.autoSyncMin) doSync();
  } else {
    keepAwake();
    if (S.settings.autoSyncMin && Date.now() - S.lastSyncTry > 60 * 1000) doSync();
  }
});
window.addEventListener('pagehide', () => { saveNow(); });

// ---------------------------------------------------------------- 入力まわり

function checkIndentBracket() {
  const i = S.autoIndentAt;
  if (i < 0) return;
  const v = editor.value;
  const caret = editor.selectionStart;
  if (v[i] !== '　') { S.autoIndentAt = -1; return; }
  const typed = v.length - S.autoIndentLen;
  if (typed <= 0 && caret === i + 1) return; // まだ何も打っていない
  S.autoIndentAt = -1;
  // 字下げの直後に「 などの括弧や見出しの # を打ったら（まとめて確定した場合も）、自動で入れた字下げを外す
  if (typed > 0 && caret === i + 1 + typed && (OPEN_BRACKETS + '#＃').includes(v[i + 1])) {
    replaceRange(i, i + 1, '');
    editor.setSelectionRange(caret - 1, caret - 1);
  }
}

editor.addEventListener('input', (e) => {
  if (S.applying) return;
  onEdited();
  if (!e.isComposing) checkIndentBracket();
});
editor.addEventListener('compositionstart', () => { S.composing = true; });
editor.addEventListener('compositionend', () => { S.composing = false; setTimeout(checkIndentBracket, 0); });

document.addEventListener('selectionchange', () => {
  if (document.activeElement !== editor) return;
  updateSelection();
  if (S.panel === 'outline') renderOutline();
});

editor.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && S.settings.tabFullwidth) {
    e.preventDefault();
    insertText(e.shiftKey ? '\t' : '　');
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && S.settings.autoIndent && editor.selectionStart === editor.selectionEnd) {
    const v = editor.value;
    const p = editor.selectionStart;
    const lineStart = v.lastIndexOf('\n', p - 1) + 1;
    const head = v[lineStart];
    const next = v[p];
    const nextIsBracket = next && (OPEN_BRACKETS + '　').includes(next); // 「の手前で改行したときは字下げしない
    if (p > lineStart && !nextIsBracket && (head === '　' || (S.indentStyle && OPEN_BRACKETS.includes(head)))) {
      e.preventDefault();
      insertText('\n　');
      S.autoIndentAt = editor.selectionStart - 1;
      S.autoIndentLen = editor.value.length;
      S.indentStyle = true;
    }
  }
});

function wrapSelection(before, after, emptyCaretOffset) {
  const [a, b] = [editor.selectionStart, editor.selectionEnd];
  const sel = editor.value.slice(a, b);
  replaceRange(a, b, before + sel + after);
  const caret = sel ? a + before.length + sel.length + after.length : a + emptyCaretOffset;
  editor.setSelectionRange(caret, caret);
}

function jumpHeading(dir) {
  const items = T.outline(editor.value, S.settings.chapters);
  const caret = editor.selectionStart;
  const target = dir > 0 ? items.find((it) => it.start > caret) : [...items].reverse().find((it) => it.start < caret);
  if (target) jumpTo(target.start);
}

const COMMANDS = {
  files: () => togglePanel('files', openFiles),
  newdoc: newDocDialog,
  memo: () => quickMemo(),
  rename: () => S.doc && renameDialog(S.doc.id),
  outline: () => togglePanel('outline', openOutline),
  dict: () => {
    if (dictView.isOpen()) { dictView.close(); return; }
    if (document.activeElement === editor && editor.selectionStart !== editor.selectionEnd) togglePanel('dict', () => openDict());
    else { closePanel(); dictView.open(); }
  },
  find: () => openFind(false),
  replace: () => openFind(true),
  findNext: () => findNext(1),
  findPrev: () => findNext(-1),
  vertical: async () => {
    const v = !isVertical();
    S.doc.vertical = v;
    await db.update('docs', S.doc.id, (d) => { d.vertical = v; return d; });
    applyView();
    requestAnimationFrame(() => revealCaret(editor.selectionStart));
  },
  preview: () => togglePreview(),
  focus: () => toggleFocus(),
  sync: () => doSync({ manual: true }),
  settings: () => togglePanel('settings', () => openSettings()),
  help: () => openSettings('help'),
  history: () => S.doc && openHistory(S.doc.id),
  goal: () => S.doc && setGoal(S.doc.id),
  date: () => insertText(T.dateStamp()),
  ruby: () => wrapSelection('｜', '《》', 1),
  bouten: () => wrapSelection('《《', '》》', 2),
  sectionUp: () => moveSection(null, -1),
  sectionDown: () => moveSection(null, 1),
  headingPrev: () => jumpHeading(-1),
  headingNext: () => jumpHeading(1),
  // 幅の狭い画面で上のバーに入りきらないボタンを、ここにまとめる
  more: async () => {
    const narrow = window.innerWidth <= 700;
    const mid = window.innerWidth <= 980;
    const v = await menu('メニュー', [
      narrow && ['目次（アウトライン）', 'outline'],
      narrow && ['検索・置換', 'find'],
      narrow && [S.proof ? '校正モードを終わる' : '校正モード', 'proof'],
      narrow && [isVertical() ? '横書きにする' : '縦書きにする', 'vertical'],
      mid && [S.preview ? '編集に戻る' : '表示（ルビ・縦中横の確認）', 'preview'],
      mid && [S.focus ? '集中モードを終わる' : '集中モード', 'focus'],
      [$('#readBar').hidden ? '読み上げ推敲' : '読み上げを終わる', 'read'],
      ['QRコードで渡す', 'qr'],
      ['PDF（応募原稿）を作る', 'pdf'],
      ['作品の進捗', 'progress'],
      ['執筆記録', 'record'],
      ['すぐメモ', 'memo'],
      ['新しい原稿', 'newdoc'],
      narrow && ['設定', 'settings'],
    ]);
    if (v && COMMANDS[v]) COMMANDS[v]();
  },
  proof: () => {
    if (!S.proof) toggleProof(true);
    else if (S.panel !== 'proof') openProofPanel();
    else toggleProof(false);
  },
  qr: () => openQr(),
  pdf: () => openPdfPanel(),
  progress: () => openProgress(),
  record: () => openRecord(),
  read: () => toggleReading(),
  proofNext: () => proofNext(1),
  proofPrev: () => proofNext(-1),
  bigger: () => { S.settings.fontSize = Math.min(48, S.settings.fontSize + 1); saveSettings(); applyView(); },
  smaller: () => { S.settings.fontSize = Math.max(12, S.settings.fontSize - 1); saveSettings(); applyView(); },
};

const KEYMAP = {
  'C-s': 'sync', 'C-o': 'files', 'A-o': 'files', 'A-n': 'newdoc', 'A-m': 'memo',
  'A-l': 'outline', 'A-d': 'dict', 'C-f': 'find', 'C-h': 'replace', 'F3': 'findNext', 'S-F3': 'findPrev', 'C-g': 'findNext',
  'A-v': 'vertical', 'A-p': 'preview', 'A-z': 'focus', 'F11': 'focus', 'A-,': 'settings', 'F1': 'help', 'A-/': 'help',
  'A-h': 'history', 'A-g': 'goal', 'A-t': 'date', 'A-r': 'ruby', 'A-b': 'bouten',
  'A-ArrowUp': 'sectionUp', 'A-ArrowDown': 'sectionDown', 'A-S-ArrowUp': 'headingPrev', 'A-S-ArrowDown': 'headingNext',
  'F7': 'proof', 'A-k': 'proof', 'F8': 'proofNext', 'S-F8': 'proofPrev',
  'A-q': 'qr', 'A-e': 'pdf', 'A-i': 'progress', 'A-w': 'record', 'A-y': 'read',
  'A-=': 'bigger', 'A-S-=': 'bigger', 'A-;': 'bigger', 'A--': 'smaller',
};
const EDITOR_ONLY = new Set(['date', 'ruby', 'bouten', 'sectionUp', 'sectionDown', 'headingPrev', 'headingNext', 'findNext', 'findPrev']);

document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if ($('#dialog').open) return;
  if (dictView.isOpen() && !(e.altKey && e.code === 'KeyD') && dictView.handleKey(e)) return;
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (e.code === 'Comma') key = ',';
  else if (e.code === 'Slash') key = '/';
  else if (e.code === 'Minus') key = '-';
  else if (e.code === 'Equal') key = '=';
  else if (e.code === 'Semicolon') key = ';';
  const combo = `${e.ctrlKey || e.metaKey ? 'C-' : ''}${e.altKey ? 'A-' : ''}${e.shiftKey && key.length > 1 ? 'S-' : ''}${key}`;
  const cmd = KEYMAP[combo] || KEYMAP[combo.replace('S-', '')];
  if (cmd && COMMANDS[cmd]) {
    if (EDITOR_ONLY.has(cmd) && e.target !== editor && !(cmd.startsWith('find') && S.panel === 'find')) return;
    if (cmd.startsWith('section') && S.panel === 'outline' && e.target !== editor) return; // パネル側で処理
    e.preventDefault();
    COMMANDS[cmd]();
    return;
  }
  if (e.key === 'Escape') {
    if (S.panel) { e.preventDefault(); closePanel(); }
    else if (S.preview) { e.preventDefault(); togglePreview(false); }
    else if (!$('#readBar').hidden) { e.preventDefault(); stopReading(); }
    else if (document.body.classList.contains('reveal')) document.body.classList.remove('reveal');
  }
});

$('#topbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (b && COMMANDS[b.dataset.cmd]) COMMANDS[b.dataset.cmd]();
});
$('#stSync').addEventListener('click', () => doSync({ manual: true }));
$('#stProof').addEventListener('click', () => (S.panel === 'proof' ? closePanel() : openProofPanel()));
editor.addEventListener('scroll', syncProofScroll, { passive: true });
window.addEventListener('resize', () => { if (S.proof) renderProofLayer(); });
$('#stChars').addEventListener('click', () => S.doc && setGoal(S.doc.id));

// ---------------------------------------------------------------- 起動

const WELCOME = `# ポメラタブへようこそ

　ここはオフラインでも使える、書くことだけの画面です。入力した内容は一文字ごとに端末へ保存されます。

## はじめにやること

1. Chrome のメニューから「アプリをインストール」（またはホーム画面に追加）
2. 右上の ⚙ →「同期」に、GitHub のユーザー名・リポジトリ・トークンを入れる
3. 同じ画面の「オフライン辞書」で辞書を取り込む（Wi-Fi で一度だけ）

## よく使うキー

- Ctrl+S　保存して同期
- Alt+O　ファイル一覧／Alt+N　新しい原稿
- Alt+L　アウトライン（見出しの一覧）
- Alt+D　辞書／Ctrl+F　検索
- Alt+V　縦書き・横書き／Alt+Z　集中モード

## 書き方

　見出しは行頭に「# 」。ルビは｜漢字《かんじ》、傍点は《《ここ》》。Alt+P で仕上がりを確認できます。
　「_辞書」フォルダに「- 語（よみ）: 説明」の行を書いておくと、自分用の用語集として辞書から引けます。

　このファイルは消してかまいません。
`;

async function handleLaunchParams() {
  const p = new URLSearchParams(location.search);
  if (![...p.keys()].length) return false;
  history.replaceState(null, '', location.pathname);
  if (p.get('new') === 'memo') { await quickMemo(); return true; }
  const shared = [p.get('title'), p.get('text'), p.get('url')].filter(Boolean).join('\n');
  if (shared) { await quickMemo(shared); toast('共有された内容を新しいメモにしました'); return true; }
  return false;
}

async function start() {
  await loadSettings();
  await loadToday();
  S.proofIgnoreGlobal = new Set(await db.kvGet('proofIgnore', []));
  applyView();
  setSyncState(Sync.isConfigured(S.sync) ? 'pending' : 'none');
  db.requestPersist();

  if (!await handleLaunchParams()) {
    const lastId = await db.kvGet('lastDocId');
    const opened = lastId && await openDoc(lastId);
    if (!opened) {
      const docs = await activeDocs();
      if (docs.length) await openFallback();
      else await createDoc({ name: 'はじめに', content: WELCOME, caret: 0 });
    }
  }

  S.unsynced = await hasUnsynced();
  if (Sync.isConfigured(S.sync)) {
    setSyncState(S.unsynced ? 'pending' : 'ok');
    doSync();
  }
  keepAwake();

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller; // 初回の登録では再読み込みしない
    const reg = await navigator.serviceWorker.register('sw.js').catch(() => null);
    if (reg) {
      const notify = (worker) => toast('新しいバージョンがあります', 0, ['更新', () => worker.postMessage('skipWaiting')]);
      if (reg.waiting && navigator.serviceWorker.controller) notify(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) notify(w); });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', async () => {
        if (reloading || !hadController) return;
        reloading = true;
        await saveNow();
        location.reload();
      });
    }
  }
}

start();

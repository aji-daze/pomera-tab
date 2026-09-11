// 文字数・原稿用紙換算・アウトライン・ルビなどのテキスト処理

// 行頭に来たらぶら下げる文字（句読点・閉じ括弧）
const HANG = '、。，．,.」』）〕］｝〉》】〙〗”’!?！？';
const KANJI = '々〆ヶ一-鿿豈-﫿';
const RUBY_BAR = /[|｜]([^|｜《\n]+?)《([^》\n]*?)》/g;
const RUBY_KANJI = new RegExp(`([${KANJI}]+)《([^》\\n]*?)》`, 'g');
const BOUTEN = /《《(.+?)》》/g;
const HEADING = /^(#{1,6})[ \t　]+(.+)$/;
const CHAPTER = /^[ \t　]*(第[0-9０-９〇一二三四五六七八九十百千]+[章話部幕節編回]|序章|終章|プロローグ|エピローグ|幕間)/;

// 見出し記号・ルビ記法を除いた本文
export function stripMarkup(text) {
  return text
    .replace(/^#{1,6}[ \t　]+/gm, '')
    .replace(BOUTEN, '$1')
    .replace(RUBY_BAR, '$1')
    .replace(RUBY_KANJI, '$1');
}

// 原稿用紙の行数（ぶら下げ禁則あり）
export function genkoLines(text, cols = 20) {
  let lines = 0;
  for (const para of text.replace(/\n$/, '').split('\n')) {
    const s = [...para];
    let l = 1, col = 0;
    for (const ch of s) {
      if (col >= cols) {
        if (col === cols && HANG.includes(ch)) { col++; continue; }
        l++; col = 0;
      }
      col++;
    }
    lines += l;
  }
  return lines;
}

export function stats(text, cols = 20, rows = 20) {
  const plain = stripMarkup(text);
  const noNl = plain.replace(/\r?\n/g, '');
  const chars = [...noNl].length;
  const noSpace = [...noNl.replace(/[\s　]/g, '')].length;
  const lines = plain ? genkoLines(plain, cols) : 0;
  return { chars, noSpace, lines, pages: Math.ceil(lines / rows) };
}

// 見出し一覧。Markdown の「# 見出し」と「第一章」などの章題行を認識する。
export function outline(text, chapters = true) {
  const items = [];
  let pos = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(HEADING);
    if (m) items.push({ line: i, level: m[1].length, title: m[2].trim(), start: pos });
    else if (chapters && CHAPTER.test(line) && [...line.trim()].length <= 40) {
      items.push({ line: i, level: 1, title: line.trim(), start: pos });
    }
    pos += line.length + 1;
  }
  for (let i = 0; i < items.length; i++) {
    items[i].end = text.length;
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].level <= items[i].level) { items[i].end = items[j].start; break; }
    }
  }
  return items;
}

// 見出しの節（見出し＋本文）を同じ階層の前後の節と入れ替える
export function moveSection(text, items, idx, dir) {
  const it = items[idx];
  let sib = -1;
  for (let j = idx + dir; j >= 0 && j < items.length; j += dir) {
    if (items[j].level < it.level) break;
    if (items[j].level === it.level) { sib = j; break; }
  }
  if (sib < 0) return null;
  const a = dir < 0 ? items[sib] : it;
  const b = dir < 0 ? it : items[sib];
  const addNl = !text.endsWith('\n');
  const t = addNl ? text + '\n' : text;
  const bEnd = b.end === text.length ? t.length : b.end;
  const blockA = t.slice(a.start, b.start);
  const blockB = t.slice(b.start, bEnd);
  let out = t.slice(0, a.start) + blockB + blockA + t.slice(bEnd);
  if (addNl) out = out.slice(0, -1);
  return { text: out, caret: dir < 0 ? a.start : a.start + blockB.length };
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function inline(s, vertical) {
  s = esc(s)
    .replace(BOUTEN, '<em class="bouten">$1</em>')
    .replace(RUBY_BAR, '<ruby>$1<rt>$2</rt></ruby>')
    .replace(RUBY_KANJI, '<ruby>$1<rt>$2</rt></ruby>');
  // 縦書きでは2桁の数字と「!?」を縦中横にする
  if (vertical) s = s.replace(/(?<![0-9])([0-9]{2}|[!?！？]{2})(?![0-9])/g, '<span class="tcy">$1</span>');
  return s;
}

// ルビ・傍点・見出しを反映したプレビュー用HTML
export function previewHTML(text, vertical) {
  return text.split('\n').map((line) => {
    const m = line.match(HEADING);
    if (m) {
      const lv = Math.min(m[1].length + 1, 6);
      return `<h${lv}>${inline(m[2], vertical)}</h${lv}>`;
    }
    if (!line.trim()) return '<p class="blank"></p>';
    return `<p>${inline(line, vertical)}</p>`;
  }).join('');
}

// ファイル名に使えない文字を全角に置き換える（Windows / Obsidian 互換）
export function safeName(name) {
  const map = { '\\': '＼', '/': '／', ':': '：', '*': '＊', '?': '？', '"': '”', '<': '＜', '>': '＞', '|': '｜', '#': '＃', '^': '＾', '[': '［', ']': '］' };
  const s = name.replace(/[\\/:*?"<>|#^[\]]/g, (c) => map[c]).replace(/[\x00-\x1f]/g, '').trim();
  return s.replace(/^\.+/, '') || '無題';
}

export function safeFolder(folder) {
  return folder.split('/').map((s) => s.trim()).filter(Boolean).map(safeName).join('/');
}

const WEEK = '日月火水木金土';
export function dateStamp(d = new Date(), withTime = true) {
  const s = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
  return withTime ? `${s} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` : s;
}

export function compactStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 応募用の縦書き原稿を組んで、ブラウザの印刷機能で「PDFに保存」する。
// 行の区切りは原稿用紙の数え方（句読点・閉じ括弧のぶら下げ、開き括弧の行末禁則）に合わせる。

export const FORMATS = {
  a4_40x30: { label: '応募原稿（A4横・縦書き 40字×30行）', page: [297, 210], cols: 40, rows: 30, margin: [22, 22, 22, 22], grid: false, fold: 0 },
  a4_20x20: { label: 'A4横・縦書き 20字×20行（マス目なし）', page: [297, 210], cols: 20, rows: 20, margin: [26, 30, 26, 30], grid: false, fold: 0 },
  genko: { label: '原稿用紙（20字×20行・マス目つき）', page: [297, 210], cols: 20, rows: 20, margin: [30, 24, 26, 24], grid: true, fold: 12 },
};

const HANG = '、。，．」』）〕］｝〉》】’”';
const NO_LINE_END = '「『（〔［｛〈《【‘“';
const MM = 3.7795; // 1mm あたりの CSS px

// 1段落を「文字・ルビ付きの語・縦中横・傍点」の単位に分ける
export function tokenize(line, { ruby = true } = {}) {
  const units = [];
  const plain = (s, extra = {}) => { for (const ch of s) units.push({ t: ch, cells: 1, ...extra }); };
  if (!ruby) { plain(line); return units; }
  const re = /《《(.+?)》》|[|｜]([^|｜《\n]+?)《([^》\n]*?)》|([一-鿿々〆ヶ]+)《([^》\n]*?)》|(?<![0-9])([0-9]{2})(?![0-9])|([!?！？]{2})/gu;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    plain(line.slice(last, m.index));
    if (m[1] != null) plain(m[1], { em: true });
    else if (m[2] != null) units.push({ t: m[2], r: m[3], cells: [...m[2]].length });
    else if (m[4] != null) units.push({ t: m[4], r: m[5], cells: [...m[4]].length });
    else units.push({ t: m[6] ?? m[7], cells: 1, tcy: true });
    last = m.index + m[0].length;
  }
  plain(line.slice(last));
  return units;
}

// 単位の並びを1行 cols 字の行に分ける
export function breakLines(units, cols) {
  const lines = [];
  let cur = [], used = 0;
  for (let k = 0; k < units.length; k++) {
    let u = units[k];
    if (u.cells > cols) { // 1行より長いルビ付きの語は、ルビを外して1字ずつにする
      units.splice(k, 1, ...[...u.t].map((ch) => ({ t: ch, cells: 1 })));
      u = units[k];
    }
    if (used + u.cells > cols) {
      if (u.cells === 1 && used === cols && HANG.includes(u.t)) { // 句読点・閉じ括弧はぶら下げる
        cur.push(u);
        lines.push(cur);
        cur = [];
        used = 0;
        continue;
      }
      const carry = [];
      while (cur.length > 1 && NO_LINE_END.includes(cur[cur.length - 1].t)) carry.unshift(cur.pop()); // 開き括弧を行末に残さない
      lines.push(cur);
      cur = carry;
      used = carry.reduce((a, x) => a + x.cells, 0);
    }
    cur.push(u);
    used += u.cells;
  }
  if (cur.length || !lines.length) lines.push(cur); // ぶら下げで行が終わったときに空行を足さない（空の段落は1行）
  return lines;
}

// 原稿（章ごとの本文の並び）をページごとの行に分ける
export function layout(sources, { format = 'a4_40x30', ruby = true, chapterBreak = true } = {}) {
  const f = FORMATS[format];
  const pages = [];
  let lines = [];
  const flush = () => { pages.push(lines); lines = []; };
  sources.forEach((src, si) => {
    if (si > 0 && chapterBreak && lines.length) flush();
    const paras = src.text.replace(/\r/g, '').replace(/\n+$/, '').split('\n');
    for (const para of paras) {
      const body = para.replace(/^#{1,6}[ \t　]+/, '');
      for (const ln of breakLines(tokenize(body, { ruby }), f.cols)) {
        lines.push(ln);
        if (lines.length === f.rows) flush();
      }
    }
  });
  if (lines.length || !pages.length) flush();
  return pages;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function lineEl(units) {
  const line = el('div', 'pp-line');
  let buf = '';
  const flush = () => { if (buf) { line.append(buf); buf = ''; } };
  for (const u of units) {
    if (u.r != null) {
      flush();
      const r = el('ruby', null, u.t);
      r.append(el('rt', null, u.r));
      line.append(r);
    } else if (u.tcy) {
      flush();
      line.append(el('span', 'pp-tcy', u.t));
    } else if (u.em) {
      flush();
      line.append(el('em', 'pp-em', u.t));
    } else {
      buf += u.t;
    }
  }
  flush();
  return line;
}

// ページの要素を作る（画面のプレビューと印刷で同じものを使う）
export function renderPages(pages, { format = 'a4_40x30', cover = null, nombre = 'center' } = {}) {
  const f = FORMATS[format];
  const [pw, ph] = f.page;
  const [mt, mr, mb, ml] = f.margin;
  const height = ph - mt - mb;
  const width = pw - ml - mr - f.fold;
  const cell = height / f.cols;
  const pitch = width / f.rows;

  const root = el('div', `pp-root${f.grid ? ' pp-grid' : ''}`);
  root.style.setProperty('--pp-cell', `${cell}mm`);
  root.style.setProperty('--pp-pitch', `${pitch}mm`);
  root.style.setProperty('--pp-height', `${height}mm`);
  root.style.setProperty('--pp-fold', `${f.fold}mm`);

  const newPage = () => {
    const page = el('section', 'pp-page');
    page.style.width = `${pw}mm`;
    page.style.height = `${ph}mm`;
    return page;
  };

  if (cover) {
    const page = newPage();
    const box = el('div', 'pp-cover');
    box.append(el('div', 'pp-cover-title', cover.title || ''));
    if (cover.author) box.append(el('div', 'pp-cover-author', cover.author));
    if (cover.note) box.append(el('div', 'pp-cover-note', cover.note));
    page.append(box);
    root.append(page);
  }

  pages.forEach((lines, pi) => {
    const page = newPage();
    const body = el('div', 'pp-body');
    body.style.top = `${mt}mm`;
    body.style.right = `${mr}mm`;
    body.style.height = `${height}mm`;
    body.style.width = `${width + f.fold}mm`;
    const count = f.grid ? f.rows : lines.length;
    for (let li = 0; li < count; li++) {
      if (f.fold && li === f.rows / 2) body.append(el('div', 'pp-fold'));
      body.append(lineEl(lines[li] || []));
    }
    page.append(body);
    if (nombre !== 'none') {
      const no = el('div', `pp-nombre pp-nombre-${nombre}`, nombre === 'center' ? `- ${pi + 1} -` : `${pi + 1} / ${pages.length}`);
      no.style.bottom = `${Math.max(6, mb / 2 - 2)}mm`;
      page.append(no);
    }
    root.append(page);
  });
  return root;
}

// 画面いっぱいのプレビュー。「PDFに保存（印刷）」でブラウザの印刷を呼ぶ
export function openPreview(root, { format = 'a4_40x30', pages = 0, onClose } = {}) {
  document.getElementById('printPreview')?.remove();
  const f = FORMATS[format];
  const wrap = el('div');
  wrap.id = 'printPreview';
  const bar = el('div', 'pv-toolbar');
  const info = el('span', 'pv-info', `${pages}ページ（${f.label}）`);
  const printBtn = el('button', 'primary', 'PDFに保存（印刷）');
  const closeBtn = el('button', null, '閉じる');
  const hint = el('span', 'pv-hint', '印刷画面で「PDFに保存」を選ぶとPDFになります');
  bar.append(closeBtn, info, el('span', 'spacer'), hint, printBtn);
  wrap.append(bar, root);
  document.body.append(wrap);

  const fit = () => {
    const zoom = Math.min(1, (window.innerWidth - 32) / (f.page[0] * MM));
    root.style.zoom = String(zoom);
  };
  fit();
  window.addEventListener('resize', fit);

  const style = el('style');
  style.textContent = `@page { size: ${f.page[0]}mm ${f.page[1]}mm; margin: 0; }`;
  document.head.append(style);

  const close = () => {
    window.removeEventListener('resize', fit);
    style.remove();
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  closeBtn.onclick = close;
  printBtn.onclick = () => {
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  };
  printBtn.focus();
  return { close };
}

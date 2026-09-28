// 読書画面: 本棚（取り込んだ本の一覧）と、ページをめくって読む画面。
// 本は formats.js で章ごとの HTML にそろえて IndexedDB（books）に保存するので、オフラインで読める。
// ページ分けは CSS の段組み（1段 = 1ページ。横組みで画面が広いときは2段で見開き）で行い、
// 表示する位置を transform でずらす。行や文字が途中で切れない。
import * as db from './db.js';
import * as F from './formats.js';

const STATE_KEY = 'bookState'; // 本ごとの読んだ位置・しおり・縦横
const INDEX_KEY = 'bookIndex'; // 本棚の一覧（本文は books ストアに別に置く）

export function createBookView(app) {
  const { h } = app;
  const root = document.getElementById('bookView');
  const V = { book: null, ch: 0, page: 0, pages: 1, step: 1, pct: 0, vertical: false, immersive: false, busy: false, urls: new Map(), states: null };
  let stage = null;
  let flow = null;
  let foot = null;
  let relayoutTimer = 0;
  let saveTimer = 0;
  const ro = new ResizeObserver(() => { clearTimeout(relayoutTimer); relayoutTimer = setTimeout(relayout, 160); });

  const isOpen = () => !root.hidden;
  const reading = () => isOpen() && !!V.book;
  const focus = () => root.focus({ preventScroll: true });
  const states = async () => (V.states ??= await db.kvGet(STATE_KEY, {}));

  function saveState(now = false) {
    if (!V.book || !V.states) return;
    V.states[V.book.id] = { ...(V.states[V.book.id] || {}), ch: V.ch, ratio: V.pages > 1 ? V.page / V.pages : 0, pct: V.pct, vertical: V.vertical, opened: Date.now() };
    clearTimeout(saveTimer);
    if (now) db.kvSet(STATE_KEY, V.states);
    else saveTimer = setTimeout(() => db.kvSet(STATE_KEY, V.states), 500);
  }

  function revoke() {
    for (const u of V.urls.values()) URL.revokeObjectURL(u);
    V.urls.clear();
  }

  function close() {
    saveState(true);
    ro.disconnect();
    revoke();
    V.book = null;
    root.hidden = true;
    root.replaceChildren();
    app.onClose?.();
  }

  // ---------------------------------------------------------------- 本棚

  async function openLibrary() {
    if (V.book) saveState(true);
    ro.disconnect();
    revoke();
    V.book = null;
    root.hidden = false;
    root.tabIndex = -1;
    root.className = 'bk library';
    const index = await db.kvGet(INDEX_KEY, []);
    const st = await states();
    const cur = await app.currentDoc?.();
    const input = h('input', { type: 'file', accept: `${F.ACCEPT},.pdf`, multiple: true, hidden: true, onchange: (e) => importFiles([...e.target.files]) });
    const sorted = [...index].sort((a, b) => (st[b.id]?.opened || b.added) - (st[a.id]?.opened || a.added));
    const row = (b) => {
      const s = st[b.id];
      return h('div', { class: 'bk-book' },
        h('button', { class: 'bk-open', onclick: () => openStored(b.id) },
          h('span', { class: 't' }, b.title),
          h('span', { class: 'm' }, [b.author, F.FORMAT_LABEL[b.format] || b.format, s?.pct != null ? `${Math.round(s.pct * 100)}%` : '未読'].filter(Boolean).join('・'))),
        h('button', { class: 'bk-del', title: '本棚から外す', onclick: () => removeBook(b) }, '外す'));
    };
    root.replaceChildren(
      h('div', { class: 'bk-bar' },
        h('button', { onclick: close, title: '閉じる（Esc）' }, '← 戻る'),
        h('span', { class: 'bk-title' }, '本棚'),
        h('button', { class: 'primary', onclick: () => input.click() }, 'ファイルを開く'),
        input),
      h('div', { class: 'bk-lib' },
        cur ? h('section', {}, h('h3', {}, 'いま書いている原稿'),
          h('div', { class: 'bk-book' }, h('button', { class: 'bk-open', onclick: () => openCurrent() },
            h('span', { class: 't' }, `${cur.name}${cur.ext || ''}`),
            h('span', { class: 'm' }, '本のようにページをめくって読む（読むだけで、書き換えません）')))) : null,
        h('section', {}, h('h3', {}, `本棚${sorted.length ? `（${sorted.length}冊）` : ''}`),
          sorted.length ? sorted.map(row) : h('p', { class: 'hint' }, 'まだ本がありません。「ファイルを開く」から取り込むと、ここに並びます。')),
        h('p', { class: 'hint' }, '読める形式：Markdown（.md）・テキスト（.txt。青空文庫の注記とルビ、Shift_JIS にも対応）・HTML・EPUB（コピー防止のないもの）・Word（.docx）。取り込んだ本はこの端末に保存され、オフラインで読めます。パソコンでは、この画面にファイルをドラッグしても開けます。PDF はブラウザの PDF 表示で開きます（本棚には入りません）。')));
    focus();
  }

  async function importFiles(files) {
    let last = null;
    for (const file of files) {
      if (/\.pdf$/i.test(file.name)) { openPdf(file); continue; }
      try {
        app.toast(`「${file.name}」を読み込んでいます…`, 0);
        const book = await F.importFile(file);
        await db.put('books', book);
        const index = await db.kvGet(INDEX_KEY, []);
        index.push({ id: book.id, title: book.title, author: book.author, format: book.format, added: book.added, size: book.size, chapters: book.chapters.length });
        await db.kvSet(INDEX_KEY, index);
        last = book;
        app.toast(`「${book.title}」を本棚に入れました`, 2500);
      } catch (e) {
        app.toast(`「${file.name}」を開けません：${e.message}`, 7000);
      }
    }
    if (last) await openBook(last);
    else if (isOpen() && !V.book) await openLibrary();
  }

  function openPdf(file) {
    const url = URL.createObjectURL(file);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
    app.toast('PDF はブラウザの PDF 表示で開きました（本棚には入りません）', 4000);
  }

  async function removeBook(b) {
    if (!await app.confirmBox(`「${b.title}」を本棚から外しますか？（この端末に取り込んだ写しを消します。元のファイルは消えません）`, '外す', true)) return;
    await db.del('books', b.id);
    await db.kvSet(INDEX_KEY, (await db.kvGet(INDEX_KEY, [])).filter((x) => x.id !== b.id));
    const st = await states();
    delete st[b.id];
    await db.kvSet(STATE_KEY, st);
    await openLibrary();
  }

  async function openStored(id) {
    const book = await db.get('books', id);
    if (!book) { app.toast('本が見つかりません'); return; }
    await openBook(book);
  }

  async function openCurrent() {
    const cur = await app.currentDoc?.();
    if (!cur) { app.toast('開いている原稿がありません'); return; }
    await openBook({ ...F.docBook(cur), id: `doc:${cur.id}` }, { vertical: cur.vertical });
  }

  // ---------------------------------------------------------------- 読む

  async function openBook(book, opts = {}) {
    if (V.book) saveState(true);
    revoke();
    V.book = book;
    const s = (await states())[book.id] || {};
    V.vertical = s.vertical ?? opts.vertical ?? book.vertical ?? false;
    for (const [p, blob] of Object.entries(book.images || {})) V.urls.set(p, URL.createObjectURL(blob));
    build();
    await showChapter(Math.min(s.ch || 0, book.chapters.length - 1), { ratio: s.ratio || 0 });
  }

  function build() {
    root.hidden = false;
    root.tabIndex = -1;
    root.className = `bk reading ${V.vertical ? 'vertical' : 'horizontal'}${V.immersive ? ' immersive' : ''}`;
    stage = h('div', { class: 'bk-stage' });
    flow = h('div', { class: 'bk-flow md', lang: 'ja' });
    stage.append(flow);
    const slider = h('input', { type: 'range', min: '0', max: '0', value: '0', 'aria-label': 'この章のページ', oninput: (e) => go(+e.target.value) });
    foot = h('div', { class: 'bk-foot' }, h('span', { class: 'bk-chap' }), slider, h('span', { class: 'bk-pos' }));
    root.replaceChildren(
      h('div', { class: 'bk-bar' },
        h('button', { onclick: openLibrary, title: '本棚' }, '本棚'),
        h('span', { class: 'bk-title' }, V.book.title),
        h('button', { onclick: toc, title: '目次（T）' }, '目次'),
        h('button', { onclick: marks, title: 'しおり（B）' }, 'しおり'),
        h('button', { onclick: lookup, title: '選んだ語を辞書で引く（Alt+D）' }, '辞書'),
        h('button', { onclick: display, title: '表示（縦横・文字の大きさ・行間）' }, 'Aa'),
        h('button', { onclick: close, title: '閉じる（Esc）' }, '閉じる')),
      stage, foot);
    bindStage();
    ro.disconnect();
    ro.observe(stage);
    focus();
  }

  function layout() {
    const st = app.settings();
    const fs = st.bkFont || 18;
    const r = stage.getBoundingClientRect();
    const padX = Math.round(Math.max(16, Math.min(56, r.width * 0.05)));
    const padY = Math.round(Math.max(14, Math.min(40, r.height * 0.045)));
    const w = Math.max(120, Math.floor(r.width - padX * 2));
    const hgt = Math.max(120, Math.floor(r.height - padY * 2));
    const gap = V.vertical ? padY * 2 : padX * 2;
    const cols = !V.vertical && w > fs * 52 ? 2 : 1; // 横組みで画面が広いときは2段（見開き）
    const colW = V.vertical ? hgt : (w - gap * (cols - 1)) / cols;
    V.step = (V.vertical ? hgt : w) + gap;
    Object.assign(flow.style, {
      left: `${padX}px`, top: `${padY}px`, width: `${w}px`, height: `${hgt}px`,
      fontSize: `${fs}px`, lineHeight: String(st.bkLh || 1.9),
      columnWidth: `${colW}px`, columnGap: `${gap}px`,
    });
    flow.style.setProperty('--img-w', `${V.vertical ? Math.min(w, hgt) : colW}px`);
    flow.style.setProperty('--img-h', `${hgt}px`);
  }

  // 要素が何ページ目にあるか（段の位置から求める）
  function pageOf(el) {
    const f = flow.getBoundingClientRect();
    const r = el.getClientRects()[0] || el.getBoundingClientRect();
    const off = V.vertical ? r.top - f.top : r.left - f.left;
    return Math.max(0, Math.floor((off + 1) / V.step));
  }

  async function settle() {
    await document.fonts?.ready;
    const imgs = [...flow.querySelectorAll('img')];
    if (imgs.length) {
      await Promise.race([Promise.all(imgs.map((i) => i.decode().catch(() => {}))), new Promise((r) => setTimeout(r, 1500))]);
    }
    // 位置は getBoundingClientRect でその場で計算されるので、描画の順番（requestAnimationFrame）は待たない
    // （画面が隠れていると requestAnimationFrame は呼ばれず、止まってしまう）
  }

  async function showChapter(ch, { ratio = 0, last = false } = {}) {
    V.ch = ch;
    const c = V.book.chapters[ch];
    flow.style.transform = '';
    flow.innerHTML = `${c.html}<div class="bk-end"></div>`;
    for (const img of flow.querySelectorAll('img[data-bkimg]')) {
      const u = V.urls.get(img.dataset.bkimg);
      if (u) img.src = u;
      else img.replaceWith(img.alt ? `［${img.alt}］` : '');
    }
    if (V.vertical) F.addTcy(flow);
    layout();
    await settle();
    V.pages = pageOf(flow.querySelector('.bk-end')) + 1;
    go(last ? V.pages - 1 : Math.min(V.pages - 1, Math.round(ratio * V.pages)));
  }

  function go(n) {
    V.page = Math.max(0, Math.min(V.pages - 1, n));
    flow.style.transform = V.vertical ? `translateY(${-V.page * V.step}px)` : `translateX(${-V.page * V.step}px)`;
    const n2 = V.book.chapters.length;
    V.pct = (V.ch + (V.page + 1) / V.pages) / n2;
    foot.querySelector('.bk-chap').textContent = V.book.chapters[V.ch].title || V.book.title;
    const slider = foot.querySelector('input');
    slider.max = String(V.pages - 1);
    slider.value = String(V.page);
    slider.hidden = V.pages < 2;
    foot.querySelector('.bk-pos').textContent = `${V.page + 1}/${V.pages}ページ${n2 > 1 ? `（${V.ch + 1}/${n2}章）` : ''}・${Math.round(V.pct * 100)}%`;
    saveState();
  }

  async function next() {
    if (V.busy) return;
    if (V.page < V.pages - 1) { go(V.page + 1); return; }
    if (V.ch < V.book.chapters.length - 1) {
      V.busy = true;
      try { await showChapter(V.ch + 1); } finally { V.busy = false; }
      return;
    }
    app.toast('最後のページです', 1500);
  }

  async function prev() {
    if (V.busy) return;
    if (V.page > 0) { go(V.page - 1); return; }
    if (V.ch > 0) {
      V.busy = true;
      try { await showChapter(V.ch - 1, { last: true }); } finally { V.busy = false; }
      return;
    }
    app.toast('最初のページです', 1500);
  }

  // 画面の大きさ・文字の大きさが変わったら、同じあたりのページを開き直す
  async function relayout() {
    if (!reading() || V.busy) return;
    const ratio = V.pages > 1 ? V.page / V.pages : 0;
    layout();
    await settle();
    V.pages = pageOf(flow.querySelector('.bk-end')) + 1;
    go(Math.min(V.pages - 1, Math.round(ratio * V.pages)));
  }

  function bindStage() {
    let sx = 0;
    let sy = 0;
    let st = 0;
    stage.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; st = Date.now(); });
    stage.addEventListener('pointerup', (e) => {
      if (e.target.closest('a')) return;
      if (String(getSelection()).trim()) return; // 文字を選んでいるときはめくらない
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { // スワイプ
        if (V.vertical ? dx > 0 : dx < 0) next(); else prev();
        return;
      }
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10 || Date.now() - st > 600) return;
      const r = stage.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      if (x < 0.3) { if (V.vertical) next(); else prev(); } // 縦組みは左をさわると次のページ
      else if (x > 0.7) { if (V.vertical) prev(); else next(); }
      else toggleImmersive();
    });
    let wheelAt = 0;
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const now = Date.now();
      if (now - wheelAt < 250) return;
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : (V.vertical ? -e.deltaX : e.deltaX);
      if (Math.abs(d) < 4) return;
      wheelAt = now;
      if (d > 0) next(); else prev();
    }, { passive: false });
  }

  function toggleImmersive() {
    V.immersive = !V.immersive;
    root.classList.toggle('immersive', V.immersive); // 大きさが変わるので ResizeObserver が組み直す
  }

  async function toc() {
    const v = await app.menu('目次', V.book.chapters.map((c, i) => [`${i === V.ch ? '▶ ' : ''}${c.title || `（${i + 1}）`}`, String(i)]));
    if (v != null) await showChapter(+v);
  }

  // いまのページの最初の文（しおりの名前にする）
  function snippet() {
    for (const el of flow.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td')) {
      if (!el.textContent.trim()) continue;
      const f = flow.getBoundingClientRect();
      for (const r of el.getClientRects()) {
        const off = V.vertical ? r.top - f.top : r.left - f.left;
        if (Math.floor((off + 1) / V.step) === V.page) {
          const c = el.cloneNode(true);
          for (const x of c.querySelectorAll('rt, rp')) x.remove();
          const t = c.textContent.replace(/\s+/g, '').trim();
          return [...t].length > 22 ? `${[...t].slice(0, 22).join('')}…` : t;
        }
      }
    }
    return '';
  }

  async function marks() {
    const st = await states();
    const s = (st[V.book.id] ||= {});
    const list = s.marks || [];
    const v = await app.menu('しおり', [
      ['このページにしおりを挟む', 'add', 'primary'],
      ...list.map((m, i) => [m.label, `go:${i}`]),
      list.length ? ['しおりを外す…', 'del'] : null,
    ]);
    if (v === 'add') {
      const chapter = V.book.chapters[V.ch].title || V.book.title;
      list.push({ ch: V.ch, ratio: V.page / V.pages, label: `${chapter}・${Math.round(V.pct * 100)}%「${snippet()}」`, at: Date.now() });
      s.marks = list;
      saveState(true);
      app.toast('しおりを挟みました', 1500);
    } else if (v?.startsWith('go:')) {
      const m = list[+v.slice(3)];
      if (m) await showChapter(Math.min(m.ch, V.book.chapters.length - 1), { ratio: m.ratio });
    } else if (v === 'del') {
      const d = await app.menu('外すしおり', list.map((m, i) => [m.label, String(i)]));
      if (d != null) { list.splice(+d, 1); s.marks = list; saveState(true); }
    }
  }

  function lookup() {
    const q = String(getSelection()).trim();
    app.lookup(q.slice(0, 30));
  }

  async function display() {
    for (;;) {
      const st = app.settings();
      const v = await app.menu('表示', [
        [V.vertical ? '横書きで読む' : '縦書きで読む', 'dir'],
        [`文字を大きく（いま ${st.bkFont || 18}px）`, 'big'],
        ['文字を小さく', 'small'],
        [`行間を広く（いま ${(st.bkLh || 1.9).toFixed(1)}）`, 'wide'],
        ['行間を狭く', 'narrow'],
      ]);
      if (!v) return;
      if (v === 'dir') {
        const ratio = V.pages > 1 ? V.page / V.pages : 0;
        V.vertical = !V.vertical;
        build();
        await showChapter(V.ch, { ratio });
        continue;
      }
      if (v === 'big') st.bkFont = Math.min(40, (st.bkFont || 18) + 1);
      if (v === 'small') st.bkFont = Math.max(12, (st.bkFont || 18) - 1);
      if (v === 'wide') st.bkLh = Math.min(2.6, Math.round(((st.bkLh || 1.9) + 0.1) * 10) / 10);
      if (v === 'narrow') st.bkLh = Math.max(1.4, Math.round(((st.bkLh || 1.9) - 0.1) * 10) / 10);
      app.saveSettings();
      await relayout();
    }
  }

  async function fontStep(d) {
    const st = app.settings();
    st.bkFont = Math.max(12, Math.min(40, (st.bkFont || 18) + d));
    app.saveSettings();
    await relayout();
  }

  // 読書中のキー。true を返したら、ほかのショートカットには回さない
  function handleKey(e) {
    if (!V.book) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
      return false;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    const map = {
      ArrowLeft: V.vertical ? next : prev,
      ArrowRight: V.vertical ? prev : next,
      ArrowDown: next, PageDown: next, ArrowUp: prev, PageUp: prev,
      ' ': e.shiftKey ? prev : next,
      Home: () => go(0), End: () => go(V.pages - 1),
      Escape: close, t: toc, b: marks, '+': () => fontStep(1), ';': () => fontStep(1), '-': () => fontStep(-1),
    };
    const fn = map[e.key];
    if (fn) { e.preventDefault(); fn(); return true; }
    if (e.key.length === 1) { e.preventDefault(); return true; } // 裏の原稿に文字が入らないように
    return false;
  }

  return { open: openLibrary, openCurrent, importFiles, close, isOpen, handleKey, focus };
}

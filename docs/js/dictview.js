// 紙の辞書のように「引く」「眺める」画面。
// 紙面の作り（縦組みの段組み・柱・つめ・【表記】〘品詞〙①②）は国語辞典（広辞苑など）を参考にしている。
// 中身は端末に取り込んだオフライン辞書（ウィクショナリー日本語版・日本語WordNet）。
import * as db from './db.js';
import * as Dict from './dict.js';

const TSUME = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ'];
const ROWS = ['あいうえお', 'かきくけこ', 'さしすせそ', 'たちつてと', 'なにぬねの', 'はひふへほ', 'まみむめも', 'やゆよ', 'らりるれろ', 'わゐゑをん'];
const MAX_PER_PAGE = 240; // 紙面の大きさが測れないときに、全語を読み込み続けないための上限
const GOOD_POS = new Set(['名', '動', '形', '形動', '副', '句', '諺', '連体', '接続', '感']);
const mark = (n) => (n < 20 ? String.fromCharCode(0x2460 + n) : `(${n + 1})`); // ①〜⑳
const POS_ABBR = {
  名詞: '名', 動詞: '動', 形容動詞: '形動', 副詞: '副', 成句: '句', 形容詞: '形', 接尾辞: '接尾', 感動詞: '感',
  接頭辞: '接頭', 略語: '略', 代名詞: '代', 助詞: '助', 接続詞: '接続', 助動詞: '助動', 連体詞: '連体', ことわざ: '諺',
};

const fmt = (n) => n.toLocaleString('ja-JP');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const vkey = (r) => `${r.k}|${r.h || ''}`;
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
function hashStr(s) {
  let x = 2166136261;
  for (const c of s) { x ^= c.codePointAt(0); x = Math.imul(x, 16777619); }
  return x >>> 0;
}

export function createDictView(app) {
  const { h, toast } = app;
  const root = document.getElementById('dictView');
  const V = { built: false, open: false, ready: false, busy: false, start: 0, end: 0, total: 0, hit: -1, rows: new Map(), vocab: [], vocabKeys: new Set(), history: [] };
  const els = {};
  const vertical = () => app.settings().dvVertical !== false;

  // ---- 画面の組み立て

  function build() {
    els.search = h('input', { type: 'search', class: 'dv-search', placeholder: 'よみ（ひらがな）で開く／言葉で引く', enterkeyhint: 'search' });
    els.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runSearch(els.search.value); }
    });
    els.search.addEventListener('input', () => {
      clearTimeout(V.searchTimer);
      const q = els.search.value.trim();
      if (/^[ぁ-ゖァ-ヺー]+$/.test(q)) V.searchTimer = setTimeout(() => runSearch(q, true), 350);
    });
    els.dirBtn = h('button', { class: 'opt', onclick: toggleDir });
    els.hashFirst = h('span');
    els.hashLast = h('span');
    els.page = h('div', { class: 'dv-page' });
    els.tsume = h('nav', { class: 'dv-tsume', 'aria-label': 'つめ' }, TSUME.map((c) => h('button', { onclick: () => jumpBase(c, false), title: `${c}行を開く` }, c)));
    els.msg = h('div', { class: 'dv-msg', hidden: true });
    els.side = h('aside', { class: 'dv-side', hidden: true });
    els.card = h('div', { class: 'dv-card-wrap', hidden: true, onclick: (e) => { if (e.target === els.card) closeCard(); } });
    els.left = h('button');
    els.right = h('button');
    els.pos = h('span');
    els.today = h('span', { class: 'dv-today' });

    root.replaceChildren(
      h('header', { class: 'dv-bar' },
        h('button', { onclick: close, title: '閉じる（Esc）' }, '← 戻る'),
        els.search,
        h('button', { onclick: showToday, title: '今日の言葉（T）' }, '今日の言葉'),
        h('button', { onclick: randomPage, title: 'パッと開く（R）' }, 'パッと開く'),
        h('button', { onclick: () => showVocab(), title: '単語帳（B）' }, '単語帳'),
        h('button', { class: 'opt', onclick: showHistory }, '履歴'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'opt', onclick: () => zoom(-1), title: '文字を小さく' }, 'A−'),
        h('button', { class: 'opt', onclick: () => zoom(1), title: '文字を大きく' }, 'A＋'),
        h('button', { class: 'opt', onclick: cycleCols, title: '段数を変える' }, '段数'),
        els.dirBtn,
        h('button', { class: 'narrow-only', onclick: displayMenu, title: '紙面の表示' }, '⋯')),
      h('div', { class: 'dv-hashira' }, els.hashFirst, els.hashLast),
      h('div', { class: 'dv-body' }, els.page, els.tsume, els.msg, els.side),
      h('footer', { class: 'dv-foot' }, els.left, h('span', { class: 'dv-mid' }, els.pos, els.today), els.right),
      els.card);

    // スワイプでページをめくる（縦組みは右へ払うと次のページ）
    let sx = 0, sy = 0, st = 0;
    els.page.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; st = Date.now(); });
    els.page.addEventListener('pointerup', (e) => {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5 || Date.now() - st > 800) return;
      V.swiped = true;
      setTimeout(() => { V.swiped = false; }, 60);
      ((vertical() ? dx > 0 : dx < 0) ? next : prev)();
    });
    els.page.addEventListener('click', (e) => {
      if (V.swiped) return;
      const el = e.target.closest('.de');
      if (el) openCard(V.rows.get(+el.dataset.i));
    });
    window.addEventListener('resize', () => {
      if (!V.open) return;
      applyStyle(); // 画面の向きや大きさが変わったら段数・ボタンの表記も合わせ直す
      if (V.ready) { V.history = []; renderForward(V.start); }
    });
    V.built = true;
  }

  function applyStyle() {
    const st = app.settings();
    const v = vertical();
    root.classList.toggle('vertical', v);
    root.classList.toggle('horizontal', !v);
    root.style.setProperty('--dv-fs', `${st.dvFont || 15}px`);
    root.style.setProperty('--dv-cols', String(columns()));
    els.dirBtn.textContent = v ? '横組み' : '縦組み';
    const narrow = window.innerWidth < 560;
    const [l, r] = v
      ? [[narrow ? '‹ 次' : '‹ 次のページ', next], [narrow ? '前 ›' : '前のページ ›', prev]]
      : [[narrow ? '‹ 前' : '‹ 前のページ', prev], [narrow ? '次 ›' : '次のページ ›', next]];
    els.left.textContent = l[0];
    els.left.onclick = l[1];
    els.right.textContent = r[0];
    els.right.onclick = r[1];
  }

  // 段数。「自動」（0）のときは紙面の大きさと文字の大きさから、1段に12字（横組みは22字）以上入る数にする
  function columns() {
    const st = app.settings();
    const fs = st.dvFont || 15;
    const gap = fs * 1.8;
    if (st.dvCols) return vertical() ? st.dvCols : Math.max(1, st.dvCols - 1);
    const r = els.page.getBoundingClientRect();
    if (!r.width || !r.height) return vertical() ? 3 : 2;
    return vertical()
      ? Math.max(1, Math.min(4, Math.floor((r.height + gap) / (fs * 12 + gap))))
      : Math.max(1, Math.min(3, Math.floor((r.width + gap) / (fs * 22 + gap))));
  }

  // ---- 開く・閉じる

  async function open(query) {
    if (!V.built) build();
    root.hidden = false;
    V.open = true;
    if (document.activeElement?.id === 'editor') document.activeElement.blur();
    applyStyle();
    V.vocab = await db.kvGet('vocab', []);
    V.vocabKeys = new Set(V.vocab.map(vkey));
    const info = await Dict.browseInfo();
    if (!info) { showInstall(); return; }
    V.total = info.entries;
    V.ready = true;
    els.msg.hidden = true;
    if (query?.trim()) {
      els.search.value = query.trim();
      await runSearch(query);
    } else {
      V.history = [];
      await renderForward(Math.min(await db.kvGet('dv.pos', 0), V.total - 1));
    }
  }

  function close() {
    root.hidden = true;
    V.open = false;
    closeCard();
    app.onClose?.();
  }

  async function showInstall() {
    V.ready = false;
    els.page.replaceChildren();
    els.hashFirst.textContent = els.hashLast.textContent = els.pos.textContent = els.today.textContent = '';
    const dict = await Dict.dictInfo();
    const published = await Dict.publishedDict();
    const mb = (b) => (b / 1048576).toFixed(1);
    const size = published ? (dict ? published.browse?.bytes || 0 : published.shards.reduce((a, s) => a + s.bytes, 0) + (published.browse?.bytes || 0)) : 0;
    const progress = h('progress', { max: '1', value: '0', hidden: true });
    const status = h('p', { class: 'hint' });
    const btn = h('button', {
      class: 'primary', disabled: !published?.browse,
      onclick: async () => {
        btn.disabled = true;
        progress.hidden = false;
        try {
          await (dict ? Dict.installBrowse : Dict.installDict)((label, done, total) => {
            progress.max = total || 1;
            progress.value = done;
            status.textContent = `${label} ${mb(done)} / ${mb(total)} MB`;
          });
          open();
        } catch (e) {
          status.textContent = `失敗しました：${e.message}`;
          btn.disabled = false;
        }
      },
    }, dict ? '紙面データを取り込む' : '辞書を取り込む');
    els.msg.hidden = false;
    els.msg.replaceChildren(...[
      h('h2', {}, '紙の辞書のように、引く・眺める'),
      h('p', {}, `${dict ? '五十音順の紙面データ' : '辞書と紙面のデータ'}（約${mb(size)}MB）を一度だけ取り込むと、オフラインで使えます。`),
      published ? null : h('p', { class: 'hint' }, 'オフラインのため、取り込めるデータを確認できません。Wi‑Fi につないでから開き直してください。'),
      btn, progress, status].filter(Boolean));
  }

  // ---- 紙面（1ページに入るだけ見出しを詰める）

  // 紙面の最後の語が枠の外（段組みのあふれ）に出たか。scrollHeight は段組みのあふれを1段遅れて報告することがあるので、
  // 語の実際の位置（段ごとの断片の矩形）で判定する
  const overflow = () => {
    const last = els.page.lastElementChild;
    if (!last) return false;
    const pr = els.page.getBoundingClientRect();
    for (const r of last.getClientRects()) {
      if (r.bottom > pr.bottom + 1 || r.top < pr.top - 1 || r.right > pr.right + 1 || r.left < pr.left - 1) return true;
    }
    return false;
  };

  function entryEl(r) {
    V.rows.set(r.i, r);
    return h('div', { class: `de${r.i === V.hit ? ' hit' : ''}`, 'data-i': String(r.i) },
      h('span', { class: 'de-y' }, r.y),
      r.h ? h('span', { class: 'de-h' }, `【${r.h}】`) : null,
      r.p ? h('span', { class: 'de-p' }, `〘${r.p}〙`) : null,
      h('span', { class: 'de-d' }, r.d),
      V.vocabKeys.has(vkey(r)) ? h('span', { class: 'de-mark', title: '単語帳に入っています' }, '★') : null);
  }

  async function renderForward(start) {
    if (V.busy || !V.total) return;
    V.busy = true;
    start = Math.max(0, Math.min(start, V.total - 1));
    const page = els.page;
    page.style.visibility = 'hidden';
    page.replaceChildren();
    V.rows.clear();
    let i = start, last = start - 1;
    try {
      outer: while (i < V.total && page.childElementCount < MAX_PER_PAGE) {
        const rows = await db.getRange('browse', i, Math.min(V.total - 1, i + 24));
        if (!rows.length) break;
        for (const r of rows) {
          const el = entryEl(r);
          page.append(el);
          if (overflow() && page.childElementCount > 1) { el.remove(); V.rows.delete(r.i); break outer; }
          last = r.i;
          if (overflow()) break outer;
        }
        i = last + 1;
      }
      V.start = start;
      V.end = last + 1;
      afterRender();
    } finally {
      page.style.visibility = '';
      V.busy = false;
    }
  }

  async function renderBackward(end) {
    if (V.busy) return;
    V.busy = true;
    const page = els.page;
    page.style.visibility = 'hidden';
    page.replaceChildren();
    V.rows.clear();
    let i = end - 1, first = end, full = false;
    try {
      outer: while (i >= 0) {
        if (page.childElementCount >= MAX_PER_PAGE) { full = true; break; }
        const rows = (await db.getRange('browse', Math.max(0, i - 24), i)).reverse();
        if (!rows.length) break;
        for (const r of rows) {
          const el = entryEl(r);
          page.prepend(el);
          if (overflow() && page.childElementCount > 1) { el.remove(); V.rows.delete(r.i); full = true; break outer; }
          first = r.i;
          if (overflow()) { full = true; break outer; }
        }
        i = first - 1;
      }
    } finally {
      page.style.visibility = '';
      V.busy = false;
    }
    if (!full) { await renderForward(0); return; } // 最初のページまで戻った
    V.start = first;
    V.end = end;
    afterRender();
  }

  function afterRender() {
    const label = (r) => (r ? `${r.y}${r.h ? `【${r.h.split('・')[0]}】` : ''}` : '');
    const first = V.rows.get(V.start);
    els.hashFirst.textContent = label(first);
    els.hashLast.textContent = label(V.rows.get(V.end - 1));
    els.pos.textContent = `${fmt(V.start + 1)}〜${fmt(V.end)}語目／${fmt(V.total)}語`;
    const row = ROWS.findIndex((s) => s.includes(first?.b?.[0]));
    els.tsume.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === row));
    db.kvSet('dv.pos', V.start);
    countViewed(V.start, V.end);
  }

  async function countViewed(s, e) {
    let st = await db.kvGet('dv.stats', null);
    if (!st || st.date !== today()) st = { date: today(), pages: {} };
    st.pages[s] = e - s;
    await db.kvSet('dv.stats', st);
    els.today.textContent = `今日眺めた語 ${fmt(Object.values(st.pages).reduce((a, b) => a + b, 0))}`;
  }

  // めくってきたページの先頭を覚えておき、戻るときは同じページをそのまま出す（組み直すと区切りがずれるため）
  function next() {
    if (!V.ready || V.end >= V.total) return;
    V.hit = -1;
    V.history.push(V.start);
    renderForward(V.end);
  }
  function prev() {
    if (!V.ready || V.start <= 0) return;
    V.hit = -1;
    const back = V.history.pop();
    if (back != null && back < V.start) renderForward(back);
    else renderBackward(V.start);
  }
  async function showAt(i) {
    V.hit = i;
    V.history = [];
    await renderForward(Math.max(0, i - 2));
  }

  async function jumpBase(base, highlight = true) {
    if (!V.ready) return null;
    const r = await db.firstFrom('browse', 'b', base);
    const match = r && r.b.startsWith(base);
    V.hit = highlight && match ? r.i : -1;
    V.history = [];
    await renderForward(r ? Math.max(0, r.i - (V.hit >= 0 ? 2 : 0)) : V.total - 1);
    return match ? r : null;
  }

  async function randomPage() {
    if (!V.ready) return;
    V.hit = -1;
    V.history = [];
    await renderForward(Math.floor(Math.random() * V.total));
  }

  // ---- 引く

  async function runSearch(q, live = false) {
    q = q.trim();
    if (!q || !V.ready) return;
    if (/^[ぁ-ゖァ-ヺー]+$/.test(q)) {
      const base = Dict.baseOf(q);
      // 並べ替え用の読み（清音にそろえたもの）で候補を集め、入力と同じ読みの語があればそのページを開く
      const cands = await db.getIndexRange('browse', 'b', base, `${base}￿`, 60);
      const pool = cands.length >= 60 ? await db.getIndexRange('browse', 'b', base, `${base}￿`, 400) : cands;
      const exact = pool.find((r) => toHira(r.y) === toHira(q));
      const target = exact || pool[0];
      if (target) { await showAt(target.i); } else { await jumpBase(base); }
      showSide(`「${q}」で始まる語`, pool.slice(0, 80), exact ? null
        : (pool.length ? `「${q}」と同じ読みの語はありません。近い語を示しています。` : 'この読みの語は見つかりませんでした。近いページを開いています。'));
      if (!live && exact) openCard(exact);
      return;
    }
    const res = await Dict.lookup(q);
    const items = [];
    const seen = new Set();
    const push = (r) => { const key = `${r.k}|${r.h}|${r.i}`; if (!seen.has(key)) { seen.add(key); items.push(r); } };
    for (const e of res.entries) {
      const rows = await db.getByIndex('browse', 'k', e.k, 5);
      if (rows.length) rows.forEach(push);
      else push({ i: null, k: e.k, y: e.r?.[0] || '', h: e.k, p: '', d: (e.e.find((x) => x[2]?.length)?.[2][0] || '').split('　例：')[0].slice(0, 60) });
    }
    for (const k of res.near.slice(0, 20)) (await db.getByIndex('browse', 'k', k, 1)).forEach(push);
    showSide(`「${q}」`, items, items.length ? (res.base ? `「${res.base}」の形で調べました。` : null) : '見つかりませんでした。');
    const first = items[0];
    if (first) {
      if (first.i != null) await showAt(first.i);
      openCard(first);
    }
  }

  function showSide(title, items, note = null, extra = null) {
    els.side.hidden = false;
    els.side.replaceChildren(...[
      h('div', { class: 'dv-side-head' }, h('strong', {}, title), h('button', { onclick: () => { els.side.hidden = true; }, title: '閉じる' }, '×')),
      note ? h('p', { class: 'hint' }, note) : null,
      extra,
      h('div', { class: 'dv-side-list' }, items.map((r) => h('button', {
        class: 'dv-item',
        onclick: async () => { if (r.i != null) await showAt(r.i); openCard(r); },
      },
      h('span', { class: 'dv-item-y' }, r.y || r.k, r.h ? `【${r.h}】` : '', r.known ? ' ✓' : ''),
      h('span', { class: 'dv-item-d' }, r.d || ''))))].filter(Boolean));
  }

  // ---- 語義カード

  async function openCard(r, label = null) {
    if (!r) return;
    addHistory(r);
    const row = await db.get('dict', r.k);
    const body = [];
    for (const [src, pos, defs, syns, ants] of row?.e || []) {
      body.push(h('div', { class: 'dv-sense' },
        h('div', { class: 'dv-sense-head' },
          pos ? h('span', { class: 'de-p' }, `〘${POS_ABBR[pos] || pos}〙`) : null,
          h('span', { class: 'badge' }, src === 'N' ? 'WordNet' : 'ウィクショナリー')),
        defs?.length ? h('ol', {}, defs.map((d, n) => {
          const [text, ex] = d.split('　例：');
          return h('li', {}, h('span', { class: 'dv-num' }, mark(n)), text, ex ? h('span', { class: 'dv-ex' }, `「${ex}」`) : null);
        })) : null,
        syns?.length ? h('div', { class: 'chips' }, h('span', { class: 'hint' }, '類 '), syns.slice(0, 30).map(chip)) : null,
        ants?.length ? h('div', { class: 'chips' }, h('span', { class: 'hint' }, '対 '), ants.map(chip)) : null));
    }
    if (!body.length) body.push(h('p', {}, r.d || '（語義はありません）'));

    const inVocab = () => V.vocab.find((v) => vkey(v) === vkey(r));
    const vocabBtn = h('button', { class: 'primary' });
    const knownBtn = h('button');
    const refresh = () => {
      const v = inVocab();
      vocabBtn.textContent = v ? '★ 単語帳から外す' : '☆ 単語帳に入れる';
      knownBtn.hidden = !v;
      knownBtn.textContent = v?.known ? '「覚える」に戻す' : '覚えた';
    };
    vocabBtn.onclick = async () => { await toggleVocab(r); refresh(); };
    knownBtn.onclick = async () => {
      const v = inVocab();
      if (!v) return;
      v.known = !v.known;
      await db.kvSet('vocab', V.vocab);
      refresh();
    };
    refresh();
    const word = r.h ? r.h.split('・')[0] : (r.y || r.k);
    els.card.replaceChildren(h('div', { class: 'dv-card', role: 'dialog', 'aria-label': word },
      label ? h('div', { class: 'dv-card-label' }, label) : null,
      h('div', { class: 'dv-card-head' },
        h('span', { class: 'dv-card-y' }, r.y || r.k),
        r.h ? h('span', { class: 'dv-card-h' }, `【${r.h}】`) : null,
        r.p ? h('span', { class: 'de-p' }, `〘${r.p}〙`) : null),
      h('button', { class: 'dv-card-close', onclick: closeCard, title: '閉じる（Esc）' }, '×'),
      h('div', { class: 'dv-card-body' }, body),
      h('div', { class: 'row' },
        vocabBtn, knownBtn,
        h('button', { onclick: () => { closeCard(); close(); app.insert(word); } }, '本文に挿入'),
        r.i != null && !(r.i >= V.start && r.i < V.end) ? h('button', { onclick: () => { closeCard(); showAt(r.i); } }, '紙面で見る') : null),
      h('div', { class: 'links' }, Dict.ONLINE.map(([name, url]) => h('a', { href: url(word), target: '_blank', rel: 'noopener' }, name)))));
    els.card.hidden = false;
    els.card.querySelector('.dv-card-close').focus();
  }

  const chip = (w) => h('button', { class: 'chip', onclick: () => { closeCard(); els.search.value = w; runSearch(w); } }, w);

  function closeCard() {
    if (els.card) els.card.hidden = true;
  }

  // ---- 今日の言葉・履歴・単語帳

  async function showToday() {
    if (!V.ready) return;
    const seed = hashStr(today());
    let pick = null;
    for (let t = 0; t < 80 && !pick; t++) {
      const r = await db.get('browse', (seed + t * 7919) % V.total);
      if (r && r.h && /[一-鿿]/.test(r.h) && [...r.h].length >= 2 && GOOD_POS.has(r.p) && r.d.length >= 10) pick = r;
    }
    const d = new Date();
    openCard(pick || await db.get('browse', seed % V.total), `今日の言葉（${d.getMonth() + 1}月${d.getDate()}日）`);
  }

  async function addHistory(r) {
    const list = (await db.kvGet('dv.history', [])).filter((x) => vkey(x) !== vkey(r));
    list.unshift({ k: r.k, i: r.i, y: r.y, h: r.h, p: r.p, d: r.d });
    await db.kvSet('dv.history', list.slice(0, 50));
  }

  async function showHistory() {
    const list = await db.kvGet('dv.history', []);
    showSide('最近開いた言葉', list, list.length ? null : 'まだありません。');
  }

  async function toggleVocab(r) {
    const i = V.vocab.findIndex((v) => vkey(v) === vkey(r));
    if (i >= 0) V.vocab.splice(i, 1);
    else V.vocab.unshift({ k: r.k, i: r.i, y: r.y, h: r.h, p: r.p, d: r.d, added: Date.now(), known: false });
    V.vocabKeys = new Set(V.vocab.map(vkey));
    await db.kvSet('vocab', V.vocab);
    toast(i >= 0 ? '単語帳から外しました' : '単語帳に入れました', 1500);
    const el = els.page.querySelector(`[data-i="${r.i}"]`);
    if (el) el.replaceWith(entryEl(r));
  }

  function showVocab(filter = 'learning') {
    const learning = V.vocab.filter((v) => !v.known);
    const known = V.vocab.filter((v) => v.known);
    const tabs = h('div', { class: 'row' },
      h('button', { class: filter === 'learning' ? 'primary' : '', onclick: () => showVocab('learning') }, `覚える ${learning.length}`),
      h('button', { class: filter === 'known' ? 'primary' : '', onclick: () => showVocab('known') }, `覚えた ${known.length}`),
      h('button', { onclick: startQuiz, disabled: !learning.length }, '確認テスト'),
      h('button', { onclick: () => app.exportVocab(V.vocab), disabled: !V.vocab.length }, 'Obsidianへ書き出す'));
    showSide('単語帳', filter === 'known' ? known : learning,
      V.vocab.length ? null : '紙面や検索で語を開き、「☆ 単語帳に入れる」を押すと、ここに集まります。', tabs);
  }

  function startQuiz() {
    const pool = V.vocab.filter((v) => !v.known);
    if (!pool.length) { closeCard(); toast('「覚える」の語はもうありません'); showVocab(); return; }
    const v = pool[Math.floor(Math.random() * pool.length)];
    const answer = h('div', { class: 'dv-quiz-a', hidden: true },
      h('div', { class: 'dv-quiz-yomi' }, v.y, v.p ? ` 〘${v.p}〙` : ''),
      h('p', {}, v.d));
    const after = h('div', { class: 'row dv-quiz-after', hidden: true },
      h('button', { class: 'primary', onclick: async () => { v.known = true; v.reviews = (v.reviews || 0) + 1; await db.kvSet('vocab', V.vocab); startQuiz(); } }, '覚えた'),
      h('button', { onclick: async () => { v.reviews = (v.reviews || 0) + 1; await db.kvSet('vocab', V.vocab); startQuiz(); } }, 'まだ'),
      h('button', { onclick: () => openCard(v) }, 'くわしく'));
    const reveal = h('button', { class: 'primary dv-quiz-reveal', onclick: () => { answer.hidden = false; after.hidden = false; reveal.hidden = true; after.querySelector('button').focus(); } }, '意味を見る');
    els.card.replaceChildren(h('div', { class: 'dv-card dv-quiz', role: 'dialog' },
      h('div', { class: 'dv-card-label' }, `確認テスト（のこり ${pool.length}語）`),
      h('button', { class: 'dv-card-close', onclick: closeCard, title: '閉じる（Esc）' }, '×'),
      h('div', { class: 'dv-quiz-q' }, v.h ? v.h.split('・')[0] : v.y),
      h('p', { class: 'hint' }, v.h ? '読みと意味は？' : '意味は？'),
      reveal, answer, after));
    els.card.hidden = false;
    reveal.focus();
  }

  // ---- 表示の切り替え

  function toggleDir() {
    app.settings().dvVertical = !vertical();
    app.saveSettings();
    applyStyle();
    if (V.ready) { V.history = []; renderForward(V.start); }
  }

  function zoom(d) {
    const st = app.settings();
    st.dvFont = Math.max(11, Math.min(28, (st.dvFont || 15) + d));
    app.saveSettings();
    applyStyle();
    if (V.ready) { V.history = []; renderForward(V.start); }
  }

  function cycleCols() {
    const st = app.settings();
    st.dvCols = ((st.dvCols || 0) + 1) % 5; // 自動 → 1 → 2 → 3 → 4 → 自動
    app.saveSettings();
    applyStyle();
    if (V.ready) { V.history = []; renderForward(V.start); }
    toast(st.dvCols ? `${columns()}段にしました` : `段数は自動（いまは${columns()}段）`, 1500);
  }

  async function displayMenu() {
    const st = app.settings();
    const v = await app.menu('紙面の表示', [
      [vertical() ? '横組みにする' : '縦組みにする', 'dir'],
      [`段数を変える（いま ${st.dvCols ? `${columns()}段` : `自動・${columns()}段`}）`, 'cols'],
      ['文字を大きく', 'bigger'],
      ['文字を小さく', 'smaller'],
      ['最近開いた言葉', 'history'],
    ]);
    ({ dir: toggleDir, cols: cycleCols, bigger: () => zoom(1), smaller: () => zoom(-1), history: showHistory })[v]?.();
  }

  // ---- キー操作（辞書を開いている間は、本文用のショートカットを止める）

  function handleKey(e) {
    if (!V.open) return false;
    if (e.isComposing || e.keyCode === 229) return true;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!els.card.hidden) closeCard();
      else if (!els.side.hidden) els.side.hidden = true;
      else close();
      return true;
    }
    if (e.target?.id === 'editor') { e.preventDefault(); e.target.blur(); return true; }
    if (e.target === els.search || !els.card.hidden) return true;
    if (e.ctrlKey || e.altKey || e.metaKey) {
      if (e.ctrlKey && e.code === 'KeyF') { e.preventDefault(); els.search.focus(); els.search.select(); }
      return true;
    }
    const v = vertical();
    const moves = { ArrowLeft: v ? next : prev, ArrowRight: v ? prev : next, ArrowDown: next, ArrowUp: prev, PageDown: next, PageUp: prev, ' ': e.shiftKey ? prev : next };
    if (moves[e.key] && !e.target.closest?.('.dv-side')) { e.preventDefault(); moves[e.key](); return true; }
    const actions = { Slash: () => { els.search.focus(); els.search.select(); }, KeyT: showToday, KeyR: randomPage, KeyB: () => showVocab() };
    if (actions[e.code]) { e.preventDefault(); actions[e.code](); }
    return true;
  }

  return { open, close, isOpen: () => V.open, handleKey };
}

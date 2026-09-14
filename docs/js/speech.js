// 読み上げ推敲: 端末の音声合成（Android の「テキスト読み上げ」・Windows の音声）で、本文を文ごとに読み上げる。
// 長い文は一度に渡すと途中で止まる端末があるため、文（長ければ読点）ごとに区切って順に読む。

const MAX_CHARS = 160;

// 声の調子。端末の音声合成で変えられるのは「声の種類・高さ・速さ」と、文や読点のあとの「間」だけなので、その組み合わせで作る。
// calm: 感嘆符を句点として読ませ、抑揚を抑える
export const VOICE_STYLES = {
  standard: { label: 'ふつう', short: 'ふつう', pitch: 1, rate: 1, sentenceGap: 0, commaGap: 0, preferMale: false, calm: false },
  calm: { label: '静かな低音（冷静で知的な語り）', short: '静かな低音', pitch: 0.72, rate: 0.88, sentenceGap: 520, commaGap: 200, preferMale: true, calm: true },
  soft: { label: 'やわらかい語り', short: 'やわらか', pitch: 0.96, rate: 0.93, sentenceGap: 320, commaGap: 110, preferMale: false, calm: false },
};

export const styleOf = (key) => VOICE_STYLES[key] || VOICE_STYLES.standard;

// 読み上げ用の文: 見出し記号を外し、ルビは読みで読む
export function toSpeech(s, { calm = false } = {}) {
  let t = s
    .replace(/^#{1,6}[ \t　]+/, '')
    .replace(/《《(.+?)》》/g, '$1')
    .replace(/[|｜]([^|｜《\n]+?)《([^》\n]*?)》/g, '$2')
    .replace(/([一-鿿々〆ヶ]+)《([^》\n]*?)》/g, '$2')
    .replace(/[―─]{2,}|…{2,}|・{3,}/g, '、')
    .replace(/^[　\s]+/, '')
    .trim();
  if (calm) t = t.replace(/[！!]+/g, '。');
  return t;
}

// 本文を読み上げの単位に分ける。start/end は本文中の位置（読んでいる所へ移動するのに使う）。
// kind: sentence（文の終わり）／comma（読点で区切った途中）／para（段落の終わり）。種類ごとに後ろの間を変える
export function sentences(text, from = 0, to = text.length, { splitComma = false, calm = false } = {}) {
  const out = [];
  const re = /[^。！？!?\n]*[。！？!?]*[」』）]*\n?/g;
  re.lastIndex = from;
  let m;
  while (re.lastIndex < to && (m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    const s = m.index;
    const e = Math.min(to, s + m[0].length);
    const kind = text[e - 1] === '\n' ? 'para' : 'sentence';
    let offset = s;
    let piece = text.slice(s, e);
    for (;;) {
      let cut = splitComma ? piece.search(/[、，]/) : -1;
      if (cut < 0 && [...piece].length > MAX_CHARS) { // 長すぎる文は読点（なければ文字数）で分ける
        const c = piece.lastIndexOf('、', MAX_CHARS);
        cut = c > 20 ? c : MAX_CHARS - 1;
      }
      if (cut < 0 || cut >= piece.length - 1) break;
      pushSentence(out, text, offset, offset + cut + 1, 'comma', calm);
      piece = piece.slice(cut + 1);
      offset += cut + 1;
    }
    pushSentence(out, text, offset, e, kind, calm);
  }
  return out;
}

function pushSentence(out, text, s, e, kind, calm) {
  const say = toSpeech(text.slice(s, e), { calm });
  if (/[\p{L}\p{N}]/u.test(say)) out.push({ start: s, end: e, say, kind });
}

export const supported = () => 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

export function japaneseVoices() {
  if (!supported()) return [];
  return speechSynthesis.getVoices().filter((v) => /^ja/i.test(v.lang));
}

// 男性の声の名前によくある文字列（Android: ja-jp-x-jac／jad、Windows: Ichiro／Keita など）
// （"female" に含まれる "male" を拾わないよう、前が英字でないときだけ一致させる）
const MALE_VOICE = /男性|(?<![a-z])male|jac|jad|ichiro|keita|takumi/i;

export function pickVoice(voiceURI, style) {
  const voices = japaneseVoices();
  return voices.find((v) => v.voiceURI === voiceURI)
    || (style.preferMale && voices.find((v) => MALE_VOICE.test(`${v.name} ${v.voiceURI}`)))
    || voices.find((v) => v.default)
    || voices[0]
    || null;
}

// 読み上げの進行を管理する。一時停止は「その文の頭から読み直す」方式（端末による pause の不具合を避ける）
export function createReader({ onSentence, onState } = {}) {
  const R = {
    queue: [], index: 0, playing: false, current: null, timer: 0,
    rate: 1, voiceURI: '', style: VOICE_STYLES.standard, pitchAdjust: 0, pauseScale: 1,
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const clearTimer = () => { clearTimeout(R.timer); R.timer = 0; };
  const gapFor = (item) => {
    const base = item.kind === 'comma' ? R.style.commaGap : item.kind === 'para' ? R.style.sentenceGap * 1.6 : R.style.sentenceGap;
    return Math.round(base * R.pauseScale);
  };

  const speakCurrent = () => {
    clearTimer();
    if (!R.playing) return;
    if (R.index >= R.queue.length) {
      R.playing = false;
      onState?.('end', R);
      return;
    }
    const item = R.queue[R.index];
    const u = new SpeechSynthesisUtterance(item.say);
    u.lang = 'ja-JP';
    u.rate = clamp(R.rate * R.style.rate, 0.5, 2);
    u.pitch = clamp(R.style.pitch + R.pitchAdjust, 0.1, 2);
    const voice = pickVoice(R.voiceURI, R.style);
    if (voice) u.voice = voice;
    const next = () => {
      if (u !== R.current || !R.playing) return;
      R.index++;
      const gap = gapFor(item);
      if (gap > 0) R.timer = setTimeout(speakCurrent, gap);
      else speakCurrent();
    };
    u.onstart = () => onSentence?.(item, R.index, R.queue.length);
    u.onend = next;
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') next(); };
    R.current = u;
    speechSynthesis.speak(u);
  };

  const restartCurrent = () => {
    R.current = null;
    clearTimer();
    speechSynthesis.cancel();
    if (R.playing) speakCurrent();
  };

  const options = (o) => {
    for (const k of ['rate', 'voiceURI', 'style', 'pitchAdjust', 'pauseScale']) if (o[k] !== undefined) R[k] = o[k];
  };

  return {
    state: R,
    start(queue, opts = {}) {
      speechSynthesis.cancel();
      clearTimer();
      options(opts);
      Object.assign(R, { queue, index: 0, playing: true, current: null });
      onState?.('play', R);
      speakCurrent();
    },
    // 読み上げ中に速さ・声・調子などを変えたら、いまの文の頭から読み直す
    configure(opts) {
      options(opts);
      restartCurrent();
    },
    pause() {
      R.playing = false;
      R.current = null;
      clearTimer();
      speechSynthesis.cancel();
      onState?.('pause', R);
    },
    resume() {
      if (!R.queue.length) return;
      if (R.index >= R.queue.length) R.index = 0;
      R.playing = true;
      onState?.('play', R);
      speakCurrent();
    },
    stop() {
      R.playing = false;
      R.current = null;
      R.queue = [];
      clearTimer();
      speechSynthesis.cancel();
      onState?.('stop', R);
    },
    skip(delta) {
      if (!R.queue.length) return;
      R.index = Math.max(0, Math.min(R.queue.length - 1, R.index + delta));
      R.current = null;
      clearTimer();
      speechSynthesis.cancel();
      if (R.playing) speakCurrent();
      else onSentence?.(R.queue[R.index], R.index, R.queue.length);
    },
    setRate(rate) { this.configure({ rate }); },
    setVoice(voiceURI) { this.configure({ voiceURI }); },
  };
}

// 読み上げ推敲: 端末の音声合成（Android の「テキスト読み上げ」・Windows の音声）で、本文を文ごとに読み上げる。
// 長い文は一度に渡すと途中で止まる端末があるため、文（長ければ読点）ごとに区切って順に読む。

const MAX_CHARS = 160;

// 読み上げ用の文: 見出し記号を外し、ルビは読みで読む
export function toSpeech(s) {
  return s
    .replace(/^#{1,6}[ \t　]+/, '')
    .replace(/《《(.+?)》》/g, '$1')
    .replace(/[|｜]([^|｜《\n]+?)《([^》\n]*?)》/g, '$2')
    .replace(/([一-鿿々〆ヶ]+)《([^》\n]*?)》/g, '$2')
    .replace(/[―─]{2,}|…{2,}|・{3,}/g, '、')
    .replace(/^[　\s]+/, '')
    .trim();
}

// 本文を文に分ける。start/end は本文中の位置（読んでいる文へ移動するのに使う）
export function sentences(text, from = 0, to = text.length) {
  const out = [];
  const re = /[^。！？!?\n]*[。！？!?]*[」』）]*\n?/g;
  re.lastIndex = from;
  let m;
  while (re.lastIndex < to && (m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    const s = m.index;
    const e = Math.min(to, s + m[0].length);
    let piece = text.slice(s, e);
    let offset = s;
    while ([...piece].length > MAX_CHARS) { // 長すぎる文は読点で分ける
      const cut = piece.lastIndexOf('、', MAX_CHARS);
      const at = cut > 20 ? cut + 1 : MAX_CHARS;
      pushSentence(out, text, offset, offset + at);
      piece = piece.slice(at);
      offset += at;
    }
    pushSentence(out, text, offset, e);
  }
  return out;
}

function pushSentence(out, text, s, e) {
  const say = toSpeech(text.slice(s, e));
  if (/[\p{L}\p{N}]/u.test(say)) out.push({ start: s, end: e, say });
}

export const supported = () => 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

export function japaneseVoices() {
  if (!supported()) return [];
  return speechSynthesis.getVoices().filter((v) => /^ja/i.test(v.lang));
}

// 読み上げの進行を管理する。一時停止は「その文の頭から読み直す」方式（端末による pause の不具合を避ける）
export function createReader({ onSentence, onState } = {}) {
  const R = { queue: [], index: 0, playing: false, rate: 1, voiceURI: '' };

  const speakCurrent = () => {
    if (!R.playing) return;
    if (R.index >= R.queue.length) {
      R.playing = false;
      onState?.('end', R);
      return;
    }
    const item = R.queue[R.index];
    const u = new SpeechSynthesisUtterance(item.say);
    u.lang = 'ja-JP';
    u.rate = R.rate;
    const voice = japaneseVoices().find((v) => v.voiceURI === R.voiceURI);
    if (voice) u.voice = voice;
    u.onstart = () => onSentence?.(item, R.index, R.queue.length);
    u.onend = () => {
      if (u !== R.current || !R.playing) return;
      R.index++;
      speakCurrent();
    };
    u.onerror = (e) => {
      if (u !== R.current || !R.playing) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      R.index++;
      speakCurrent();
    };
    R.current = u;
    speechSynthesis.speak(u);
  };

  return {
    state: R,
    start(queue, { rate = 1, voiceURI = '' } = {}) {
      speechSynthesis.cancel();
      Object.assign(R, { queue, index: 0, playing: true, rate, voiceURI });
      onState?.('play', R);
      speakCurrent();
    },
    pause() {
      R.playing = false;
      R.current = null;
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
      speechSynthesis.cancel();
      onState?.('stop', R);
    },
    skip(delta) {
      if (!R.queue.length) return;
      R.index = Math.max(0, Math.min(R.queue.length - 1, R.index + delta));
      R.current = null;
      speechSynthesis.cancel();
      if (R.playing) speakCurrent();
      else onSentence?.(R.queue[R.index], R.index, R.queue.length);
    },
    setRate(rate) {
      R.rate = rate;
      if (R.playing) { R.current = null; speechSynthesis.cancel(); speakCurrent(); }
    },
    setVoice(voiceURI) {
      R.voiceURI = voiceURI;
      if (R.playing) { R.current = null; speechSynthesis.cancel(); speakCurrent(); }
    },
  };
}

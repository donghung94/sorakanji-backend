'use strict';
/**
 * furigana.js — Japanese -> reading (hiragana) + romaji, via kuromoji.js.
 *
 * kuromoji is a pure-JS MeCab port: no external service, no API key.
 * The dictionary (~40 MB in node_modules/kuromoji/dict) ships with the
 * function bundle. Tokenizer build takes ~1 s and ~400 MB RSS on first
 * (cold) use, then the instance is cached in module scope across warm
 * invocations — hence the function is configured with 1 GiB memory.
 *
 * Alternatives considered (see README):
 *   - kuroshiro: same kuromoji engine underneath, heavier, no benefit here.
 *   - wanakana: kana conversion only — cannot read kanji, so no furigana.
 *   - MeCab as a service / Yahoo API: external dependency + key + latency.
 *
 * Known limits (documented, not hidden):
 *   - Numbers: kuromoji gives no reading for bare digits ("1" in "1ヶ月").
 *     A small best-effort counter table below covers 1-10 + common counters
 *     (ヶ月/日/人/年/時/分/円/個/本/冊/枚/歳/階) and 19xx/20xx years.
 *     Anything outside it falls back to on'yomi digit-by-digit reading,
 *     which may be wrong for irregular counters — flagged in `warnings`.
 *   - Rendaku / irregular readings of names and rare words can be wrong;
 *     the lesson UI must show furigana as machine-generated and reviewable.
 */

const path = require('node:path');
const { kataToHira, kanaToRomaji } = require('./romaji');

const ONYOMI = ['れい', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];

// Counter readings for values 1-10, as [digit part, counter part] pairs.
// e.g. 1ヶ月 = いっ + かげつ, 3日 = みっ + か, 2人 = ふた + り.
// Prefix-type counters also carry `base` so values 11-99 can be built from
// twoDigitReading + a sokuon-tail rule (e.g. 20ヶ月 = にじゅっかげつ).
function prefixParts(base, prefixes) {
  return prefixes.map((p) => [p, base]);
}
const COUNTERS = {
  'ヶ月': { base: 'かげつ', parts: prefixParts('かげつ', ['いっ', 'に', 'さん', 'よん', 'ご', 'ろっ', 'なな', 'はち', 'きゅう', 'じゅっ']) },
  '日': { parts: [['つい', 'たち'], ['ふ', 'つか'], ['みっ', 'か'], ['よっ', 'か'], ['いつ', 'か'], ['むい', 'か'], ['なの', 'か'], ['よう', 'か'], ['ここ', 'のか'], ['とお', 'か']] },
  '人': { parts: [['ひと', 'り'], ['ふた', 'り'], ['さん', 'にん'], ['よん', 'にん'], ['ご', 'にん'], ['ろく', 'にん'], ['なな', 'にん'], ['はち', 'にん'], ['きゅう', 'にん'], ['じゅう', 'にん']] },
  '年': { base: 'ねん', parts: prefixParts('ねん', ONYOMI.slice()) },
  '月': { base: 'がつ', parts: [['いち', 'がつ'], ['に', 'がつ'], ['さん', 'がつ'], ['し', 'がつ'], ['ご', 'がつ'], ['ろく', 'がつ'], ['しち', 'がつ'], ['はち', 'がつ'], ['く', 'がつ'], ['じゅう', 'がつ']] },
  '時': { base: 'じ', parts: [['いち', 'じ'], ['に', 'じ'], ['さん', 'じ'], ['よ', 'じ'], ['ご', 'じ'], ['ろく', 'じ'], ['しち', 'じ'], ['はち', 'じ'], ['く', 'じ'], ['じゅう', 'じ']] },
  '分': { parts: [['いっ', 'ぷん'], ['に', 'ふん'], ['さん', 'ぷん'], ['よん', 'ぷん'], ['ご', 'ふん'], ['ろっ', 'ぷん'], ['なな', 'ふん'], ['はち', 'ぷん'], ['きゅう', 'ふん'], ['じゅっ', 'ぷん']] },
  '円': { base: 'えん', parts: prefixParts('えん', ONYOMI.slice()) },
  '個': { base: 'こ', parts: prefixParts('こ', ONYOMI.slice()) },
  '本': { parts: [['いっ', 'ぽん'], ['に', 'ほん'], ['さん', 'ぼん'], ['よん', 'ほん'], ['ご', 'ほん'], ['ろっ', 'ぽん'], ['なな', 'ほん'], ['はっ', 'ぽん'], ['きゅう', 'ほん'], ['じゅっ', 'ぽん']] },
  '冊': { base: 'さつ', parts: prefixParts('さつ', ONYOMI.slice()) },
  '枚': { base: 'まい', parts: prefixParts('まい', ONYOMI.slice()) },
  '歳': { base: 'さい', parts: prefixParts('さい', ['いっ', 'に', 'さん', 'よん', 'ご', 'ろっ', 'なな', 'はち', 'きゅう', 'じゅっ']) },
  '階': { base: 'かい', parts: prefixParts('かい', ['いっ', 'に', 'さん', 'よん', 'ご', 'ろっ', 'なな', 'はち', 'きゅう', 'じゅっ']) },
  '週間': { base: 'しゅうかん', parts: prefixParts('しゅうかん', ONYOMI.slice()) },
};

function twoDigitReading(n) {
  if (n < 10) return ONYOMI[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return (tens === 1 ? 'じゅう' : `${ONYOMI[tens]}じゅう`) + (ones === 0 ? '' : ONYOMI[ones]);
}

// Round hundreds / thousands / ten-thousands: 100 ひゃく, 300 さんびゃく,
// 1000 せん, 3000 さんぜん, 10000 いちまん.
const ROUND_NUMBERS = {
  100: 'ひゃく', 200: 'にひゃく', 300: 'さんびゃく', 400: 'よんひゃく', 500: 'ごひゃく',
  600: 'ろっぴゃく', 700: 'ななひゃく', 800: 'はっぴゃく', 900: 'きゅうひゃく',
  1000: 'せん', 2000: 'にせん', 3000: 'さんぜん', 4000: 'よんせん', 5000: 'ごせん',
  6000: 'ろくせん', 7000: 'ななせん', 8000: 'はっせん', 9000: 'きゅうせん',
  10000: 'いちまん',
};

// Before a k/s/t/p-row counter sound, いち/ろく/はち/じゅう/ひゃく gain a
// sokuon: 1ヶ月 いっかげつ, 20ヶ月 にじゅっかげつ, 100ヶ月 ひゃっかげつ.
const SOKUON_TAILS = [['いち', 'いっ'], ['ろく', 'ろっ'], ['はち', 'はっ'], ['じゅう', 'じゅっ'], ['ひゃく', 'ひゃっ']];
function applySokuonTail(reading, counterBase) {
  if (!/^[かきくけこさしすせそたちつてとぱぴぷぺぽ]/.test(counterBase)) return reading;
  for (const [from, to] of SOKUON_TAILS) {
    if (reading.endsWith(from)) return reading.slice(0, -from.length) + to;
  }
  return reading;
}

/**
 * Best-effort reading for a bare digit token followed by a counter.
 * Returns { digit, counter } (hiragana parts; counter may be null when
 * there is no counter token) or null when no rule applies.
 */
function readNumber(value, nextSurface) {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  // Years first: 2026年 = にせんにじゅうろくねん (must run before the
  // generic 年 counter below, which only covers 1-10 + 11-99).
  if (nextSurface === '年' && /^(19|20)\d\d$/.test(value)) {
    const yy = Number(value.slice(2));
    const head = value.startsWith('19') ? 'せんきゅうひゃく' : 'にせん';
    return { digit: head + twoDigitReading(yy), counter: 'ねん' };
  }
  const counter = COUNTERS[nextSurface];
  if (counter) {
    if (n >= 1 && n <= 10) {
      const [digit, counterPart] = counter.parts[n - 1];
      return { digit, counter: counterPart };
    }
    if (counter.base && n >= 11 && n <= 99) {
      return { digit: applySokuonTail(twoDigitReading(n), counter.base), counter: counter.base };
    }
    if (counter.base && ROUND_NUMBERS[n]) {
      return { digit: applySokuonTail(ROUND_NUMBERS[n], counter.base), counter: counter.base };
    }
    return null; // outside the table: caller falls back + warns
  }
  // Standalone round number (no counter): 100 -> ひゃく, 1000 -> せん.
  if (ROUND_NUMBERS[n]) return { digit: ROUND_NUMBERS[n], counter: null };
  return null;
}

// ---------------------------------------------------------------------------
// Tokenizer (lazy singleton, cached across warm invocations)
// ---------------------------------------------------------------------------
let tokenizerPromise = null;

function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      // eslint-disable-next-line global-require
      const kuromoji = require('kuromoji');
      const dicPath = path.join(
        path.dirname(require.resolve('kuromoji/package.json')),
        'dict'
      );
      kuromoji.builder({ dicPath }).build((err, tokenizer) => {
        if (err) reject(err);
        else resolve(tokenizer);
      });
    });
  }
  return tokenizerPromise;
}

/** hiragana reading for one kuromoji token (or null when unknowable). */
function tokenReading(token, nextToken, override) {
  if (override !== undefined) return override;
  const surface = token.surface_form;
  if (token.reading && token.reading !== '*') {
    // Katakana loanwords (スイス, アルプス) are already phonetic: keep the
    // surface as-is. Only kanji get a hiragana reading.
    if (/[一-鿿々]/.test(surface)) return kataToHira(token.reading);
    return surface;
  }
  // Bare digits: try the counter table, else generic on'yomi (caller warns).
  if (/^\d+$/.test(surface)) {
    const r = readNumber(surface, nextToken ? nextToken.surface_form : null);
    return r ? r.digit : null;
  }
  // Symbols / latin / unknown: no reading.
  return null;
}

// Words where a final は is pronounced "wa" (particle は inside one token).
// Romaji follows the app's existing lesson data: 実は -> "jitsu wa" (two
// words), こんにちは -> "konnichiwa" (one word, standard Hepburn).
const WA_WORDS = new Map([
  ['実は', 'jitsu wa'],
  ['こんにちは', 'konnichiwa'],
  ['こんばんは', 'konbanwa'],
  ['では', 'de wa'],
  ['とは', 'to wa'],
  ['には', 'ni wa'],
  ['へは', 'e wa'],
  ['からは', 'kara wa'],
]);

/** Romaji for one token, looking ahead so a trailing っ doubles correctly. */
function tokenRomaji(reading, nextReading, surface) {
  if (!reading) return null;
  if (surface && WA_WORDS.has(surface)) return WA_WORDS.get(surface);
  let hira = kataToHira(reading);
  if (!hira.endsWith('っ')) return kanaToRomaji(hira);
  const stem = hira.slice(0, -1);
  const nextFirst = nextReading ? kataToHira(nextReading)[0] : null;
  const doubled = nextFirst ? kanaToRomaji(nextFirst) : '';
  const firstConsonant = doubled.startsWith('ch') ? 't' : doubled[0] || '';
  return kanaToRomaji(stem) + firstConsonant;
}

/**
 * Annotate one Japanese sentence.
 * Returns { reading, romaji, tokens, warnings }.
 *   reading: full hiragana sentence (e.g. スイスでなにをしましたか？)
 *   romaji:  Hepburn, words spaced (e.g. suisu de nani wo shimashita ka?)
 *   tokens:  [{ surface, reading (hiragana|null), pos }]
 *   warnings: e.g. numbers outside the counter table.
 */
async function annotateLine(jp) {
  const tokenizer = await getTokenizer();
  const rawTokens = tokenizer.tokenize(jp);
  // Merge runs of consecutive digit tokens: kuromoji splits "2026" into
  // "20" + "26", but a year is one number (2026年 = にせんにじゅうろくねん).
  const raw = [];
  for (const t of rawTokens) {
    const last = raw[raw.length - 1];
    if (last && /^\d+$/.test(last.surface_form) && /^\d+$/.test(t.surface_form)) {
      last.surface_form += t.surface_form;
    } else {
      raw.push({ ...t });
    }
  }
  // Number + counter overrides: the digit token takes the digit part and
  // the counter token takes the counter part (1ヶ月 -> いっ + かげつ).
  const overrides = new Map();
  for (let i = 0; i + 1 < raw.length; i += 1) {
    if (/^\d+$/.test(raw[i].surface_form) && COUNTERS[raw[i + 1].surface_form]) {
      const r = readNumber(raw[i].surface_form, raw[i + 1].surface_form);
      if (r) {
        overrides.set(i, r.digit);
        if (r.counter) overrides.set(i + 1, r.counter);
      }
    }
  }
  const tokens = [];
  const warnings = [];
  for (let i = 0; i < raw.length; i += 1) {
    const t = raw[i];
    const next = raw[i + 1] || null;
    let reading = tokenReading(t, next, overrides.get(i));
    if (reading === null && /^\d+$/.test(t.surface_form)) {
      warnings.push(`Số "${t.surface_form}" nằm ngoài bảng đếm — đọc theo âm Hán Việt từng chữ số, có thể chưa chuẩn.`);
      reading = t.surface_form.split('').map((d) => ONYOMI[Number(d)]).join('');
    }
    if (reading === null) reading = t.surface_form; // symbols / latin: keep as-is
    tokens.push({ surface: t.surface_form, reading, pos: t.pos });
  }

  const reading = tokens.map((t) => t.reading).join('');

  // Romaji: token by token, particle-aware, with smart spacing.
  // Spacing follows the app's existing lesson data, e.g.:
  //   "suisu de nani wo shimashita ka?" / "tsukaimasen deshita" /
  //   "suisu-jin na node" / "ikkagetsu gurai imashita."
  // Tokens attach (no space) when they form one spoken word:
  //   - sokuon continuation (prev reading ends with っ)
  //   - digit + counter (1 + ヶ月 -> ikkagetsu) and digit joins (11月3日)
  //   - prefix (お + 金 -> okane) / suffix (… + たち)
  //   - auxiliary verb after a verb stem (し + まし + た -> shimashita),
  //     EXCEPT the copula family (です/だ/でし/な/なら/じゃ/だろ), which
  //     starts a new word ("takai desu", "suisu-jin na node")
  //   - たり/だり, て/で (te-form), ながら after a verb/adjective
  //   - two consecutive nouns join with a hyphen ("suisu-jin")
  const COPULA = new Set(['です', 'だ', 'でし', 'でしょ', 'な', 'なら', 'じゃ', 'だろ']);
  const parts = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = tokens[i + 1] || null;
    let roma;
    if (t.pos === '助詞' && t.surface === 'は') roma = 'wa';
    else if (t.pos === '助詞' && t.surface === 'へ') roma = 'e';
    else if (t.pos === '助詞' && t.surface === 'を') roma = 'wo';
    else roma = tokenRomaji(t.reading, next ? next.reading : null, t.surface);
    if (roma === null) roma = t.surface;
    parts.push({ roma, reading: t.reading, surface: t.surface, pos: t.pos });
  }
  let romaji = '';
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    const prev = parts[i - 1];
    if (i === 0) {
      romaji += p.roma;
      continue;
    }
    const isPunct = /^[、。？！…」』）]$/.test(p.surface);
    const prevIsOpenPunct = /^[「『（]$/.test(prev.surface);
    const prevEndsSokuon = kataToHira(prev.reading).endsWith('っ');
    const prevIsNumberWithCounter = /^\d+$/.test(prev.surface) && COUNTERS[p.surface];
    const prevIsPrefix = prev.pos === '接頭詞';
    const curIsSuffix = p.pos === '接尾辞';
    const curIsAuxAttach = p.pos === '助動詞' && !COPULA.has(p.surface);
    const curIsTari = p.surface === 'たり' || p.surface === 'だり';
    const curIsTeForm =
      (p.surface === 'て' || p.surface === 'で') &&
      p.pos === '助詞' &&
      (prev.pos === '動詞' || prev.pos === '形容詞');
    const curIsNagara = p.surface === 'ながら' && (prev.pos === '動詞' || prev.pos === '形容詞');
    const digitJoin = /^\d+$/.test(prev.surface) || /^\d+$/.test(p.surface);
    const nounCompound =
      prev.pos === '名詞' && p.pos === '名詞' && !prevIsNumberWithCounter && !digitJoin;
    if (nounCompound) {
      romaji += `-${p.roma}`;
    } else if (
      isPunct ||
      prevIsOpenPunct ||
      prevEndsSokuon ||
      prevIsNumberWithCounter ||
      digitJoin ||
      prevIsPrefix ||
      curIsSuffix ||
      curIsAuxAttach ||
      curIsTari ||
      curIsTeForm ||
      curIsNagara
    ) {
      romaji += p.roma;
    } else {
      romaji += ` ${p.roma}`;
    }
  }
  // Tidy punctuation spacing: "ka ?" -> "ka?", "takai ," -> "takai,".
  romaji = romaji
    .replace(/ ([、。？！…])/g, '$1')
    .replace(/。/g, '.')
    .replace(/、/g, ',')
    .replace(/？/g, '?')
    .replace(/！/g, '!')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();

  return { reading, romaji, tokens, warnings };
}

/** Annotate many lines; never throws — failures fall back to null fields. */
async function annotateLines(lines) {
  try {
    await getTokenizer();
  } catch (err) {
    return lines.map((l) => ({
      ...l,
      reading: null,
      romaji: null,
      tokens: null,
      furiganaWarning: `Không tạo được furigana: ${err.message}`,
    }));
  }
  const out = [];
  for (const line of lines) {
    try {
      const a = await annotateLine(line.jp);
      out.push({ ...line, reading: a.reading, romaji: a.romaji, tokens: a.tokens, furiganaWarning: a.warnings.join(' ') || null });
    } catch {
      out.push({ ...line, reading: null, romaji: null, tokens: null, furiganaWarning: 'Không tạo được furigana cho câu này.' });
    }
  }
  return out;
}

module.exports = { annotateLine, annotateLines, getTokenizer, readNumber, COUNTERS };

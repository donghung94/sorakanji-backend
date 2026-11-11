'use strict';
/**
 * romaji.js — kana (hiragana/katakana) -> Hepburn romaji, no macrons.
 *
 * Style matches the lesson data the app already ships:
 *   スイスで何をしましたか？ -> "suisu de nani wo shimashita ka?"
 *   - おう -> "ou", うう -> "uu", いい -> "ii" (no macrons)
 *   - を -> "wo", は (particle) -> "wa", へ (particle) -> "e"
 *   - っち -> "tchi" (matcha, kitchiri), っし -> "sshi", っつ -> "ttsu"
 *   - ん before a vowel or y -> "n'" (hon'yaku)
 *   - ぢ -> "ji", づ -> "zu"
 *
 * The main entry works on a plain kana string. Token-aware callers
 * (furigana.js) use kanaToRomaji per token and override particle readings.
 */

const BASIC = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'wi', ゑ: 'we', を: 'wo', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ゔ: 'vu',
};

const YOON = {
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho',
  にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
  みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
  ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo',
  ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
};

const KATA_TO_HIRA_OFFSET = 0x60; // ァ (U+30A1) -> ぁ (U+3041)

function kataToHira(s) {
  return s.replace(/[ァ-ン]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - KATA_TO_HIRA_OFFSET));
}

function hiraToKata(s) {
  return s.replace(/[ぁ-ん]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + KATA_TO_HIRA_OFFSET));
}

/** Convert one hiragana (or katakana) string to romaji, no spaces inserted. */
function kanaToRomaji(input) {
  const s = kataToHira(input);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1] || '';
    // Long vowel mark: repeat the previous vowel (コーヒー -> koohii).
    if (ch === 'ー') {
      const vowels = out.match(/[aeiou]/g);
      if (vowels) out += vowels[vowels.length - 1];
      i += 1;
      continue;
    }
    // Small tsu (sokuon): double the next consonant.
    if (ch === 'っ') {
      const pair = YOON[s.slice(i + 1, i + 3)];
      if (pair) {
        out += pair.startsWith('ch') ? 't' : pair[0];
        i += 1;
        continue;
      }
      const r = BASIC[next];
      if (r) {
        out += r.startsWith('ch') ? 't' : r[0];
      }
      i += 1;
      continue;
    }
    // Yoon (contracted sound): two kana -> one syllable.
    const pair = YOON[s.slice(i, i + 2)];
    if (pair) {
      out += pair;
      i += 2;
      continue;
    }
    // ん: n' before a vowel or a y-row kana.
    if (ch === 'ん') {
      const after = s[i + 1] || '';
      out += after && 'あいうえおやゆよ'.includes(after) ? "n'" : 'n';
      i += 1;
      continue;
    }
    const r = BASIC[ch];
    if (r !== undefined) {
      out += r;
      i += 1;
      continue;
    }
    // Punctuation / anything else: keep as-is.
    out += ch;
    i += 1;
  }
  return out;
}

module.exports = { kanaToRomaji, kataToHira, hiraToKata, BASIC, YOON };

/** Tamil script helpers for the voice pipeline. */

export const TAMIL_RE = /[஀-௿]/;
export const hasTamil = (s: string) => TAMIL_RE.test(s);

const CONSONANT: Record<string, string> = {
  'க': 'k', 'ங': 'ng', 'ச': 's', 'ஞ': 'nj', 'ட': 'd', 'ண': 'n', 'த': 'th', 'ந': 'n', 'ப': 'p', 'ம': 'm',
  'ய': 'y', 'ர': 'r', 'ல': 'l', 'வ': 'v', 'ழ': 'zh', 'ள': 'l', 'ற': 'r', 'ன': 'n',
  'ஜ': 'j', 'ஷ': 'sh', 'ஸ': 's', 'ஹ': 'h', 'ஶ': 'sh',
};
const VOWEL: Record<string, string> = {
  'அ': 'a', 'ஆ': 'a', 'இ': 'i', 'ஈ': 'i', 'உ': 'u', 'ஊ': 'u', 'எ': 'e', 'ஏ': 'e', 'ஐ': 'ai', 'ஒ': 'o', 'ஓ': 'o', 'ஔ': 'au',
};
const SIGN: Record<string, string> = {
  'ா': 'a', 'ி': 'i', 'ீ': 'i', 'ு': 'u', 'ூ': 'u', 'ெ': 'e', 'ே': 'e', 'ை': 'ai', 'ொ': 'o', 'ோ': 'o', 'ௌ': 'au', '்': '',
};

/**
 * Rough phonetic Tamil -> Latin, used only to find candidate names (party and item names are
 * stored in English, but Tamil speech recognition writes them in Tamil script):
 * "ராஜேஷ் டிரேடர்ஸ்" -> "rajesh diredars". Latin text passes through unchanged.
 */
export function transliterate(s: string): string {
  let out = '';
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch in CONSONANT) {
      out += CONSONANT[ch];
      const next = chars[i + 1];
      if (next !== undefined && next in SIGN) { out += SIGN[next]; i++; }
      else out += 'a';                       // inherent vowel
    } else if (ch in VOWEL) out += VOWEL[ch];
    else if (ch in SIGN) out += SIGN[ch];
    else out += ch;
  }
  return out;
}

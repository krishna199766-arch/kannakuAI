/**
 * Deterministic spoken-number normaliser for Indian English, Hindi and Tamil (spec 4.1 step 3).
 * "pachpan sau" -> 5500, "dedh lakh" -> 150000, "saade teen hazaar" -> 3500, "5.5k" -> 5500,
 * "ஐயாயிரத்து ஐநூறு" -> 5500, "anju aayiram" -> 5000.
 * Every number keeps the source words it came from, so grounding can check the model's citations.
 */

// Null-prototype tables: a spoken word such as "constructor" must not hit Object.prototype.
const dict = <T>(o: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), o);

const EN: Record<string, number> = dict({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
});

const HI_LIST = [
  'ek', 'do', 'teen', 'char', 'paanch', 'chhah', 'saat', 'aath', 'nau', 'das',
  'gyarah', 'barah', 'terah', 'chaudah', 'pandrah', 'solah', 'satrah', 'atharah', 'unnis', 'bees',
  'ikkis', 'bais', 'teis', 'chaubis', 'pachis', 'chhabbis', 'sattais', 'atthais', 'untis', 'tees',
  'iktis', 'battis', 'taintis', 'chauntis', 'paintis', 'chhattis', 'saintis', 'adtis', 'untalis', 'chalis',
  'iktalis', 'bayalis', 'taintalis', 'chavalis', 'paintalis', 'chhiyalis', 'saintalis', 'adtalis', 'unchas', 'pachas',
  'ikyavan', 'bavan', 'tirpan', 'chauvan', 'pachpan', 'chhappan', 'sattavan', 'atthavan', 'unsath', 'saath',
  'iksath', 'basath', 'tirsath', 'chausath', 'painsath', 'chhiyasath', 'sadsath', 'adsath', 'unhattar', 'sattar',
  'ikhattar', 'bahattar', 'tihattar', 'chauhattar', 'pachhattar', 'chhihattar', 'sathattar', 'athhattar', 'unasi', 'assi',
  'ikyasi', 'bayasi', 'tirasi', 'chaurasi', 'pachasi', 'chhiyasi', 'sattasi', 'athasi', 'navasi', 'nabbe',
  'ikyanve', 'banve', 'tiranve', 'chauranve', 'pachanve', 'chhiyanve', 'sattanve', 'atthanve', 'ninyanve',
];
const HI: Record<string, number> = dict(Object.fromEntries(HI_LIST.map((w, i) => [w, i + 1])));
// Common alternate spellings from speech-to-text.
Object.assign(HI, {
  chaar: 4, panch: 5, paanch: 5, chhe: 6, chah: 6, che: 6, aat: 8, nao: 9, dus: 10, gyara: 11, bara: 12, baarah: 12,
  pandra: 15, sola: 16, bis: 20, pachchis: 25, pachees: 25, tis: 30, chaalis: 40, chalees: 40, pachaas: 50, pachaasa: 50,
  pachpan: 55, sath: 60, sattar: 70, assee: 80, nabbe: 90, nabve: 90,
});

const MULT: Record<string, number> = dict({
  hundred: 100, sau: 100, so: 100,
  thousand: 1_000, hazaar: 1_000, hazar: 1_000, hajaar: 1_000, hajar: 1_000, k: 1_000,
  lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000, lack: 100_000,
  crore: 10_000_000, crores: 10_000_000, karod: 10_000_000, karor: 10_000_000, cr: 10_000_000,
  million: 1_000_000,
});
const FRACTION_WORD: Record<string, number> = dict({ dedh: 1.5, dedhh: 1.5, dhedh: 1.5, dhai: 2.5, dhaai: 2.5, adhai: 2.5, arhai: 2.5 });
const MODIFIER: Record<string, number> = dict({ saade: 0.5, sade: 0.5, saadhe: 0.5, sadhe: 0.5, sawa: 0.25, savaa: 0.25, sava: 0.25, paune: -0.25, pone: -0.25 });
const UNIT_WORDS = new Set(['bag', 'bags', 'bori', 'boriyan', 'kilo', 'kg', 'kgs', 'packet', 'packets', 'piece', 'pieces', 'box', 'boxes', 'nos', 'ton', 'tons', 'litre', 'liter', 'litres', 'percent', 'rupees', 'rupaye', 'rupay',
  'மூட்டை', 'பை', 'கிலோ', 'ரூபாய்', 'ரூபா', 'பெட்டி', 'லிட்டர்', 'டன்', 'பீஸ்', 'moottai', 'mootai', 'rubai', 'roobai', 'rupai']);

// ---------- Tamil (script and romanised "Tanglish") ----------
// Each word expands to tokens evaluate() already understands: digit strings and hundred/thousand/lakh/crore.
// Tamil merges a number with "thousand" (ஐயாயிரம் = 5 x 1000) and uses combining forms before the
// next number (ஐயாயிரத்து ஐநூறு = 5500), so both forms are listed.
const TA: Record<string, string[]> = dict({});
const add = (words: string[], expansion: (string | number)[]) => {
  for (const w of words) TA[w] = expansion.map(String);
};
// Script-form endings: tens இருபது -> இருபத்து / இருபத்தி; hundreds ஐநூறு -> ஐநூற்று; thousands/lakhs ...ம் -> ...த்து.
const tensForms = (w: string) => [w, w.replace(/து$/, 'த்து'), w.replace(/து$/, 'த்தி')];
const nooruForms = (w: string) => [w, w.replace(/று$/, 'ற்று')];
const amForms = (w: string) => [w, w.replace(/ம்$/, 'த்து')];
const romanAm = (w: string) => [w, w.replace(/am$/, 'athu')];

([
  [['ஒன்று', 'ஒண்ணு', 'ஒன்னு', 'onnu', 'ondru', 'onru'], 1], [['இரண்டு', 'ரெண்டு', 'rendu', 'irandu'], 2],
  [['மூன்று', 'மூணு', 'moonu', 'moondru', 'munu'], 3], [['நான்கு', 'நாலு', 'naalu', 'naangu', 'nalu'], 4],
  [['ஐந்து', 'அஞ்சு', 'anju', 'ainthu', 'aindhu'], 5], [['ஆறு', 'aaru'], 6], [['ஏழு', 'ezhu', 'elu'], 7], [['எட்டு', 'ettu'], 8],
  [['ஒன்பது', 'onbathu', 'ombathu', 'ombodhu', 'onpathu'], 9], [['பத்து', 'pathu', 'paththu'], 10],
  [['பதினொன்று', 'பதினொண்ணு', 'pathinonnu'], 11], [['பன்னிரண்டு', 'பன்னெண்டு', 'pannendu'], 12], [['பதிமூன்று', 'பதின்மூன்று', 'pathimoonu'], 13],
  [['பதினான்கு', 'பதினாலு', 'pathinaalu'], 14], [['பதினைந்து', 'பதினஞ்சு', 'pathinanju'], 15], [['பதினாறு', 'pathinaaru'], 16],
  [['பதினேழு', 'pathinezhu'], 17], [['பதினெட்டு', 'pathinettu'], 18], [['பத்தொன்பது', 'patthonbathu'], 19],
  [['irupathu', 'irubathu', 'irupathi', 'irubathi'], 20], [['muppathu', 'muppathi'], 30], [['naarpathu', 'naapathu', 'naapathi', 'narpathu'], 40],
  [['aimbathu', 'ambathu', 'aimbathi', 'ambathi'], 50], [['arupathu', 'arubathu'], 60], [['ezhupathu', 'elupathu'], 70],
  [['enbathu', 'embathu'], 80], [['thonnooru', 'thonnuru'], 90],
  [['irunooru'], 200], [['munnooru'], 300], [['naanooru'], 400], [['ainooru', 'anjooru', 'ainnooru'], 500],
  [['arunooru'], 600], [['ezhunooru'], 700], [['ennooru'], 800], [['thollaayiram', 'thollayiram'], 900],
  [['அரை', 'arai'], 0.5], [['ஒன்றரை', 'ஒண்ணரை', 'onnarai', 'onnara'], 1.5], [['இரண்டரை', 'ரெண்டரை', 'rendarai', 'rendara'], 2.5], [['மூன்றரை'], 3.5],
] as [string[], number][]).forEach(([ws, v]) => add(ws, [v]));

([['இருபது', 20], ['முப்பது', 30], ['நாற்பது', 40], ['நாப்பது', 40], ['ஐம்பது', 50], ['அம்பது', 50], ['அறுபது', 60], ['எழுபது', 70], ['எண்பது', 80]] as [string, number][])
  .forEach(([w, v]) => add(tensForms(w), [v]));
add(nooruForms('தொண்ணூறு'), [90]);
([['இருநூறு', 200], ['முன்னூறு', 300], ['முந்நூறு', 300], ['நானூறு', 400], ['ஐநூறு', 500], ['ஐந்நூறு', 500], ['அறுநூறு', 600], ['எழுநூறு', 700], ['எண்ணூறு', 800]] as [string, number][])
  .forEach(([w, v]) => add(nooruForms(w), [v]));
add(amForms('தொள்ளாயிரம்'), [900]);

add([...nooruForms('நூறு'), 'nooru', 'nuru', 'nootru'], ['hundred']);
add([...amForms('ஆயிரம்'), ...romanAm('aayiram'), ...romanAm('ayiram')], ['thousand']);
add([...amForms('லட்சம்'), ...amForms('இலட்சம்'), 'லட்சங்கள்', ...romanAm('latcham'), 'laksham', 'latsam'], ['lakh']);
add(['கோடி', 'kodi'], ['crore']);

([['இரண்டாயிரம்', 2], ['ரெண்டாயிரம்', 2], ['மூவாயிரம்', 3], ['மூணாயிரம்', 3], ['நான்காயிரம்', 4], ['நாலாயிரம்', 4],
  ['ஐயாயிரம்', 5], ['ஐந்தாயிரம்', 5], ['அஞ்சாயிரம்', 5], ['ஆறாயிரம்', 6], ['ஏழாயிரம்', 7], ['எட்டாயிரம்', 8],
  ['ஒன்பதாயிரம்', 9], ['பத்தாயிரம்', 10], ['இருபதாயிரம்', 20], ['முப்பதாயிரம்', 30], ['நாற்பதாயிரம்', 40],
  ['ஐம்பதாயிரம்', 50], ['அறுபதாயிரம்', 60], ['எழுபதாயிரம்', 70], ['எண்பதாயிரம்', 80], ['தொண்ணூறாயிரம்', 90]] as [string, number][])
  .forEach(([w, v]) => add(amForms(w), [v, 'thousand']));
([['rendaayiram', 2], ['rendayiram', 2], ['moovaayiram', 3], ['moovayiram', 3], ['naalaayiram', 4], ['nalayiram', 4],
  ['anjaayiram', 5], ['anjayiram', 5], ['aiyaayiram', 5], ['aiyayiram', 5], ['aaraayiram', 6], ['ezhaayiram', 7],
  ['ettaayiram', 8], ['ettayiram', 8], ['pathaayiram', 10], ['pathayiram', 10]] as [string, number][])
  .forEach(([w, v]) => add(romanAm(w), [v, 'thousand']));

/** "ஒரு" / "oru" is also the indefinite article ("a sale"): numeric only before a multiplier or a unit. */
const TA_ARTICLE = new Set(['ஒரு', 'ஓர்', 'oru']);
add([...TA_ARTICLE], [1]);
export const TAMIL_NUMBER_WORDS = Object.keys(TA).length;

export interface NumberSpan {
  value: number;
  /** Digits as they appear in the normalised text. */
  text: string;
  /** Original words that produced the number. */
  source: string;
}

export interface Normalized {
  text: string;
  spans: NumberSpan[];
}

type Tok = { raw: string; low: string };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /(?:₹|rs\.?|inr)?\s?\d[\d,]*(?:\.\d+)?(?:k|l|cr)?(?:\/-)?|[A-Za-zऀ-ॿ஀-௿]+|[^\sA-Za-z\d]/gi;
  for (const m of s.matchAll(re)) out.push({ raw: m[0], low: m[0].toLowerCase().trim() });
  return out;
}

/** "₹5,500/-" -> 5500; "5.5k" -> 5500; null if not numeric. */
function digitValue(t: string): number | null {
  const m = t.replace(/^(₹|rs\.?|inr)\s?/i, '').replace(/\/-$/, '').match(/^(\d[\d,]*(?:\.\d+)?)(k|l|cr)?$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  const suffix = m[2]?.toLowerCase();
  return suffix === 'k' ? n * 1e3 : suffix === 'l' ? n * 1e5 : suffix === 'cr' ? n * 1e7 : n;
}

function small(t: string): number | null {
  if (t in EN) return EN[t];
  if (t in HI) return HI[t];
  return null;
}

function isNumberish(toks: Tok[], i: number, inPhrase: boolean): boolean {
  const t = toks[i].low;
  if (t in TA) {
    if (!TA_ARTICLE.has(t)) return true;
    const next = toks[i + 1]?.low;
    return Boolean(next && (next in MULT || TA[next]?.[0] in MULT || UNIT_WORDS.has(next)));
  }
  if (digitValue(t) !== null || t in EN || t in MULT || t in FRACTION_WORD || t in MODIFIER) {
    if (t === 'k' || t === 'cr' || t === 'so') return inPhrase;       // only after a number
    if (t in MODIFIER) return i + 1 < toks.length && (small(toks[i + 1].low) !== null || digitValue(toks[i + 1].low) !== null);
    return true;
  }
  if (t in HI) {
    if (t !== 'do') return true;
    // "do" is Hindi 2 only next to a multiplier, a unit word or another number.
    const next = toks[i + 1]?.low;
    return Boolean(next && (next in MULT || UNIT_WORDS.has(next) || next in HI));
  }
  if (t === 'and' && inPhrase) {
    const next = toks[i + 1]?.low;
    return Boolean(next && (next in EN || digitValue(next) !== null));
  }
  if (t === 'point' && inPhrase) return Boolean(toks[i + 1] && small(toks[i + 1].low) !== null);
  return false;
}

function evaluate(phrase: Tok[]): number {
  let total = 0;
  let current = 0;
  let modifier = 0;
  let decimals: number[] | null = null;
  const expanded = phrase.flatMap((t) => TA[t.low] ?? [t.low]);
  for (const low of expanded) {
    if (low === 'and') continue;
    if (low === 'point') { decimals = []; continue; }
    if (decimals) { const d = small(low); if (d !== null && d < 10) { decimals.push(d); continue; } }
    if (low in MODIFIER) { modifier = MODIFIER[low]; continue; }
    if (low in FRACTION_WORD) { current += FRACTION_WORD[low]; continue; }
    const dv = digitValue(low);
    const sv = dv ?? small(low);
    if (sv !== null) {
      current += sv + modifier;
      modifier = 0;
      continue;
    }
    if (low in MULT) {
      const m = MULT[low];
      const base = current || 1;
      if (m === 100) current = base * 100;
      else { total += base * m; current = 0; }
    }
  }
  let value = total + current;
  if (decimals?.length) value += Number(`0.${decimals.join('')}`);
  return Math.round(value * 10_000) / 10_000;
}

export function normalizeTranscript(input: string): Normalized {
  const toks = tokenize(input);
  const outParts: string[] = [];
  const spans: NumberSpan[] = [];
  let i = 0;
  while (i < toks.length) {
    if (!isNumberish(toks, i, false)) { outParts.push(toks[i].raw.trim()); i++; continue; }
    const phrase: Tok[] = [];
    while (i < toks.length && isNumberish(toks, i, phrase.length > 0)) {
      // Two bare digit groups in a row ("10 5500") are separate numbers.
      if (phrase.length && digitValue(toks[i].low) !== null && digitValue(phrase[phrase.length - 1].low) !== null) break;
      phrase.push(toks[i]);
      i++;
    }
    // A lone "and" or "point" at the end is not part of the number.
    while (phrase.length > 1 && ['and', 'point'].includes(phrase[phrase.length - 1].low)) { phrase.pop(); i--; }
    const value = evaluate(phrase);
    const text = String(value);
    spans.push({ value, text, source: phrase.map((t) => t.raw.trim()).join(' ') });
    outParts.push(text);
  }
  const text = outParts.join(' ').replace(/\s+([,.?!%])/g, '$1').replace(/\s+/g, ' ').trim();
  return { text, spans };
}

/** "Forty Thousand Seven Hundred Ten Rupees and Fifty Paise Only" -> 40710.5; null when no number words. */
export function wordsToNumber(words: string): number | null {
  // "... thousand and fifty paise": break the phrase before the paise part.
  const n = normalizeTranscript(words.replace(/-/g, ' ').replace(/\band\b(?=[a-z\s]*paise)/i, ' | '));
  if (!n.spans.length) return null;
  let value = n.spans[0].value;
  const lower = n.text.toLowerCase();
  const paise = lower.match(/(\d+(?:\.\d+)?)\s+paise/);
  if (paise && n.spans.length > 1) value += Number(paise[1]) / 100;
  return value;
}

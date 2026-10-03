import { formatINR } from '../../lib/money';
import type { PeriodName } from '../../lib/dates';
import type { GroundedField } from './grounding';

/**
 * Everything the voice engine says, in each supported language. Readbacks are built from
 * these templates and the posting plan; the model never writes them (spec 4.5).
 */
export type Lang = 'en' | 'ta';
export const LANGS: Lang[] = ['en', 'ta'];

type TradingType = 'SALES' | 'PURCHASE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
type Mode = 'CASH' | 'BANK' | 'CREDIT';

export interface Messages {
  money(minor: bigint): string;
  date(iso: string): string;
  period(p: PeriodName): string;
  voucher(type: string): string;
  screen(name: string): string;

  nothingToConfirm: string;
  didntCatch: string;
  sayAgain: string;
  lowConfidenceAmount(v: string): string;
  askFor(field: GroundedField): string;

  whichDate: string;
  futureDate(d: string): string;
  didYouMean(names: string[]): string;
  partyNotFound(spoken: string): string;
  whichLedger(spoken: string): string;
  cashOrCredit: string;
  whichSupplier: string;
  whichCustomer: string;
  whichBank: string;
  whichItem(spoken: string): string;
  howMany(uom: string, item: string): string;
  gstFor(item: string): string;
  rateFor(item: string): string;
  whatAmount: string;
  whatGst: string;
  inclusive(amount: string | null): string;
  whoPaymentFor: string;
  whoReceivedFrom: string;
  cashOrBank: string;
  journalOnScreen: string;
  previewError(msg: string): string;
  duplicate(type: string, minutes: number, voucherNo: string): string;

  tradingHeader(type: TradingType, mode: Mode, party: string | null): string;
  lines(lines: string[]): string;
  totalWithGst(total: string, tax: string): string;
  totalNoGst(total: string): string;
  payment(total: string, to: string, from: string): string;
  receipt(total: string, from: string, into: string): string;
  transfer(total: string, from: string, to: string): string;
  dated(d: string): string;
  note(w: string): string;
  overLimit: string;
  backdated: string;
  sayConfirm: string;

  confirmExpired: string;
  draftChanged: string;
  overLimitConfirm: string;
  backdatedConfirm: string;
  reversed(no: string): string;
  posted(type: string, no: string): string;
  alreadyPosted(type: string, no: string): string;
  cancelled: string;

  whichPartyBy(spoken: string): string;
  customersOwe(amount: string): string;
  youOweSuppliers(amount: string): string;
  partyOwes(name: string, amount: string): string;
  youOweParty(name: string, amount: string): string;
  noBalance(name: string): string;
  fromBillsSince(amount: string, period: string, from: string): string;
  overdue60(amount: string): string;

  sales(period: string, amount: string): string;
  purchases(period: string, amount: string): string;
  gstPayable(period: string, amount: string): string;
  excessItc(period: string, amount: string): string;
  cash(amount: string): string;
  bank(amount: string): string;
  profit(period: string, amount: string): string;
  loss(period: string, amount: string): string;
  whichFigure: string;

  whichLedgerOpen: string;
  opening(screen: string, period: string | null): string;
  voucherNotFound(type: string, no: string | null): string;
  reverseQuestion(type: string, no: string, date: string, amount: string, party: string | null): string;
}

const splitMoney = (minor: bigint) => {
  const s = formatINR(minor < 0n ? -minor : minor).replace(/\.00$/, '');
  const [r, p] = s.split('.');
  return { r, p: p ? Number(p) : 0 };
};

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TA_MONTHS = ['ஜனவரி', 'பிப்ரவரி', 'மார்ச்', 'ஏப்ரல்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆகஸ்ட்', 'செப்டம்பர்', 'அக்டோபர்', 'நவம்பர்', 'டிசம்பர்'];
const dayMonth = (iso: string, months: string[]) => `${Number(iso.slice(8, 10))} ${months[Number(iso.slice(5, 7)) - 1]}`;

const en: Messages = {
  money: (m) => { const { r, p } = splitMoney(m); return p ? `${r} rupees ${p} paise` : `${r} rupees`; },
  date: (iso) => dayMonth(iso, EN_MONTHS),
  period: (p) => ({
    TODAY: 'today', YESTERDAY: 'yesterday', THIS_WEEK: 'this week', THIS_MONTH: 'this month', LAST_MONTH: 'last month',
    THIS_QUARTER: 'this quarter', LAST_QUARTER: 'last quarter', THIS_FY: 'this financial year', LAST_FY: 'last financial year',
    AS_OF_TODAY: 'to date', UNSPECIFIED: 'to date',
  } as Record<PeriodName, string>)[p],
  voucher: (t) => ({
    SALES: 'sale', PURCHASE: 'purchase', PAYMENT: 'payment', RECEIPT: 'receipt', CONTRA: 'contra',
    JOURNAL: 'journal', CREDIT_NOTE: 'sales return', DEBIT_NOTE: 'purchase return',
  } as Record<string, string>)[t] ?? t.toLowerCase(),
  screen: (s) => s.toLowerCase().replace(/_/g, ' '),

  nothingToConfirm: 'There is nothing waiting for confirmation.',
  didntCatch: "Sorry, I didn't catch that. Could you say it again?",
  sayAgain: 'Could you say that again?',
  lowConfidenceAmount: (v) => `I'm not sure I heard the amount right. Did you say ${v}?`,
  askFor: (f) => ({ amount: 'Sorry, what was the amount?', quantity: 'Sorry, what was the quantity?', rate: 'Sorry, what was the rate?', gst_rate: 'What GST rate applies?' })[f],

  whichDate: 'Which date should I use?',
  futureDate: (d) => `${d} is in the future. Which date did you mean?`,
  didYouMean: (names) => `Did you mean ${names.join(' or ')}?`,
  partyNotFound: (s) => `I couldn't find a party called ${s}. Please add them first with Alt C.`,
  whichLedger: (s) => `Which ledger is "${s}"?`,
  cashOrCredit: 'Was it a cash sale, or on credit to a party?',
  whichSupplier: 'Which supplier was it from?',
  whichCustomer: 'Which customer was it for?',
  whichBank: 'Which bank account?',
  whichItem: (s) => `Which item is "${s}"?`,
  howMany: (uom, item) => `How many ${uom} of ${item}?`,
  gstFor: (item) => `What GST rate applies to ${item}?`,
  rateFor: (item) => `What is the rate for ${item}?`,
  whatAmount: 'What was the amount?',
  whatGst: 'What GST rate applies? Say zero if none.',
  inclusive: (a) => `Is that ${a ?? 'rate'} including GST, or plus GST?`,
  whoPaymentFor: 'Who or what was the payment for?',
  whoReceivedFrom: 'Who was the money received from?',
  cashOrBank: 'Was it cash or bank?',
  journalOnScreen: 'Journal entries need you to pick both ledgers. Press F7 to enter it on screen.',
  previewError: (m) => `${m}. What should I change?`,
  duplicate: (t, mins, no) => `You recorded the same ${en.voucher(t)} ${mins || 'less than one'} minute${mins === 1 ? '' : 's'} ago (number ${no}).`,

  tradingHeader: (type, mode, party) => {
    const how = mode === 'CASH' ? 'Cash' : mode === 'BANK' ? 'Bank' : 'Credit';
    const prep = type === 'PURCHASE' || type === 'DEBIT_NOTE' ? 'from' : 'to';
    return `${how} ${en.voucher(type)}${party ? ` ${prep} ${party}` : ''}.`;
  },
  lines: (l) => `${l.join(', ')}.`,
  totalWithGst: (t, tax) => `Total ${t}, including GST of ${tax}.`,
  totalNoGst: (t) => `Total ${t}, no GST.`,
  payment: (t, to, from) => `Payment of ${t} to ${to} from ${from}.`,
  receipt: (t, from, into) => `Receipt of ${t} from ${from} into ${into}.`,
  transfer: (t, from, to) => `Transfer of ${t} from ${from} to ${to}.`,
  dated: (d) => `Dated ${d}.`,
  note: (w) => `Note: ${w}`,
  overLimit: 'This is above your voice limit, so press Control A to post it.',
  backdated: 'This is back-dated, so press Control A to post it.',
  sayConfirm: 'Say confirm to post, or tell me what to change.',

  confirmExpired: 'That confirmation window has passed. Press Control A, or say the command again.',
  draftChanged: 'The draft changed after it was read back. Please review it again.',
  overLimitConfirm: 'This amount is above your voice limit. Press Control A to post it.',
  backdatedConfirm: 'Back-dated vouchers need Control A on screen.',
  reversed: (no) => `Reversed. Reversal number ${no}.`,
  posted: (t, no) => { const l = en.voucher(t); return `Posted. ${l[0].toUpperCase()}${l.slice(1)} number ${no}.`; },
  alreadyPosted: (t, no) => `That was already posted as ${en.voucher(t)} number ${no}.`,
  cancelled: 'Cancelled. Nothing was posted.',

  whichPartyBy: (s) => `Which party did you mean by ${s}?`,
  customersOwe: (a) => `Customers owe you ${a} in total.`,
  youOweSuppliers: (a) => `You owe suppliers ${a} in total.`,
  partyOwes: (n, a) => `${n} owes you ${a} in total.`,
  youOweParty: (n, a) => `You owe ${n} ${a} in total.`,
  noBalance: (n) => `${n} has no outstanding balance.`,
  fromBillsSince: (a, p, from) => `${a} of that is from bills dated ${p}, since ${from}.`,
  overdue60: (a) => `${a} is more than 60 days overdue.`,

  sales: (p, a) => `Sales ${p} are ${a}, including GST.`,
  purchases: (p, a) => `Purchases ${p} are ${a}, including GST.`,
  gstPayable: (p, a) => `Net GST payable ${p} is ${a}.`,
  excessItc: (p, a) => `You have excess input credit of ${a} ${p}.`,
  cash: (a) => `Cash in hand is ${a}.`,
  bank: (a) => `Bank balance is ${a}.`,
  profit: (p, a) => `Net profit ${p} is ${a}.`,
  loss: (p, a) => `Net loss ${p} is ${a}.`,
  whichFigure: 'Which figure would you like?',

  whichLedgerOpen: 'Which ledger should I open?',
  opening: (s, p) => `Opening ${s}${p ? ` for ${p}` : ''}.`,
  voucherNotFound: (t, no) => (no ? `I couldn't find ${t} number ${no}.` : `I couldn't find a ${t} to reverse.`),
  reverseQuestion: (t, no, d, a, party) => `Reverse ${t} number ${no}, dated ${d}, for ${a}${party ? ` with ${party}` : ''}? Say confirm to reverse it.`,
};

const ta: Messages = {
  money: (m) => { const { r, p } = splitMoney(m); return p ? `${r} ரூபாய் ${p} பைசா` : `${r} ரூபாய்`; },
  date: (iso) => dayMonth(iso, TA_MONTHS),
  period: (p) => ({
    TODAY: 'இன்று', YESTERDAY: 'நேற்று', THIS_WEEK: 'இந்த வாரம்', THIS_MONTH: 'இந்த மாதம்', LAST_MONTH: 'கடந்த மாதம்',
    THIS_QUARTER: 'இந்த காலாண்டு', LAST_QUARTER: 'கடந்த காலாண்டு', THIS_FY: 'இந்த நிதியாண்டு', LAST_FY: 'கடந்த நிதியாண்டு',
    AS_OF_TODAY: 'இதுவரை', UNSPECIFIED: 'இதுவரை',
  } as Record<PeriodName, string>)[p],
  voucher: (t) => ({
    SALES: 'விற்பனை', PURCHASE: 'கொள்முதல்', PAYMENT: 'பணம் செலுத்துதல்', RECEIPT: 'பணம் வரவு', CONTRA: 'பணப் பரிமாற்றம்',
    JOURNAL: 'ஜர்னல்', CREDIT_NOTE: 'விற்பனை திருப்பம்', DEBIT_NOTE: 'கொள்முதல் திருப்பம்',
  } as Record<string, string>)[t] ?? t,
  screen: (s) => ({
    DAYBOOK: 'நாள் புத்தகம்', TRIAL_BALANCE: 'இருப்பாய்வு', PROFIT_LOSS: 'லாப நஷ்டக் கணக்கு', BALANCE_SHEET: 'இருப்புநிலைக் குறிப்பு',
    LEDGER: 'லெட்ஜர்', AGEING_RECEIVABLE: 'வரவேண்டிய நிலுவை', AGEING_PAYABLE: 'செலுத்த வேண்டிய நிலுவை', STOCK_SUMMARY: 'சரக்கு சுருக்கம்',
    GST_SUMMARY: 'ஜிஎஸ்டி சுருக்கம்', REVIEW_QUEUE: 'ஸ்கேன் செய்த பில்கள்', DASHBOARD: 'முகப்பு',
  } as Record<string, string>)[s] ?? s,

  nothingToConfirm: 'உறுதிப்படுத்த எதுவும் காத்திருக்கவில்லை.',
  didntCatch: 'மன்னிக்கவும், எனக்குப் புரியவில்லை. மீண்டும் சொல்ல முடியுமா?',
  sayAgain: 'மீண்டும் சொல்ல முடியுமா?',
  lowConfidenceAmount: (v) => `தொகை சரியாகக் கேட்டதா என்று உறுதியாகத் தெரியவில்லை. ${v} என்று சொன்னீர்களா?`,
  askFor: (f) => ({ amount: 'மன்னிக்கவும், தொகை எவ்வளவு?', quantity: 'மன்னிக்கவும், அளவு எவ்வளவு?', rate: 'மன்னிக்கவும், விலை என்ன?', gst_rate: 'எந்த ஜிஎஸ்டி விகிதம்?' })[f],

  whichDate: 'எந்தத் தேதியைப் பயன்படுத்த வேண்டும்?',
  futureDate: (d) => `${d} எதிர்காலத் தேதி. எந்தத் தேதியைச் சொன்னீர்கள்?`,
  didYouMean: (names) => `${names.join(' அல்லது ')} — இதில் யாரைச் சொன்னீர்கள்?`,
  partyNotFound: (s) => `${s} என்ற பெயரில் பார்ட்டி இல்லை. முதலில் Alt C மூலம் சேர்க்கவும்.`,
  whichLedger: (s) => `"${s}" எந்த லெட்ஜர்?`,
  cashOrCredit: 'இது ரொக்கமா, அல்லது ஒரு பார்ட்டிக்குக் கடனா?',
  whichSupplier: 'எந்த சப்ளையரிடமிருந்து வாங்கியது?',
  whichCustomer: 'எந்த வாடிக்கையாளருக்கு?',
  whichBank: 'எந்த வங்கிக் கணக்கு?',
  whichItem: (s) => `"${s}" எந்தப் பொருள்?`,
  howMany: (uom, item) => `${item} எத்தனை ${uom}?`,
  gstFor: (item) => `${item}-க்கு எந்த ஜிஎஸ்டி விகிதம்?`,
  rateFor: (item) => `${item}-இன் விலை என்ன?`,
  whatAmount: 'தொகை எவ்வளவு?',
  whatGst: 'எந்த ஜிஎஸ்டி விகிதம்? ஜிஎஸ்டி இல்லையென்றால் பூஜ்ஜியம் என்று சொல்லுங்கள்.',
  inclusive: (a) => `${a ?? 'இந்த விலை'} ஜிஎஸ்டி சேர்த்தா, அல்லது ஜிஎஸ்டி தனியாகவா?`,
  whoPaymentFor: 'யாருக்கு அல்லது எதற்காகப் பணம் செலுத்தப்பட்டது?',
  whoReceivedFrom: 'யாரிடமிருந்து பணம் வந்தது?',
  cashOrBank: 'ரொக்கமா அல்லது வங்கியா?',
  journalOnScreen: 'ஜர்னல் பதிவுக்கு இரண்டு லெட்ஜர்களையும் தேர்வு செய்ய வேண்டும். திரையில் பதிவு செய்ய F7 அழுத்தவும்.',
  previewError: (m) => `${m}. எதை மாற்ற வேண்டும்?`,
  duplicate: (t, mins, no) => `இதே ${ta.voucher(t)}-ஐ ${mins ? `${mins} நிமிடங்களுக்கு முன்பு` : 'ஒரு நிமிடத்திற்குள்'} பதிவு செய்தீர்கள் (எண் ${no}).`,

  tradingHeader: (type, mode, party) => {
    const how = mode === 'CASH' ? 'ரொக்க' : mode === 'BANK' ? 'வங்கி' : 'கடன்';
    const who = party ? (type === 'PURCHASE' || type === 'DEBIT_NOTE' ? ` — ${party}-இடமிருந்து` : ` — ${party}-க்கு`) : '';
    return `${how} ${ta.voucher(type)}${who}.`;
  },
  lines: (l) => `${l.join(', ')}.`,
  totalWithGst: (t, tax) => `மொத்தம் ${t}, இதில் ஜிஎஸ்டி ${tax}.`,
  totalNoGst: (t) => `மொத்தம் ${t}, ஜிஎஸ்டி இல்லை.`,
  payment: (t, to, from) => `${to}-க்கு ${t} செலுத்துதல், ${from}-இலிருந்து.`,
  receipt: (t, from, into) => `${from}-இடமிருந்து ${t} வரவு, ${into}-இல்.`,
  transfer: (t, from, to) => `${from}-இலிருந்து ${to}-க்கு ${t} பரிமாற்றம்.`,
  dated: (d) => `தேதி ${d}.`,
  note: (w) => `கவனிக்கவும்: ${w}`,
  overLimit: 'இந்தத் தொகை உங்கள் குரல் வரம்பை விட அதிகம், எனவே பதிவு செய்ய Control A அழுத்தவும்.',
  backdated: 'இது பழைய தேதியிட்ட பதிவு, எனவே பதிவு செய்ய Control A அழுத்தவும்.',
  sayConfirm: 'பதிவு செய்ய "சரி" என்று சொல்லுங்கள், அல்லது மாற்ற வேண்டியதைச் சொல்லுங்கள்.',

  confirmExpired: 'உறுதிப்படுத்தும் நேரம் முடிந்துவிட்டது. Control A அழுத்தவும், அல்லது கட்டளையை மீண்டும் சொல்லுங்கள்.',
  draftChanged: 'படித்துக் காட்டிய பிறகு வரைவு மாறிவிட்டது. மீண்டும் சரிபார்க்கவும்.',
  overLimitConfirm: 'இந்தத் தொகை குரல் வரம்பை விட அதிகம். பதிவு செய்ய Control A அழுத்தவும்.',
  backdatedConfirm: 'பழைய தேதியிட்ட பதிவுகளுக்கு திரையில் Control A தேவை.',
  reversed: (no) => `ரத்து செய்யப்பட்டது. மாற்றுப் பதிவு எண் ${no}.`,
  posted: (t, no) => `பதிவு செய்யப்பட்டது. ${ta.voucher(t)} எண் ${no}.`,
  alreadyPosted: (t, no) => `இது ஏற்கனவே ${ta.voucher(t)} எண் ${no} ஆகப் பதிவு செய்யப்பட்டுள்ளது.`,
  cancelled: 'ரத்து செய்யப்பட்டது. எதுவும் பதிவு செய்யப்படவில்லை.',

  whichPartyBy: (s) => `${s} என்று எந்தப் பார்ட்டியைச் சொன்னீர்கள்?`,
  customersOwe: (a) => `வாடிக்கையாளர்கள் உங்களுக்கு மொத்தம் ${a} தர வேண்டும்.`,
  youOweSuppliers: (a) => `நீங்கள் சப்ளையர்களுக்கு மொத்தம் ${a} தர வேண்டும்.`,
  partyOwes: (n, a) => `${n} உங்களுக்கு மொத்தம் ${a} தர வேண்டும்.`,
  youOweParty: (n, a) => `நீங்கள் ${n}-க்கு மொத்தம் ${a} தர வேண்டும்.`,
  noBalance: (n) => `${n}-க்கு நிலுவை எதுவும் இல்லை.`,
  fromBillsSince: (a, p, from) => `இதில் ${a} ${p} (${from} முதல்) போடப்பட்ட பில்களிலிருந்து.`,
  overdue60: (a) => `${a} 60 நாட்களுக்கு மேல் நிலுவையில் உள்ளது.`,

  sales: (p, a) => `${p} விற்பனை ${a}, ஜிஎஸ்டி உட்பட.`,
  purchases: (p, a) => `${p} கொள்முதல் ${a}, ஜிஎஸ்டி உட்பட.`,
  gstPayable: (p, a) => `${p} செலுத்த வேண்டிய நிகர ஜிஎஸ்டி ${a}.`,
  excessItc: (p, a) => `${p} உங்களிடம் ${a} கூடுதல் உள்ளீட்டு வரி வரவு உள்ளது.`,
  cash: (a) => `கையிருப்பு ரொக்கம் ${a}.`,
  bank: (a) => `வங்கி இருப்பு ${a}.`,
  profit: (p, a) => `${p} நிகர லாபம் ${a}.`,
  loss: (p, a) => `${p} நிகர நஷ்டம் ${a}.`,
  whichFigure: 'எந்த விவரம் வேண்டும்?',

  whichLedgerOpen: 'எந்த லெட்ஜரைத் திறக்க வேண்டும்?',
  opening: (s, p) => `${s}${p ? ` (${p})` : ''} திறக்கிறது.`,
  voucherNotFound: (t, no) => (no ? `${t} எண் ${no} கிடைக்கவில்லை.` : `ரத்து செய்ய ${t} எதுவும் கிடைக்கவில்லை.`),
  reverseQuestion: (t, no, d, a, party) => `${t} எண் ${no}, தேதி ${d}, ${a}${party ? `, ${party}` : ''} — இதை ரத்து செய்யவா? ரத்து செய்ய "சரி" என்று சொல்லுங்கள்.`,
};

export const MESSAGES: Record<Lang, Messages> = { en, ta };
export const msgs = (lang: Lang) => MESSAGES[lang];
export const asLang = (v: unknown): Lang | null => (v === 'ta' || v === 'en' ? v : null);

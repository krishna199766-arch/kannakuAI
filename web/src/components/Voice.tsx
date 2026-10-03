import { useCallback, useEffect, useRef, useState } from 'react';
import { api, c, ApiError, type Preview } from '../api';
import { useApp, type Route } from '../state';
import { useKeys } from '../keys';
import { Kbd } from './ui';
import { inr } from '../format';

type VLang = 'en' | 'ta';

/** Speech-recognition and speech-synthesis locales, plus example commands, per voice language. */
const LANGS: Record<VLang, { label: string; stt: string; tts: string; examples: string[]; typeHint: string; noVoice: string }> = {
  en: {
    label: 'English / Hinglish', stt: 'en-IN', tts: 'en-IN',
    examples: [
      'Record a cash sale of 5,500 rupees to Rajesh Traders for 10 bags of cement including 18% GST',
      'What is the outstanding receivable from ABC Corp this quarter?',
      'Show me the daybook for yesterday',
    ],
    typeHint: '…or type a command',
    noVoice: '',
  },
  ta: {
    label: 'தமிழ் (Tamil)', stt: 'ta-IN', tts: 'ta-IN',
    examples: [
      'ராஜேஷ் டிரேடர்ஸ்-க்கு பத்து மூட்டை சிமெண்ட் ரொக்க விற்பனை, ஐயாயிரத்து ஐநூறு ரூபாய், 18% ஜிஎஸ்டி சேர்த்து',
      'ABC Corp இந்த காலாண்டு எவ்வளவு பாக்கி?',
      'நேற்றைய நாள் புத்தகத்தைக் காட்டு',
    ],
    typeHint: '…அல்லது இங்கே தட்டச்சு செய்யுங்கள்',
    noVoice: 'This browser has no Tamil voice, so replies are shown but not spoken. Microsoft Edge includes Tamil voices.',
  },
};
const LANG_KEY = 'kannaku.voiceLang';
const loadLang = (): VLang => { try { return localStorage.getItem(LANG_KEY) === 'ta' ? 'ta' : 'en'; } catch { return 'en'; } };
const saveLang = (l: VLang) => { try { localStorage.setItem(LANG_KEY, l); } catch { /* storage blocked */ } };

function pickVoice(voices: SpeechSynthesisVoice[], locale: string): SpeechSynthesisVoice | null {
  const norm = (x: string) => x.replace('_', '-').toLowerCase();
  const want = norm(locale);
  return voices.find((v) => norm(v.lang) === want) ?? voices.find((v) => norm(v.lang).startsWith(want.slice(0, 2))) ?? null;
}

type VoiceResponse =
  | { kind: 'voucher'; sessionId: string; lang?: VLang; speech: string; draft: { preview: Preview; warnings: string[]; needsScreenConfirm: boolean; expiresAt: string } }
  | { kind: 'reverse'; sessionId: string; lang?: VLang; speech: string; expiresAt: string; target: { voucherNo: string } }
  | { kind: 'clarify'; sessionId: string; lang?: VLang; speech: string }
  | { kind: 'answer'; sessionId: null; lang?: VLang; speech: string }
  | { kind: 'navigate'; sessionId: null; lang?: VLang; speech: string; route: { screen: string; from: string; to: string; ledgerId: string | null } }
  | { kind: 'posted'; sessionId: null; lang?: VLang; speech: string; voucher: { id: string } }
  | { kind: 'cancelled'; sessionId: null; lang?: VLang; speech: string };

// Same fixed grammar as the server (server/src/ai/voice/engine.ts): English, Hinglish, Tamil.
const END = '[.!]?' + '$';
const CONFIRM_RE = new RegExp('^(' + [
  'yes', 'yeah', 'yep', 'confirm(ed)?', 'post( it)?', 'ok(ay)?( post( it)?)?', 'do it', 'correct',
  'haan( ji)?', 'han', 'ha', 'ji haan', 'haan post karo', 'post karo', 'theek hai', 'sahi hai',
  'சரி', 'சரிங்க', 'சரி போடு', 'ஆமா', 'ஆமாம்', 'ஆம்', 'ஓகே', 'ஓக்கே', 'போடு', 'போடுங்க', 'பதிவு செய்', 'பதிவு செய்யுங்கள்', 'பதிவு பண்ணு', 'கன்ஃபார்ம்',
  'sari', 'seri', 'saringa', 'aama', 'aamaa', 'aamam', 'podu', 'podunga', 'pathivu sei',
].join('|') + ')' + END, 'i');
const CANCEL_RE = new RegExp('^(' + [
  'no', 'nope', 'cancel( it)?', 'stop', 'discard', 'nahi', 'nahin', 'mat karo', 'rehne do', 'chhodo',
  'வேண்டாம்', 'வேணாம்', 'ரத்து', 'ரத்து செய்', 'கேன்சல்', 'இல்லை', 'இல்ல', 'நிறுத்து',
  'vendam', 'venam', 'vendaam', 'rathu', 'illa', 'illai',
].join('|') + ')' + END, 'i');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SR: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

function routeFor(r: { screen: string; from: string; to: string; ledgerId: string | null }): Route {
  const map: Record<string, Route> = {
    DAYBOOK: { screen: 'daybook', params: { from: r.from, to: r.to } },
    TRIAL_BALANCE: { screen: 'tb' }, PROFIT_LOSS: { screen: 'pl' }, BALANCE_SHEET: { screen: 'bs' },
    LEDGER: { screen: 'ledger', params: { ledgerId: r.ledgerId, from: r.from, to: r.to } },
    AGEING_RECEIVABLE: { screen: 'ageing', params: { side: 'receivable' } }, AGEING_PAYABLE: { screen: 'ageing', params: { side: 'payable' } },
    STOCK_SUMMARY: { screen: 'stock' }, GST_SUMMARY: { screen: 'gst' }, REVIEW_QUEUE: { screen: 'review' }, DASHBOARD: { screen: 'gateway' },
  };
  return map[r.screen] ?? { screen: 'gateway' };
}

export function VoicePanel({ open, onOpen, onClose }: { open: boolean; onOpen: () => void; onClose: () => void }) {
  const app = useApp();
  const [log, setLog] = useState<{ who: 'you' | 'ai'; text: string }[]>([]);
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Extract<VoiceResponse, { kind: 'voucher' | 'reverse' }> | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [lang, setLangState] = useState<VLang>(loadLang);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const rec = useRef<any>(null);
  const finals = useRef<{ text: string; conf: number }[]>([]);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const handleRef = useRef<(text: string, conf: number | null) => Promise<void>>(async () => {});
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const langRef = useRef(lang);
  langRef.current = lang;
  const voicesRef = useRef(voices);
  voicesRef.current = voices;

  const setLang = (l: VLang) => { setLangState(l); saveLang(l); };

  // Voices load asynchronously in Chrome and Edge.
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);

  /** Speaks in the reply's language; with no installed voice for it, the reply is shown but not spoken. */
  const say = useCallback((text: string, then?: () => void, replyLang?: VLang) => {
    setLog((l) => [...l, { who: 'ai', text }]);
    if (!('speechSynthesis' in window)) { then?.(); return; }
    window.speechSynthesis.cancel();
    const locale = LANGS[replyLang ?? langRef.current].tts;
    const v = pickVoice(voicesRef.current.length ? voicesRef.current : window.speechSynthesis.getVoices(), locale);
    if (!v && locale !== 'en-IN') { then?.(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = locale;
    if (v) u.voice = v;
    u.rate = 1.05;
    if (then) u.onend = () => then();
    window.speechSynthesis.speak(u);
  }, []);

  const startListening = useCallback((autoStopMs?: number) => {
    if (!SR || rec.current) return;
    const r = new SR();
    r.lang = LANGS[langRef.current].stt;
    r.interimResults = true;
    r.continuous = true;
    finals.current = [];
    r.onresult = (e: any) => {
      let partial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finals.current.push({ text: res[0].transcript, conf: res[0].confidence });
        else partial += res[0].transcript;
      }
      setInterim(partial);
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim('');
      const text = finals.current.map((f) => f.text).join(' ').trim();
      const conf = finals.current.length ? Math.min(...finals.current.map((f) => f.conf || 1)) : null;
      if (text) void handleRef.current(text, conf);
    };
    r.onerror = () => { rec.current = null; setListening(false); };
    rec.current = r;
    setListening(true);
    r.start();
    if (autoStopMs) setTimeout(() => rec.current === r && r.stop(), autoStopMs);
  }, []);
  const stopListening = useCallback(() => rec.current?.stop(), []);

  const apply = useCallback((r: VoiceResponse) => {
    const replyLang = r.lang;
    switch (r.kind) {
      case 'voucher':
      case 'reverse':
        setPending(r); setSessionId(r.sessionId);
        // Listen for "confirm" / "cancel" only after the readback has finished.
        say(r.speech, () => { if (r.kind === 'reverse' || !r.draft.needsScreenConfirm) startListening(6000); }, replyLang);
        break;
      case 'clarify':
        setSessionId(r.sessionId);
        say(r.speech, () => startListening(8000), replyLang);
        break;
      case 'navigate':
        setPending(null); setSessionId(null);
        app.go(routeFor(r.route));
        say(r.speech, undefined, replyLang);
        break;
      case 'posted':
        setPending(null); setSessionId(null);
        app.bumpData();
        say(r.speech, undefined, replyLang);
        break;
      default:
        setPending(null); setSessionId(null);
        say(r.speech, undefined, replyLang);
    }
  }, [app, say, startListening]);

  const confirm = useCallback(async (channel: 'voice' | 'screen') => {
    const p = pendingRef.current;
    if (!p) return;
    try { apply(await api.post<VoiceResponse>(c(`/voice/sessions/${p.sessionId}/confirm`), { channel, lang: langRef.current })); }
    catch (e) { say(e instanceof ApiError ? e.message : 'Could not post.'); }
  }, [apply, say]);

  const cancel = useCallback(async () => {
    const p = pendingRef.current;
    if (!p) return;
    apply(await api.post<VoiceResponse>(c(`/voice/sessions/${p.sessionId}/cancel`), { lang: langRef.current }));
  }, [apply]);

  const handle = useCallback(async (text: string, confidence: number | null) => {
    setLog((l) => [...l, { who: 'you', text }]);
    const p = pendingRef.current;
    if (p && CONFIRM_RE.test(text.trim())) return confirm('voice');
    if (p && CANCEL_RE.test(text.trim())) return cancel();
    setBusy(true);
    try {
      apply(await api.post<VoiceResponse>(c('/voice/utterance'), {
        transcript: text, confidence, sessionId: sessionRef.current, screen: app.route.screen, lang: langRef.current,
      }));
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally { setBusy(false); }
  }, [app.route.screen, apply, cancel, confirm, say]);
  handleRef.current = handle;

  // Hold Ctrl+Space to talk.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && (e.ctrlKey || e.metaKey) && !e.repeat) {
        e.preventDefault();
        if (!open) onOpen();
        window.speechSynthesis?.cancel();
        startListening();
      }
    };
    const up = (e: KeyboardEvent) => { if ((e.code === 'Space' || e.key === 'Control') && rec.current) stopListening(); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  }, [open, onOpen, startListening, stopListening]);

  useKeys({ 'Ctrl+A': () => { void confirm('screen'); } }, Boolean(pending));
  useKeys({ Escape: () => { onClose(); } }, open && !pending);

  if (!open) return null;
  const L = LANGS[lang];
  const preview = pending?.kind === 'voucher' ? pending.draft.preview : null;
  const missingVoice = lang !== 'en' && voices.length > 0 && !pickVoice(voices, L.tts);
  return (
    <aside className="voice" aria-label="Voice assistant" lang={lang === 'ta' ? 'ta' : 'en'}>
      <div className="voice-head">
        <strong>Voice</strong>
        <span className={`dot ${listening ? 'on' : ''}`} aria-hidden />
        <span className="muted small">{listening ? 'listening…' : busy ? 'thinking…' : SR ? 'hold Ctrl+Space' : 'type below'}</span>
        <select className="voice-lang" value={lang} onChange={(e) => setLang(e.target.value as VLang)} aria-label="Voice language" disabled={listening}>
          {(Object.keys(LANGS) as VLang[]).map((k) => <option key={k} value={k}>{LANGS[k].label}</option>)}
        </select>
        <button className="ghost" onClick={onClose} aria-label="Close voice panel">×</button>
      </div>
      {!app.status.aiEnabled && <div className="warn small">Voice needs ANTHROPIC_API_KEY in .env (server restart required).</div>}
      {missingVoice && <div className="warn small">{L.noVoice}</div>}
      <div className="voice-log" aria-live="polite">
        {log.length === 0 && <p className="muted small">Try: {L.examples.map((x) => `“${x}”`).join(' · ')}</p>}
        {log.slice(-8).map((m, i) => <p key={i} className={m.who}>{m.text}</p>)}
        {interim && <p className="you interim">{interim}</p>}
      </div>
      {preview && pending?.kind === 'voucher' && (
        <div className="voice-card">
          <table className="mini"><tbody>{preview.entries.map((e, i) => {
            const v = BigInt(e.amountMinor);
            return <tr key={i}><td>{e.ledgerName}</td><td className="num">{v > 0n ? inr(v) : ''}</td><td className="num">{v < 0n ? inr(-v) : ''}</td></tr>;
          })}</tbody></table>
          {pending.draft.warnings.map((w) => <div key={w} className="warn small">{w}</div>)}
          <div className="voice-actions">
            <button className="primary" onClick={() => void confirm('screen')}>Post <Kbd>Ctrl+A</Kbd></button>
            <button onClick={() => void cancel()}>Cancel</button>
          </div>
        </div>
      )}
      {pending?.kind === 'reverse' && (
        <div className="voice-actions">
          <button className="danger" onClick={() => void confirm('screen')}>Reverse No. {pending.target.voucherNo} <Kbd>Ctrl+A</Kbd></button>
          <button onClick={() => void cancel()}>Cancel</button>
        </div>
      )}
      <form className="voice-type" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) { void handle(typed.trim(), null); setTyped(''); } }}>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={L.typeHint} aria-label="Type a command" />
        {SR && <button type="button" className={listening ? 'primary' : ''} aria-label="Hold to talk" onMouseDown={() => startListening()} onMouseUp={stopListening} onTouchStart={() => startListening()} onTouchEnd={stopListening}>🎙</button>}
      </form>
    </aside>
  );
}

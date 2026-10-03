# Kannaku AI

A keyboard-first, AI-assisted double-entry accounting app for Indian businesses (GST), built from the
[AI-First Accounting Platform spec](https://claude.ai/code/artifact/1d086c6c-3ed3-48f3-8a2a-ed11c86db758).

Scanned bills and voice commands become **draft** vouchers that a person confirms. The AI never writes
to the ledger; a deterministic posting engine is the only path into it.

## Run it

Requires Node.js 22 or later. Nothing else to install: the database is PostgreSQL compiled to
WebAssembly ([PGlite](https://pglite.dev)), stored in `./data`.

```bash
npm install
npm start            # builds the web app and serves everything on http://127.0.0.1:4000
```

Open the page and **create an account**: your name, email and password, then your business (name,
GSTIN, state, books start date). Kannaku AI sets up that company's books with the standard 28 groups.
Tick "Also add a sample company" to get **Sharma Building Supplies** (Pune), with three months of
purchases, sales, receipts and payments, to explore alongside your own books.

- Passwords are stored as scrypt hashes; sessions are HttpOnly cookies valid for 30 days.
- Five wrong passwords lock that email for 15 minutes.
- Each account sees only its own businesses. Add more from the business name in the top bar.
- Books created before accounts existed (an older install) are added to the first account that signs up.
- `LEDGERAI_DEMO=1 npm start` pre-loads the sample company on an empty install.

For development with hot reload: `npm run dev`, then open http://localhost:5173.

### Turn on AI (bill scanning and voice)

```bash
cp .env.example .env   # then set ANTHROPIC_API_KEY=...
```

Restart the server. The top bar shows **AI on**. Without a key everything else works and the AI
screens say what is missing.

To try the bill-review screen without a key: stop the server, run `npm run demo:bill`, start again
and press **R** on the Gateway.

### Other commands

| Command | What it does |
| --- | --- |
| `npm test` | Server tests: tax engine, posting rules, immutability, reports, voice and OCR pipelines (model mocked) |
| `npm run typecheck` | TypeScript checks for server and web |
| `npm run reset-db` | Deletes `./data` (all accounts and books); the next start shows sign-up again |
| `npm run demo:bill` | Puts a sample extracted bill into the review queue (server must be stopped) |

## Keyboard

| Key | Action |
| --- | --- |
| F8 / F9 | Sales / Purchase |
| F5 / F6 | Payment / Receipt |
| F4 / F7 | Contra / Journal |
| Alt+F6 / Alt+F5 | Credit Note / Debit Note |
| Ctrl+A | Post (voucher entry, bill review, voice confirmation) |
| F2 | Change date / period |
| Alt+C | Create a party, ledger or item from any picker |
| Ctrl+K or Alt+G | Go to any report, voucher type or ledger |
| Ctrl+U | Upload bills |
| Ctrl+Space (hold) | Talk (Chrome / Edge speech recognition; English/Hinglish or Tamil) |
| Alt+A / Alt+X | Alter / reverse the open voucher |
| Esc | Back |
| Gateway letters | D Day Book · T Trial Balance · P P&L · B Balance Sheet · A/Y Ageing · L Ledger · S Stock · G GST · M Masters · R Bills |

## How it is built

```
server/  Fastify + PGlite (TypeScript, run with tsx)
  src/db/migrations   schema: append-only ledger tables, deferred balance trigger, ltree groups, pg_trgm matching
  src/ledger          contracts (Zod), posting plans per voucher type, posting engine, masters
  src/tax             India GST engine (CGST/SGST/UTGST/IGST, inclusive pricing, round-off, RCM)
  src/inventory       FIFO and moving-average valuation (periodic, Tally model)
  src/reports         trial balance, P&L, balance sheet, ageing, daybook, ledger, GST summary
  src/ai              bill extraction (Claude, structured output) + validators + resolver; voice intent engine
web/     React 19 + Vite, no UI framework; one keymap registry drives every shortcut
```

Integrity guarantees, enforced in the database as well as in code:

- Amounts are `BIGINT` paise; no floats touch money.
- `vouchers`, `ledger_entries`, `bill_allocations`, `voucher_tax_lines` and `inventory_entries` reject
  UPDATE, DELETE and TRUNCATE. Corrections are reversals; **Alter** reverses and re-posts in one transaction.
- A deferred constraint trigger rejects any voucher whose lines do not sum to zero at commit.
- Every voucher is SHA-256 hash-chained to the previous one (Settings → Verify hash chain).
- Gapless numbering per voucher type and fiscal year; idempotency keys stop double posting.
- Duplicate supplier bills, negative stock, locked periods and wrong-group parties are blocked or confirmed.

AI guardrails (spec sections 3 and 4):

- Bills: the model transcribes only; code checks GSTIN check digits, line and invoice arithmetic, tax
  split vs. place of supply, amount in words, duplicates and dates, recomputes tax with its own engine,
  and shows every finding to a reviewer before posting. Reviewer corrections teach the matcher.
- Voice: numbers are normalised deterministically (Indian English, Hindi and Tamil, lakh/crore); every amount
  the model returns must cite words that were actually heard; debit/credit is never model output;
  confirmation is a fixed grammar, valid for 60 seconds and tied to the draft's hash; amounts above
  the voice limit (default ₹1,00,000) or back-dated over 7 days need Ctrl+A on screen.

## Voice languages

Pick the language in the voice panel; the choice is remembered per browser.

| Language | Speech recognition | Readback | Notes |
| --- | --- | --- | --- |
| English / Hinglish | en-IN | English | Hindi number words (pachpan sau, dedh lakh) are understood |
| தமிழ் Tamil | ta-IN | Tamil | Tamil-script and romanised number words (ஐயாயிரத்து ஐநூறு, anju aayiram); confirm with சரி, cancel with வேண்டாம் |

Tamil script in what you say switches replies to Tamil even when English is selected. Party and item
names stay in English in the books; Tamil speech is transliterated to find them, and the model matches
names by sound. Spoken Tamil replies need a Tamil voice in the browser: Microsoft Edge includes one;
without it, replies are shown as text. The Tamil message templates are in
`server/src/ai/voice/i18n.ts` and should be reviewed by a native speaker before customers use them.

## Not built yet

Compared with the spec, this build leaves out:

- **GST filing:** GSTR-1/3B JSON export, GSTR-2B reconciliation, e-invoice / e-way bill (Phase 4).
- **Multi-tenancy:** user accounts, roles, the desktop app, TDS/TCS (Phase 4).
- **Opening stock entry for items:** record stock through purchases for now.
- **Bill reading:** no e-invoice QR decoding and no image pre-processing (deskew, crop); embeddings
  are not used in matching (trigram similarity only).
- **Voice:** uses the browser's speech recognition and speech synthesis rather than a server STT, and
  journal entries by voice are redirected to the screen.
- **Single process:** PGlite runs inside the server; for a multi-user deployment, point the same SQL
  at a PostgreSQL server and replace the in-process job queue with pg-boss.

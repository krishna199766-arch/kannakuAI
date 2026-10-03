-- One uploaded document can yield many entries (a bank statement line each, a journal per working,
-- a voucher per register row). Safe to re-run.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_type text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS summary jsonb;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS bank_ledger_id uuid REFERENCES ledgers(id);

CREATE TABLE IF NOT EXISTS document_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         uuid NOT NULL REFERENCES documents(id),
  company_id          uuid NOT NULL REFERENCES companies(id),
  line_no             int NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('BANK_LINE','JOURNAL','REGISTER_ROW')),
  status              text NOT NULL CHECK (status IN ('READY','NEEDS_INPUT','IN_BOOKS','POSTED','SKIPPED')),
  source              jsonb NOT NULL,          -- the row as read from the document
  payload             jsonb,                   -- proposed VoucherInput
  suggestion          jsonb,                   -- how it was matched: {how, confidence, reason, ...}
  issues              jsonb NOT NULL DEFAULT '[]',
  matched_voucher_id  uuid REFERENCES vouchers(id),   -- already in the books
  voucher_id          uuid REFERENCES vouchers(id),   -- posted from this entry
  amount_minor        bigint,
  entry_date          date,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, line_no)
);
CREATE INDEX IF NOT EXISTS document_entries_doc_idx ON document_entries (document_id, status);

-- Bank narration -> ledger, learned when a reviewer picks or corrects the ledger for a statement line.
CREATE TABLE IF NOT EXISTS narration_rules (
  company_id  uuid NOT NULL REFERENCES companies(id),
  pattern     text NOT NULL,
  direction   text NOT NULL CHECK (direction IN ('IN','OUT')),
  ledger_id   uuid NOT NULL REFERENCES ledgers(id),
  hits        int NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, pattern, direction)
);
CREATE INDEX IF NOT EXISTS narration_rules_trgm ON narration_rules USING gin (pattern gin_trgm_ops);

-- Auto-post: entries that pass every check are posted without a click (off by default).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_post boolean NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_post_limit_minor bigint NOT NULL DEFAULT 5000000;   -- Rs 50,000

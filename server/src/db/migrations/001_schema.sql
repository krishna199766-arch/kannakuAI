CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- Tenancy ----------
CREATE TABLE companies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  name                text NOT NULL,
  gstin               char(15),
  state_code          char(2) NOT NULL,
  base_currency       char(3) NOT NULL DEFAULT 'INR',
  fy_start_month      smallint NOT NULL DEFAULT 4,
  books_from          date NOT NULL,
  lock_date           date,
  round_invoice       boolean NOT NULL DEFAULT true,
  voice_limit_minor   bigint NOT NULL DEFAULT 10000000,      -- Rs 1,00,000
  journal_allows_cash boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------- Chart of accounts ----------
CREATE TYPE account_nature AS ENUM ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE');

CREATE TABLE ledger_groups (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  parent_id             uuid REFERENCES ledger_groups(id),
  name                  text NOT NULL,
  nature                account_nature NOT NULL,
  affects_gross_profit  boolean NOT NULL DEFAULT false,
  system_code           text,
  path                  ltree NOT NULL,
  sort_order            int NOT NULL DEFAULT 100,
  UNIQUE (company_id, name),
  UNIQUE (company_id, system_code)
);
CREATE INDEX ON ledger_groups USING gist (path);

CREATE TABLE counterparties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  legal_name      text NOT NULL,
  norm_name       text NOT NULL,
  gstin           char(15),
  pan             char(10),
  gst_reg_type    text NOT NULL DEFAULT 'UNREGISTERED' CHECK (gst_reg_type IN
                  ('REGULAR','COMPOSITION','UNREGISTERED','CONSUMER','SEZ','OVERSEAS')),
  state_code      char(2),
  city            text,
  phone           text,
  credit_days     int,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PROVISIONAL','INACTIVE')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, gstin)
);
CREATE INDEX ON counterparties USING gin (norm_name gin_trgm_ops);

CREATE TABLE party_aliases (                     -- learned from reviewer confirmations
  company_id       uuid NOT NULL REFERENCES companies(id),
  alias_norm       text NOT NULL,
  counterparty_id  uuid NOT NULL REFERENCES counterparties(id),
  PRIMARY KEY (company_id, alias_norm)
);

CREATE TABLE ledgers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  group_id         uuid NOT NULL REFERENCES ledger_groups(id),
  name             text NOT NULL,
  norm_name        text NOT NULL,
  aliases          text[] NOT NULL DEFAULT '{}',
  counterparty_id  uuid REFERENCES counterparties(id),
  bill_wise        boolean NOT NULL DEFAULT false,
  tax_component    text CHECK (tax_component IN ('CGST','SGST','UTGST','IGST','CESS','TDS','TCS')),
  tax_direction    text CHECK (tax_direction IN ('INPUT','OUTPUT','RCM_PAYABLE')),
  tax_rate_ppm     int,
  system_code      text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name),
  UNIQUE (company_id, system_code)
);
CREATE INDEX ON ledgers USING gin (norm_name gin_trgm_ops);

-- ---------- Inventory masters ----------
CREATE TABLE uoms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  symbol      text NOT NULL,
  uqc         char(3) NOT NULL,
  decimals    smallint NOT NULL DEFAULT 0,
  UNIQUE (company_id, symbol)
);

CREATE TABLE godowns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  parent_id   uuid REFERENCES godowns(id),
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  UNIQUE (company_id, name)
);

CREATE TABLE stock_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  name              text NOT NULL,
  norm_name         text NOT NULL,
  aliases           text[] NOT NULL DEFAULT '{}',
  base_uom_id       uuid NOT NULL REFERENCES uoms(id),
  hsn_sac           text,
  gst_rate_ppm      int,
  valuation         text NOT NULL DEFAULT 'WAVG' CHECK (valuation IN ('FIFO','WAVG')),
  allow_negative    boolean NOT NULL DEFAULT false,
  sales_ledger_id   uuid REFERENCES ledgers(id),
  purchase_ledger_id uuid REFERENCES ledgers(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
CREATE INDEX ON stock_items USING gin (norm_name gin_trgm_ops);

CREATE TABLE vendor_line_memory (                -- supplier + description -> item / ledger
  company_id       uuid NOT NULL REFERENCES companies(id),
  counterparty_id  uuid NOT NULL REFERENCES counterparties(id),
  desc_norm        text NOT NULL,
  item_id          uuid REFERENCES stock_items(id),
  ledger_id        uuid REFERENCES ledgers(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, counterparty_id, desc_norm)
);

-- ---------- Vouchers ----------
CREATE TABLE voucher_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  base_type   text NOT NULL CHECK (base_type IN ('SALES','PURCHASE','PAYMENT','RECEIPT',
              'JOURNAL','CONTRA','DEBIT_NOTE','CREDIT_NOTE','STOCK_JOURNAL','OPENING')),
  prefix      text NOT NULL DEFAULT '',
  is_default  boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, name)
);

CREATE TABLE voucher_series (
  voucher_type_id  uuid NOT NULL REFERENCES voucher_types(id),
  fiscal_year      smallint NOT NULL,
  next_no          bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (voucher_type_id, fiscal_year)
);

CREATE TABLE voucher_drafts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  payload            jsonb NOT NULL,
  source             text NOT NULL CHECK (source IN ('MANUAL','OCR','VOICE','IMPORT','API')),
  source_ref         uuid,
  field_confidence   jsonb,
  status             text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','POSTED','DISCARDED')),
  posted_voucher_id  uuid,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vouchers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  voucher_type_id      uuid NOT NULL REFERENCES voucher_types(id),
  fiscal_year          smallint NOT NULL,
  voucher_no           text NOT NULL,
  voucher_date         date NOT NULL,
  counterparty_id      uuid REFERENCES counterparties(id),
  party_ref_no         text,
  party_ref_date       date,
  original_ref         text,
  place_of_supply      char(2),
  reverse_charge       boolean NOT NULL DEFAULT false,
  payment_mode         text,
  narration            text,
  total_minor          bigint NOT NULL,
  source               text NOT NULL,
  draft_id             uuid REFERENCES voucher_drafts(id),
  input                jsonb,                    -- the VoucherInput it was posted from (for "Alter")
  idempotency_key      text NOT NULL,
  reverses_voucher_id  uuid REFERENCES vouchers(id),
  chain_seq            bigint NOT NULL,
  prev_hash            bytea,
  row_hash             bytea NOT NULL,
  posted_by            uuid NOT NULL,
  posted_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, idempotency_key),
  UNIQUE (voucher_type_id, fiscal_year, voucher_no),
  UNIQUE (company_id, chain_seq),
  UNIQUE (reverses_voucher_id)
);
CREATE INDEX ON vouchers (company_id, counterparty_id, fiscal_year, lower(party_ref_no));
CREATE INDEX ON vouchers (company_id, voucher_date);

CREATE TABLE ledger_entries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      uuid NOT NULL,
  voucher_id      uuid NOT NULL REFERENCES vouchers(id),
  line_no         smallint NOT NULL,
  ledger_id       uuid NOT NULL REFERENCES ledgers(id),
  amount_minor    bigint NOT NULL CHECK (amount_minor <> 0),
  voucher_date    date NOT NULL,
  UNIQUE (voucher_id, line_no)
);
CREATE INDEX ON ledger_entries (company_id, ledger_id, voucher_date);
CREATE INDEX ON ledger_entries (company_id, voucher_date);

CREATE TABLE bill_allocations (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       uuid NOT NULL,
  ledger_entry_id  bigint NOT NULL REFERENCES ledger_entries(id),
  ledger_id        uuid NOT NULL REFERENCES ledgers(id),
  bill_ref         text NOT NULL,
  alloc_type       text NOT NULL CHECK (alloc_type IN ('NEW_REF','AGST_REF','ADVANCE','ON_ACCOUNT')),
  amount_minor     bigint NOT NULL,
  bill_date        date NOT NULL,
  due_date         date
);
CREATE INDEX ON bill_allocations (company_id, ledger_id, bill_ref);

CREATE TABLE voucher_tax_lines (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       uuid NOT NULL,
  voucher_id       uuid NOT NULL REFERENCES vouchers(id),
  item_line_no     smallint,
  hsn_sac          text,
  component        text NOT NULL CHECK (component IN ('CGST','SGST','UTGST','IGST','CESS')),
  rate_ppm         int NOT NULL,
  taxable_minor    bigint NOT NULL,
  tax_minor        bigint NOT NULL,
  ledger_id        uuid NOT NULL REFERENCES ledgers(id),
  direction        text NOT NULL CHECK (direction IN ('INPUT','OUTPUT')),
  reverse_charge   boolean NOT NULL DEFAULT false,
  itc_eligible     boolean NOT NULL DEFAULT true,
  voucher_date     date NOT NULL
);

CREATE TABLE inventory_entries (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    uuid NOT NULL,
  voucher_id    uuid NOT NULL REFERENCES vouchers(id),
  line_no       smallint NOT NULL,
  item_id       uuid NOT NULL REFERENCES stock_items(id),
  godown_id     uuid NOT NULL REFERENCES godowns(id),
  qty           numeric(18,4) NOT NULL CHECK (qty <> 0),
  unit_cost     numeric(20,6),
  voucher_date  date NOT NULL,
  chain_seq     bigint NOT NULL
);
CREATE INDEX ON inventory_entries (company_id, item_id, voucher_date, chain_seq);

-- ---------- AI ingestion ----------
CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  sha256          text NOT NULL,
  file_name       text NOT NULL,
  storage_key     text NOT NULL,
  mime            text NOT NULL,
  size_bytes      int NOT NULL,
  status          text NOT NULL CHECK (status IN ('RECEIVED','PROCESSING','NEEDS_REVIEW',
                  'ACCEPTED','REJECTED','FAILED')),
  error           text,
  extraction      jsonb,
  validation      jsonb,
  matches         jsonb,
  draft_id        uuid REFERENCES voucher_drafts(id),
  voucher_id      uuid REFERENCES vouchers(id),
  model           text,
  prompt_version  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sha256)
);

CREATE TABLE voice_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','POSTED','CANCELLED')),
  kind            text,                         -- VOUCHER | REVERSE
  transcripts     jsonb NOT NULL DEFAULT '[]',
  last_call       jsonb,
  draft_id        uuid REFERENCES voucher_drafts(id),
  draft_hash      text,
  target_voucher_id uuid REFERENCES vouchers(id),
  readback        text,
  readback_at     timestamptz,
  total_minor     bigint,
  voucher_id      uuid REFERENCES vouchers(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voice_turns (                      -- audit trail of every utterance
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id      uuid NOT NULL REFERENCES voice_sessions(id),
  transcript      text NOT NULL,
  normalized      text NOT NULL,
  stt_confidence  real,
  model           text,
  prompt_version  text,
  tool_call       jsonb,
  grounding       jsonb,
  response        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  uuid NOT NULL,
  actor       uuid NOT NULL,
  channel     text NOT NULL,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);

-- ---------- Integrity: append-only + balanced at commit ----------
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; post a reversal instead', TG_TABLE_NAME;
END $$;

CREATE TRIGGER vouchers_append_only BEFORE UPDATE OR DELETE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER allocations_append_only BEFORE UPDATE OR DELETE ON bill_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER tax_lines_append_only BEFORE UPDATE OR DELETE ON voucher_tax_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER inventory_append_only BEFORE UPDATE OR DELETE ON inventory_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER vouchers_no_truncate BEFORE TRUNCATE ON vouchers
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION assert_voucher_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vid uuid; s bigint; n int;
BEGIN
  IF TG_TABLE_NAME = 'vouchers' THEN vid := NEW.id; ELSE vid := NEW.voucher_id; END IF;
  SELECT COALESCE(SUM(amount_minor), 0), COUNT(*) INTO s, n
    FROM ledger_entries WHERE voucher_id = vid;
  IF n < 2 OR s <> 0 THEN
    RAISE EXCEPTION 'voucher % unbalanced (sum=%, lines=%)', vid, s, n;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER vouchers_balanced AFTER INSERT ON vouchers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_voucher_balanced();
CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_voucher_balanced();

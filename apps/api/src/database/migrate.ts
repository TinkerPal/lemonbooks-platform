import { pool } from "./pool";
import { whatsappLinkSchema } from "./whatsapp-link-schema";

const schema = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug text NOT NULL UNIQUE,
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  address text,
  country_code char(2),
  currency char(3),
  timezone text NOT NULL DEFAULT 'Africa/Lagos',
  logo_url text,
  onboarding_completed boolean NOT NULL DEFAULT false,
  payment_provider text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);
CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member','accountant')),
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);

CREATE TABLE IF NOT EXISTS signup_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  tenant_slug text NOT NULL,
  payload jsonb NOT NULL,
  otp_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text,
  phone text,
  company text,
  address text,
  balance numeric(14,2) NOT NULL DEFAULT 0,
  sync_version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  kind text NOT NULL DEFAULT 'product' CHECK (kind IN ('product','service')),
  sku text,
  price numeric(14,2) NOT NULL DEFAULT 0,
  cost numeric(14,2) NOT NULL DEFAULT 0,
  stock_quantity numeric(14,3),
  low_stock_threshold numeric(14,3),
  active boolean NOT NULL DEFAULT true,
  sync_version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, sku)
);

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  number text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','part_paid','paid','overdue','cancelled')),
  issue_date date NOT NULL DEFAULT current_date,
  due_date date,
  currency char(3) NOT NULL,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  tax numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid numeric(14,2) NOT NULL DEFAULT 0,
  notes text,
  sync_version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, number)
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item_id uuid REFERENCES items(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity numeric(14,3) NOT NULL DEFAULT 1,
  unit_price numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  amount numeric(14,2) NOT NULL,
  currency char(3) NOT NULL,
  method text NOT NULL CHECK (method IN ('cash','transfer','card','pos','other')),
  reference text,
  status text NOT NULL DEFAULT 'confirmed',
  received_at timestamptz NOT NULL DEFAULT now(),
  sync_version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_changes (
  sequence bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  table_name text NOT NULL,
  record_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('created','updated','deleted')),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clients_business_idx ON clients(business_id, updated_at);
CREATE INDEX IF NOT EXISTS items_business_idx ON items(business_id, updated_at);
CREATE INDEX IF NOT EXISTS invoices_business_idx ON invoices(business_id, updated_at);
CREATE INDEX IF NOT EXISTS payments_business_idx ON payments(business_id, received_at);
CREATE INDEX IF NOT EXISTS sync_changes_business_sequence_idx ON sync_changes(business_id, sequence);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at timestamptz;

CREATE TABLE IF NOT EXISTS payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('paystack','monnify')),
  reference text NOT NULL UNIQUE,
  access_code text,
  authorization_url text,
  amount numeric(14,2) NOT NULL,
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed','abandoned')),
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_intents_business_idx ON payment_intents(business_id,created_at);
ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_provider_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_provider_check CHECK (provider IN ('paystack','monnify'));
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS allocations jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS group_reference text;
UPDATE payments SET group_reference=reference WHERE group_reference IS NULL AND reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payments_business_reference_idx ON payments(business_id,reference) WHERE reference IS NOT NULL;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS public_token uuid DEFAULT gen_random_uuid();
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'not_sent';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS inventory_posted_at timestamptz;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS delivery_error text;
WITH unposted_sales AS (
  SELECT il.item_id,sum(il.quantity) AS quantity FROM invoices inv
  JOIN invoice_lines il ON il.invoice_id=inv.id
  WHERE inv.status='paid' AND inv.inventory_posted_at IS NULL AND il.item_id IS NOT NULL
  GROUP BY il.item_id
)
UPDATE items i SET stock_quantity=GREATEST(0,i.stock_quantity-u.quantity),sync_version=i.sync_version+1,updated_at=now()
FROM unposted_sales u WHERE i.id=u.item_id AND i.kind='product' AND i.stock_quantity IS NOT NULL;
UPDATE invoices SET inventory_posted_at=now() WHERE status='paid' AND inventory_posted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_public_token_idx ON invoices(public_token);

CREATE TABLE IF NOT EXISTS payment_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('cash','transfer')),
  payer_name text NOT NULL,
  paid_to text,
  amount numeric(14,2) NOT NULL,
  paid_at timestamptz NOT NULL,
  note text,
  receipt_name text,
  receipt_mime text,
  receipt_data bytea,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_claims_business_idx ON payment_claims(business_id,status,created_at);
ALTER TABLE payment_claims ADD COLUMN IF NOT EXISTS group_reference text;
CREATE INDEX IF NOT EXISTS payment_claims_group_idx ON payment_claims(business_id,group_reference);

CREATE TABLE IF NOT EXISTS client_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,email), UNIQUE (business_id,client_id)
);
ALTER TABLE client_accounts ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS client_auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('activate','login')),
  otp_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_auth_challenges_lookup_idx ON client_auth_challenges(business_id,email,purpose,created_at DESC);

CREATE TABLE IF NOT EXISTS business_payment_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'paystack' CHECK (provider IN ('paystack')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','failed','disabled')),
  settlement_bank_code text NOT NULL,
  settlement_bank_name text,
  settlement_account_number text NOT NULL,
  settlement_account_name text,
  platform_fee_percent numeric(5,2) NOT NULL DEFAULT 0,
  provider_subaccount_code text UNIQUE,
  provider_customer_code text UNIQUE,
  provider_dva_id text UNIQUE,
  virtual_bank_name text,
  virtual_bank_slug text,
  virtual_account_number text UNIQUE,
  virtual_account_name text,
  currency char(3) NOT NULL DEFAULT 'NGN',
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS business_transfer_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  bank_code text NOT NULL,
  bank_name text NOT NULL,
  account_number text NOT NULL,
  account_name text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_payment_accounts_lookup_idx ON business_payment_accounts(provider_customer_code,virtual_account_number);

CREATE TABLE IF NOT EXISTS integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('bank','payment_provider','whatsapp')), provider text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','attention','revoked','failed')),
  environment text NOT NULL DEFAULT 'mock', external_account_id text, external_business_id text,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb, encrypted_credentials text,
  consent_scope jsonb NOT NULL DEFAULT '[]'::jsonb, consented_by uuid REFERENCES users(id), consented_at timestamptz,
  consent_expires_at timestamptz, last_success_at timestamptz, last_cursor text, last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS integration_connection_external_idx ON integration_connections(provider,environment,external_account_id) WHERE external_account_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS integration_connection_business_idx ON integration_connections(business_id,kind,status);

CREATE TABLE IF NOT EXISTS integration_signup_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider text NOT NULL, state_hash text NOT NULL UNIQUE, requested_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','expired','failed')),
  expires_at timestamptz NOT NULL, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_signup_sessions_business_idx ON integration_signup_sessions(business_id,provider,created_at DESC);

CREATE TABLE IF NOT EXISTS integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES integration_connections(id) ON DELETE SET NULL, provider text NOT NULL, environment text NOT NULL DEFAULT 'mock',
  provider_event_id text NOT NULL, event_type text NOT NULL, payload_hash text NOT NULL, raw_payload jsonb NOT NULL,
  signature_valid boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','processing','processed','ignored','failed','dead_letter')),
  occurred_at timestamptz, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, attempts integer NOT NULL DEFAULT 0,
  error_code text, correlation_id uuid NOT NULL DEFAULT gen_random_uuid(), UNIQUE(provider,environment,provider_event_id)
);
CREATE INDEX IF NOT EXISTS integration_events_business_idx ON integration_events(business_id,received_at DESC);

CREATE TABLE IF NOT EXISTS integration_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_id uuid REFERENCES integration_events(id) ON DELETE CASCADE, job_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','completed','failed','dead_letter')),
  available_at timestamptz NOT NULL DEFAULT now(), lease_owner text, lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5, last_error text,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS integration_jobs_claim_idx ON integration_jobs(state,available_at,lease_expires_at);

CREATE TABLE IF NOT EXISTS integration_audit_log (
  id bigserial PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES integration_connections(id) ON DELETE SET NULL, actor_type text NOT NULL,
  actor_id text, action text NOT NULL, resource_type text NOT NULL, resource_id text,
  before_summary jsonb, after_summary jsonb, reason text, correlation_id uuid NOT NULL DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_audit_business_idx ON integration_audit_log(business_id,created_at DESC);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_type text NOT NULL, aggregate_type text NOT NULL, aggregate_id uuid, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','published','failed','dead_letter')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  idempotency_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(status,available_at);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, provider_account_id text NOT NULL,
  name text NOT NULL, institution_name text NOT NULL, account_type text NOT NULL DEFAULT 'business', masked_account_number text,
  currency char(3) NOT NULL, current_balance numeric(14,2), available_balance numeric(14,2), balance_at timestamptz,
  status text NOT NULL DEFAULT 'active', last_cursor text, last_synced_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,provider_account_id)
);
CREATE INDEX IF NOT EXISTS bank_accounts_business_idx ON bank_accounts(business_id,status);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE, provider text NOT NULL, provider_transaction_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','booked','reversed','deleted')), direction text NOT NULL CHECK(direction IN ('credit','debit')),
  amount numeric(14,2) NOT NULL CHECK(amount>=0), currency char(3) NOT NULL, description text NOT NULL DEFAULT '', narration text,
  reference text, session_id text, counterparty_name text, counterparty_bank text, counterparty_account_masked text,
  transacted_at timestamptz NOT NULL, value_date date, booked_at timestamptz, running_balance numeric(14,2),
  fingerprint text NOT NULL, source_event_id uuid REFERENCES integration_events(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(bank_account_id,provider_transaction_id)
);
CREATE INDEX IF NOT EXISTS bank_transactions_feed_idx ON bank_transactions(business_id,transacted_at DESC);
CREATE INDEX IF NOT EXISTS bank_transactions_match_idx ON bank_transactions(business_id,direction,currency,amount,status);

CREATE TABLE IF NOT EXISTS reconciliation_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bank_transaction_id uuid NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE, target_type text NOT NULL,
  target_id uuid NOT NULL, proposed_amount numeric(14,2) NOT NULL, score numeric(5,2) NOT NULL,
  rule_version text NOT NULL, reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL DEFAULT 'suggested' CHECK(state IN ('suggested','accepted','rejected','expired','superseded')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(bank_transaction_id,target_type,target_id)
);
CREATE INDEX IF NOT EXISTS reconciliation_candidates_business_idx ON reconciliation_candidates(business_id,state,score DESC);

CREATE TABLE IF NOT EXISTS reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bank_transaction_id uuid NOT NULL REFERENCES bank_transactions(id), status text NOT NULL CHECK(status IN ('matched','partially_matched','unmatched','ignored','reversed')),
  method text NOT NULL CHECK(method IN ('automatic','manual','rule')), allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence numeric(5,2), rule_version text, actor_id uuid REFERENCES users(id), reversal_of uuid REFERENCES reconciliations(id),
  reason text, created_at timestamptz NOT NULL DEFAULT now(), reversed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_active_transaction_idx ON reconciliations(bank_transaction_id) WHERE status IN ('matched','partially_matched','ignored');

CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  provider_contact_id text, phone_e164 text NOT NULL, display_name text, consent_state text NOT NULL DEFAULT 'unknown' CHECK(consent_state IN ('unknown','opted_in','opted_out')),
  consent_source text, consented_at timestamptz, opted_out_at timestamptz, last_inbound_at timestamptz, service_window_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(connection_id,phone_e164)
);
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, contact_id uuid NOT NULL REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','awaiting_customer','awaiting_business','resolved','blocked')),
  assigned_user_id uuid REFERENCES users(id), linked_invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  last_inbound_at timestamptz, last_outbound_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,contact_id)
);
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE, provider_message_id text NOT NULL,
  direction text NOT NULL CHECK(direction IN ('inbound','outbound')), message_type text NOT NULL DEFAULT 'text', body text,
  provider_status text NOT NULL DEFAULT 'received', reply_to_provider_id text, template_name text, template_category text,
  automation_run_id uuid, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(business_id,provider_message_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_messages_conversation_idx ON whatsapp_messages(conversation_id,occurred_at);
CREATE TABLE IF NOT EXISTS whatsapp_media_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES whatsapp_messages(id) ON DELETE CASCADE,
  provider_media_id text NOT NULL, media_type text NOT NULL, mime_type text,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed','dead_letter')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  transcript text, extraction jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,provider_media_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_media_jobs_ready_idx ON whatsapp_media_jobs(available_at) WHERE status IN ('queued','failed');
CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE, provider_template_id text,
  name text NOT NULL, language text NOT NULL DEFAULT 'en', category text NOT NULL, status text NOT NULL DEFAULT 'mock_approved',
  body text NOT NULL, parameter_schema jsonb NOT NULL DEFAULT '[]'::jsonb, synced_at timestamptz, UNIQUE(connection_id,name,language)
);
CREATE TABLE IF NOT EXISTS automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'whatsapp', name text NOT NULL, trigger_type text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  delay_minutes integer NOT NULL DEFAULT 0, quiet_hours jsonb NOT NULL DEFAULT '{"start":"20:00","end":"08:00"}'::jsonb,
  frequency_cap_hours integer NOT NULL DEFAULT 24, template_name text, configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES automation_rules(id) ON DELETE SET NULL, trigger_event_id uuid REFERENCES outbox_events(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES whatsapp_contacts(id) ON DELETE SET NULL, state text NOT NULL CHECK(state IN ('scheduled','suppressed','sent','failed','cancelled')),
  eligibility_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb, provider_message_id text, failure_reason text,
  idempotency_key text NOT NULL UNIQUE, scheduled_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_controls (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  maker_checker_enabled boolean NOT NULL DEFAULT true,
  reconciliation_approval_threshold numeric(14,2) NOT NULL DEFAULT 500000,
  automatic_match_threshold numeric(5,2) NOT NULL DEFAULT 100,
  updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bank_transaction_id uuid REFERENCES bank_transactions(id) ON DELETE SET NULL, vendor_name text, category text NOT NULL DEFAULT 'uncategorized',
  description text NOT NULL, amount numeric(14,2) NOT NULL CHECK(amount>0), currency char(3) NOT NULL,
  expense_date date NOT NULL, status text NOT NULL DEFAULT 'recorded' CHECK(status IN ('draft','recorded','voided')),
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_business_idx ON expenses(business_id,expense_date DESC);
CREATE TABLE IF NOT EXISTS reconciliation_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bank_transaction_id uuid NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE, action text NOT NULL CHECK(action IN ('allocate','expense')),
  request_payload jsonb NOT NULL, amount numeric(14,2) NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
  requested_by uuid NOT NULL REFERENCES users(id), reviewed_by uuid REFERENCES users(id), requested_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz,
  review_note text
);
CREATE INDEX IF NOT EXISTS reconciliation_approvals_business_idx ON reconciliation_approvals(business_id,status,requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_approvals_pending_idx ON reconciliation_approvals(bank_transaction_id) WHERE status='pending';
`;

export async function migrate(): Promise<void> {
  await pool.query(schema);
  await pool.query(whatsappLinkSchema);
}

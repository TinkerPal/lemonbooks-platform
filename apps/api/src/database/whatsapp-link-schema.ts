export const whatsappLinkSchema = `
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE businesses ALTER COLUMN email DROP NOT NULL;
CREATE TABLE IF NOT EXISTS whatsapp_auth_identities (
 phone text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS account_phone_claims (
 phone text PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_phone_claims_user_idx ON account_phone_claims(user_id);
CREATE TABLE IF NOT EXISTS whatsapp_account_link_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  contact_id uuid NOT NULL REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS whatsapp_account_links (
  contact_id uuid PRIMARY KEY REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
  business_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(business_id,user_id) REFERENCES memberships(business_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS whatsapp_link_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL UNIQUE REFERENCES whatsapp_account_link_tickets(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES whatsapp_account_links(contact_id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  body text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed','suppressed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_link_notifications_pending_idx
  ON whatsapp_link_notifications(next_attempt_at) WHERE state='pending';
CREATE TABLE IF NOT EXISTS whatsapp_auth_challenges (
 ticket_id uuid PRIMARY KEY REFERENCES whatsapp_account_link_tickets(id) ON DELETE CASCADE,
 otp_hash text NOT NULL, attempts integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL, sent_at timestamptz NOT NULL DEFAULT now(),
 proof_hash text, verified_at timestamptz
);
ALTER TABLE whatsapp_auth_challenges ADD COLUMN IF NOT EXISTS send_count integer NOT NULL DEFAULT 1;
`;

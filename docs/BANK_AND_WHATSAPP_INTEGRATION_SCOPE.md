# Bank Reconciliation and WhatsApp Business Integration

## WhatsApp-first authentication update — September 5, 2026

WhatsApp REGISTER/LOGIN/CONNECT issues a private, expiring browser link. Signed-out
visitors request an OTP delivered to the initiating WhatsApp contact, verify it in
the browser, then (for new users) enter their name, business name, country, currency,
timezone and optional address. Finish creates the user, workspace, owner membership
and conversation binding atomically, marks onboarding complete and opens the workspace.
Neither email nor password is required. Existing verified phone identities or existing
explicit account links resolve returning users; memberships govern workspace selection.
Unverified business-profile phone fields are never used to infer account ownership.
Existing email-only users must explicitly link their authenticated account first.

Endpoints: POST /api/v3/auth/whatsapp/code, /whatsapp/verify and /whatsapp/finish
(all three under /api/v3/auth). Verification returns a short-lived, random proof;
business details cannot be submitted with just the private link or an unverified code.
OTP hashes and proof hashes are stored, not plaintext secrets. Codes expire in ten
minutes, allow five attempts, and are single-use. Resends invalidate previous codes
and proofs; sends are limited to one per minute and ten per hour per sender.
Consent, active platform connection, unconsumed link and open service window are
checked throughout. Codes are not returned to the browser or written to the inbox/logs.
Delivery failure does not create an account. These are chat-initiated service-window
messages; outside that window the user must send a fresh LOGIN/REGISTER message.

Optional business contact email can be added in Settings. It does not become a
verified email-login identity. Paystack account activation requires a contact email
and prompts for it separately. UNLINK removes conversation authorization, not the
verified phone login identity or business records.

Phone ownership is exclusive across both entry points. A normalized phone claim is
reserved when a WhatsApp workspace is created or linked, and when an email-authenticated
workspace saves its phone in Settings. Existing business phone values are also checked
at write time. Another user or workspace cannot claim the number; the original owner
can use WhatsApp OTP to return to the existing account. Clearing a profile phone does
not release its historical ownership claim.

### WhatsApp audio messages

Incoming `audio` messages are acknowledged immediately, stored as a
`whatsapp_media_jobs` row, and processed by the integration worker. The worker
retrieves protected media from Meta with the encrypted connection token, enforces
the 16 MB limit, sends it to OpenAI transcription, and runs JSON-only extraction
for order, payment, expense, inventory or invoice intent. The transcript is
written back to the conversation. A review-only response includes the transcript,
extracted summary and confidence; it does not create or confirm accounting,
inventory or payment records. Jobs retry up to five times and then become
`dead_letter`. Configure `OPENAI_API_KEY` and optionally
`OPENAI_EXTRACTION_MODEL` (default `gpt-4o-mini`). If the key is missing, the job
fails without exposing audio or creating a record; text messaging remains usable.

Deployment requires both API and web updates. Startup migrations add identity and
OTP tables and permit null user/business emails; existing email accounts remain
unchanged. No new environment variables are required. Real PostgreSQL integration
tests mock Meta delivery; actual production delivery and browser UX need deployment
smoke testing. No accounting or inventory records are posted by signup.

Status: production implementation specification  
Owner: LemonBooks product and engineering  
Last reviewed: 2026-09-05
Initial market: Nigeria  
Initial banking candidate: Moniepoint  
Messaging platform: Meta WhatsApp Business Platform / Cloud API

## Implementation status — 2026-08-22

Implemented and locally testable:

- Shared tenant-scoped connection, immutable event, leased job, dead-letter, audit, and transactional-outbox persistence.
- Provider-neutral bank connector contract and signed Moniepoint-shaped simulator.
- Canonical bank accounts and transactions, CSV statement ingestion, webhook deduplication, asynchronous normalization, and retry worker.
- Exact invoice-reference and exact amount/currency candidate matching with versioned reasons and shadow-mode reporting.
- Manual accept, combined invoice allocations, ignore, and reversible reconciliation APIs with payment, invoice, inventory, audit, and outbox effects.
- Banking workspace with connected account health, statement import, signed credit simulation, money feed, confidence explanations, and suggested-match approval.
- WhatsApp connection, contact, conversation, message, template, consent, service-window, automation-rule, and automation-run persistence.
- Meta Embedded Signup session creation, JavaScript SDK launch, server-side authorization-code exchange, WABA/phone ownership verification, WABA subscription, encrypted production credential persistence, template synchronization, signed production webhook processing, inbound/status deduplication, deterministic invoice/amount/payment-intent extraction, opt-out, human states, and basic template/free-form policy checks.
- WhatsApp workspace with health, inbox, conversation context, simulated inbound messages, delivery states, policy visibility, and automation controls.
- Outbox-driven payment-confirmation automation for Paystack, approved manual claims, and bank reconciliations.
- Automated tests for signed provider normalization, forged signatures, open/closed service windows, opt-out suppression, and evidence-only extraction.
- Production reconciliation workbench for searchable multi-invoice splits, debit-to-expense classification, transaction journeys, reversals, and tenant-scoped audit evidence.
- Configurable maker-checker controls with high-value thresholds, separate-requester approval enforcement, and owner/admin review queues.
- Operator retry/dead-letter views for integration jobs and transactional outbox messages, with explicit idempotent replay actions.
- Scheduled overdue-state detection and idempotent `invoice.overdue` events for downstream WhatsApp reminder automation.
- Opt-in PostgreSQL tests covering concurrent duplicate delivery, concurrent posting, tenant isolation, inventory posting, and dead-letter exhaustion (`RUN_DB_TESTS=1`).
- A separately designated LemonBooks-owned WhatsApp entry point can be provisioned at startup against an existing platform tenant. Valid signed inbound messages are stored and receive deterministic welcome, registration, payment-claim, and draft-record guidance. Single-use WhatsApp links connect verified signup or authenticated existing accounts to the sender; durable confirmation jobs, workspace-aware help, and UNLINK are implemented. Customer-owned WhatsApp connections are never opted into platform auto-replies implicitly.

Still dependent on external approval or follow-up hardening:

- Live Moniepoint account-feed adapter, credentials, account linking, complete event/status mapping, and certification.
- Meta App Review, Advanced Access, Tech Provider approval, production configuration validation, coexistence onboarding/confirmation, number-registration recovery, Meta business-verification status, token renewal, and complete Meta-side revocation.
- Manual production inbox sends call Cloud API, but outbox-driven automations still create simulated provider IDs and must not be treated as live delivery until replaced by the production sender worker.
- AI-assisted product/order interpretation, actual domain draft creation, inventory reservation, and WhatsApp-to-reconciliation candidate creation are not implemented. The platform entry point currently captures the message and explains its evidence/draft status without claiming that a record was posted.
- Broader performance/load testing still requires an isolated production-shaped database and traffic profile; deterministic database concurrency fixtures are active locally.
- Production secrets must move from environment variables to a managed secret store/KMS envelope-encryption implementation.
- Transfer reconciliation targets and provider-certified live traffic remain later implementation batches.

## 1. Outcome

Build two provider-neutral capabilities on one reliable event foundation:

1. A bank-feed reconciliation service that ingests transactions from Moniepoint and later other banks/providers, normalizes them, matches them to LemonBooks records, and exposes safe exception handling.
2. A WhatsApp Business integration that lets a merchant retain human conversation while LemonBooks automates opted-in operational messages and turns inbound customer messages into structured, reviewable business signals.

The combined product promise is:

> Keep running customer relationships in WhatsApp. LemonBooks observes authorized business events, verifies money against connected financial sources, and keeps invoices, payments, inventory, and books current.

## 2. Non-negotiable boundaries

- LemonBooks is an accounting, orchestration, and reconciliation layer. It does not claim to be the bank, payment processor, or WhatsApp provider.
- A WhatsApp message, screenshot, receipt, or customer statement is evidence, not proof that money settled.
- Bank/provider-confirmed transaction data is authoritative for financial settlement status.
- An automated match may post only when deterministic controls pass. Ambiguous matches remain suggestions.
- A user must be able to disconnect a bank or WhatsApp account, revoke consent, inspect automation history, and export/delete eligible data.
- Never request or store online-banking passwords, PINs, OTPs, full card numbers, BVNs from chat, or customer financial-account credentials.
- No unofficial WhatsApp scraping, browser automation, device mirroring, or historical-inbox harvesting.
- No automation whose purpose is merely to provoke a reply and extend the 24-hour customer-service window.
- Every external event is authenticated, persisted immutably, deduplicated, and processed asynchronously.

## 3. Confirmed external capabilities and open dependencies

### WhatsApp

Meta's published policy confirms that businesses need opt-in, must honor opt-out, may use free-form replies within 24 hours of the user's last message, and must use approved templates outside that window. Automation must provide a clear path to human escalation. The platform uses webhooks for incoming messages and outgoing delivery states.

Production dependency:

- LemonBooks must complete Meta Business verification, app review, required advanced access, Tech Provider onboarding where applicable, and Embedded Signup approval.
- Coexistence eligibility must be determined during onboarding. It must not be promised for every existing WhatsApp Business App number.
- Pricing and template-category rules must be loaded from configuration and reviewed before release; they must not be hard-coded into product copy.

### Moniepoint

Moniepoint's public POS developer material confirms API-key based token authentication, merchant references, transaction-status queries, sandbox/test accounts, and signed webhooks using a webhook ID, timestamp, and HMAC-SHA256 signature.

It does **not**, from the reviewed public material, establish that a third-party accounting SaaS can retrieve a merchant's complete Moniepoint business-bank account transaction feed or statements.

Commercial gate before direct-bank-feed implementation:

- Written confirmation of the appropriate partner program and contracting entity.
- Consent/account-linking mechanism for each merchant.
- Supported account and transaction endpoints, pagination, historical range, pending/booked semantics, balances, reversals, fees, counterparties, and rate limits.
- Webhook catalogue and replay/retry contract.
- Sandbox credentials and certification checklist.
- Data retention, permitted-use, subprocessor, incident, support, and SLA terms.

If direct account feeds are unavailable, ship the same normalized reconciliation engine behind one of these sources:

1. A regulated open-banking partner with explicit merchant consent.
2. Moniepoint POS/collection events where the merchant is eligible.
3. Read-only CSV/OFX/statement import as a controlled fallback.

The CBN open-banking guidelines recognize customer control of data, authorization to service providers, API providers/consumers, and minimum privacy, security, risk, consent-revocation, and customer-experience requirements. Legal/compliance review is a release gate, not a post-launch task.

## 4. Shared integration architecture

```text
Provider webhook / scheduled poll / statement upload
                         |
                         v
             Edge webhook or import endpoint
             - authenticate source
             - timestamp/replay check
             - payload size/content check
             - persist raw event
             - return quickly
                         |
                         v
                Durable integration queue
                         |
              +----------+-----------+
              |                      |
              v                      v
      Provider normalizer       Dead-letter queue
              |
              v
         Canonical events
              |
       +------+----------------+
       |                       |
       v                       v
 Reconciliation engine   WhatsApp workflow engine
       |                       |
       +----------+------------+
                  v
       Domain commands + audit log
                  |
         payments / invoices / items
```

The Express API may host initial endpoints, but external processing must not remain synchronous request work. Introduce a durable queue and worker before production traffic. PostgreSQL-backed jobs are acceptable initially if jobs are claimed with `FOR UPDATE SKIP LOCKED`, attempts are bounded, leases expire, and a dead-letter state exists. A managed queue is preferred once throughput or operational requirements justify it.

## 5. Shared canonical tables

All records are tenant-scoped. Provider secrets are encrypted using envelope encryption and never returned after creation.

### `integration_connections`

- `id`, `business_id`
- `kind`: `bank`, `payment_provider`, `whatsapp`
- `provider`: `moniepoint`, future provider identifier, or `meta_whatsapp`
- `status`: `pending`, `active`, `attention`, `revoked`, `failed`
- `external_account_id`, `external_business_id`
- `capabilities` JSON: balances, transactions, webhooks, messaging, coexistence
- `encrypted_credentials`, `credential_key_version`
- `consented_by`, `consented_at`, `consent_scope`, `consent_expires_at`
- `last_success_at`, `last_cursor`, `last_error_code`
- timestamps and soft deletion

Unique external identities must be scoped by provider and environment.

### `integration_events`

- provider event ID and event type
- connection/business IDs
- SHA-256 payload hash
- encrypted or access-restricted raw payload
- signature validation result
- occurred, received, processed timestamps
- status: `received`, `processing`, `processed`, `ignored`, `failed`, `dead_letter`
- attempt count and sanitized failure code

Unique constraint: `(provider, environment, provider_event_id)`. If the provider supplies no stable ID, use a documented deterministic idempotency fingerprint and retain collision diagnostics.

### `integration_jobs`

- event ID, job type, state, available time, lease owner/expiry
- attempts, maximum attempts, last sanitized error
- correlation ID and trace context

### `integration_audit_log`

- actor type/id, business, connection, resource
- action, before/after summaries, reason, IP/device where applicable
- append-only timestamp and correlation ID

Raw provider payloads must not be copied into ordinary application logs.

## 6. Bank connector contract

Every provider adapter implements the same interface:

```ts
interface BankConnector {
  beginConnection(input: ConnectionRequest): Promise<ConnectionChallenge>;
  completeConnection(input: ConnectionCallback): Promise<ConnectedAccount[]>;
  refreshCredentials(connectionId: string): Promise<void>;
  listAccounts(connectionId: string): Promise<ProviderAccount[]>;
  fetchBalance(accountId: string): Promise<ProviderBalance>;
  fetchTransactions(input: TransactionCursorRequest): Promise<TransactionPage>;
  verifyWebhook(request: RawWebhookRequest): VerifiedWebhook;
  normalizeWebhook(event: VerifiedWebhook): CanonicalBankEvent[];
  disconnect(connectionId: string): Promise<void>;
}
```

Provider adapters translate transport and terminology only. Matching rules, ledger posting, notifications, and invoice logic do not belong in a Moniepoint adapter.

## 7. Canonical bank data model

### `bank_accounts`

- connection/business IDs
- provider account ID and masked account number
- institution/name/type/currency
- current and available balance with provider timestamps
- status and last-synced cursor

### `bank_transactions`

- immutable provider identity and account ID
- `pending`, `booked`, `reversed`, or `deleted`
- direction, amount, currency
- transaction time, value date, booked time
- description, narration, provider category
- provider/reference/session IDs
- counterparty name, bank, and masked account identifier when permitted
- running balance when supplied
- raw-event pointer, not duplicated raw JSON
- normalized fingerprint and timestamps

Use integer minor units plus currency, or a decimal abstraction that supports each currency's exponent. Do not use JavaScript floating-point arithmetic for financial matching.

Unique constraints should include provider/account/provider-transaction ID. Pending-to-booked transitions must update the canonical transaction rather than create income twice.

### `reconciliation_candidates`

- bank transaction ID
- target type/id: invoice, payment intent, settlement, expense, transfer, payout
- proposed allocation amount
- score and rule-version
- reason codes and explainable evidence
- state: `suggested`, `accepted`, `rejected`, `expired`, `superseded`

### `reconciliations`

- bank transaction and one or more allocations
- status: `matched`, `partially_matched`, `unmatched`, `ignored`, `reversed`
- method: `automatic`, `manual`, `rule`
- actor, rule version, confidence, timestamp
- immutable reversal link rather than destructive deletion

### `reconciliation_rules`

Tenant-specific rules such as known counterparty, narration pattern, fixed fee, or recurring expense. Rules require preview, audit history, permissions, and safe rollback.

## 8. Bank ingestion and synchronization

Use webhook-first plus polling repair:

1. Verify webhook signature using the raw request bytes.
2. Reject stale timestamps outside the configured tolerance unless provider replay semantics require otherwise.
3. Persist the unique event before acknowledging it.
4. Return `2xx` quickly after durable acceptance.
5. Normalize and upsert asynchronously.
6. Poll recent history periodically to repair missed or delayed webhooks.
7. Run a daily rolling-window overlap sync and a less frequent balance/statement integrity check.
8. Alert on cursor stalls, balance divergence, signature failures, schema drift, and webhook lag.

For the documented Moniepoint webhook scheme, verification must use the exact provider-specified concatenation of webhook ID, timestamp, and raw body with HMAC-SHA256. Obtain the definitive encoding, replay window, retry schedule, and secret-rotation behavior during certification.

Never mark a transaction final solely because a notification arrived. Normalize provider status and support pending, failure, reversal, refund, and chargeback transitions.

## 9. Reconciliation engine

### Candidate generation

Generate candidates using bounded windows and indexed fields:

- exact provider or merchant reference
- exact invoice/payment reference in narration
- exact amount and currency within a date window
- counterparty/customer phone or normalized name where legally permitted
- expected Paystack settlement net of known fees
- combined-invoice payment group amount
- user-defined rule

### Scoring

Example signals, with weights stored in a versioned rule configuration:

- exact unique reference: strongest
- exact amount and currency
- account/counterparty identity
- time proximity
- invoice/client relationship
- expected fee/net calculation
- WhatsApp-stated invoice or customer intent: supporting evidence only
- negative signals: reused reference, currency mismatch, reversed transaction, conflicting allocations

### Automatic posting policy

Auto-match only when all are true:

- transaction is authoritative/booked and not reversed
- currency matches
- allocations equal the transaction amount within an explicit tolerance
- there is one unambiguous target set
- no prior reconciliation or payment with the same provider identity exists
- confidence exceeds the approved threshold
- the rule is allowed to auto-post for that target type

Otherwise create a suggestion in **Needs attention**.

### Accounting effects

Acceptance is one database transaction:

1. Lock the bank transaction and targets.
2. Re-check availability and idempotency.
3. Create or link the payment/expense/transfer.
4. Allocate across invoices.
5. Update invoice states.
6. Post inventory only under the existing one-time paid-invoice control.
7. Create reconciliation and audit records.
8. Emit domain/outbox events.

Reversals create compensating records and reopen invoice balances where policy permits. Never silently mutate historical confirmed money.

## 10. Reconciliation product surfaces

### Connect bank

- provider selection with capability and region labels
- explicit read-only scope and purpose
- redirect/embedded provider authorization
- account selection
- initial sync progress
- consent expiry and disconnect controls

### Money feed

- all connected accounts, current sync status, and last updated time
- booked/pending/reversed distinction
- search, date, amount, account, direction, and reconciliation-status filters
- provider reference and source provenance

### Needs attention

- side-by-side bank transaction and suggested targets
- explanation: “Exact amount + invoice reference; received 14 minutes after invoice”
- accept, split, choose another target, create expense, transfer, or ignore
- conflict and duplicate warnings
- maker-checker approval for high-value/manual overrides when enabled

### Transaction journey

Expose:

```text
Invoice -> payment intent -> processor event -> fee -> settlement -> bank transaction -> reconciled
```

Every stage shows source, timestamp, reference, actor, status, and corrective action.

## 11. Bank API surface

Suggested authenticated endpoints:

- `POST /integrations/banks/:provider/connect`
- `GET /integrations/banks/:provider/callback`
- `GET /integrations/banks/connections`
- `DELETE /integrations/banks/connections/:id`
- `POST /integrations/banks/connections/:id/sync`
- `GET /bank-accounts`
- `GET /bank-transactions`
- `GET /reconciliation/candidates`
- `POST /reconciliation/:transactionId/accept`
- `POST /reconciliation/:transactionId/split`
- `POST /reconciliation/:transactionId/ignore`
- `POST /reconciliation/:id/reverse`
- `POST /webhooks/banks/:provider`

All mutations require idempotency keys, tenant authorization, and an append-only audit event.

## 12. WhatsApp connection model

Use Meta Embedded Signup as the production onboarding path. Store:

- WABA ID, phone-number ID, masked/display number
- business portfolio identity where required
- access-token secret and expiry/rotation metadata
- app subscription state
- coexistence capability and state
- quality rating, messaging status, and health information made available by Meta
- default timezone and language preferences

Connection states:

```text
not_connected -> onboarding -> connected -> attention -> suspended/revoked
```

The UI must explain whether the merchant can continue using the WhatsApp Business App on the same number. Only show “keep using your app” after Meta confirms coexistence for that number.

## 13. WhatsApp canonical model

### `whatsapp_contacts`

- business/client IDs
- normalized E.164 phone and provider contact ID
- display name and consent state/source/timestamp
- opt-out timestamp and reason
- last inbound time and derived service-window expiry

Do not assume phone equality proves customer identity. Linking a contact to a LemonBooks client can be suggested, but ambiguous identity requires confirmation.

### `whatsapp_conversations`

- contact and connection
- state: open, awaiting_customer, awaiting_business, resolved, blocked
- assigned user/team
- last inbound/outbound timestamps
- service-window expiry
- linked invoice/order/lead IDs

### `whatsapp_messages`

- provider message ID, direction, type, provider status
- conversation/contact
- body or media pointer according to retention policy
- reply-to/context ID
- template ID/version/category when applicable
- automation ID, cost attribution record, timestamps
- failure code with sanitized explanation

### `whatsapp_templates`

- Meta identity/name/language/category/status/version
- parameter schema
- LemonBooks use case and fallback channel
- last synchronized timestamp

### `automation_rules` and `automation_runs`

- trigger, eligibility conditions, delay, quiet hours, action
- template/free-form policy and human escalation path
- enabled/version/creator/approver
- run idempotency key, eligibility snapshot, outcome, provider message ID

## 14. WhatsApp webhook handling

1. Support Meta's verification challenge endpoint.
2. Verify request authenticity using the currently documented Meta mechanism and raw body.
3. Persist and deduplicate provider message/status events.
4. Acknowledge quickly and process asynchronously.
5. Handle inbound text, supported media, interactive replies, delivery/read/failure status, template status, account/quality changes, and unknown future event types.
6. Download media only when necessary, scan it, enforce type/size limits, encrypt storage, and delete it under retention policy.
7. Preserve provider ordering metadata, but make processors safe for out-of-order status events.

The system must tolerate duplicate delivery, delayed delivery, retries, webhook outages, and new fields without failing the entire payload.

## 15. WhatsApp service-window and policy engine

The service window is derived from the last valid customer message, not from a business message.

Before every send, a centralized policy check evaluates:

- merchant connection health
- customer opt-in/opt-out and block state
- current Meta policy/configuration version
- whether the 24-hour service window is open
- free-form versus approved-template requirement
- template approval, category, language, and parameter completeness
- quiet hours, frequency cap, duplicate automation, invoice state
- budget/plan allowance and estimated billable category
- human-escalation availability

No feature may call Meta directly without passing this policy service.

Do not advertise inbound processing as “free forever.” Record it as currently non-billable under the reviewed pricing model and keep pricing rules configurable because Meta can change them.

## 16. WhatsApp automation catalogue

### Phase-one transactional automations

- invoice sent
- invoice due soon
- invoice overdue
- payment confirmed
- payment under review
- receipt available
- low-stock alert to the merchant's own operational number, if opted in

### Window-aware commerce automations

- follow up on a genuine unanswered product inquiry
- follow up on an abandoned quotation
- confirm whether reserved stock is still wanted
- create/send an invoice after explicit customer confirmation

Required guardrails:

- only unresolved, configured business events
- merchant-configurable delay, quiet hours, and frequency limits
- suppress when paid, cancelled, out of stock, opted out, already answered, or manually resolved
- never send merely because the window is about to expire

### Inbound interpretation

Start deterministic and reviewable:

- extract invoice number/reference
- extract amount/currency
- identify payment claim language
- identify product/SKU and requested quantity
- detect yes/no/stop/help intents

An AI model may propose structured fields but cannot directly confirm a bank payment, post inventory, create a refund, or make an irreversible accounting decision. Store model version, input reference, confidence, output, and human correction. Redact sensitive data and contractually prohibit training on tenant content where applicable.

## 17. WhatsApp-to-reconciliation flow

```text
Customer: “Transferred 250,000 for LB-1088”
                    |
                    v
Inbound message persisted and authenticated
                    |
                    v
Extract {amount, invoice reference, customer}
                    |
                    v
Search booked bank transactions and provider events
          +---------+----------+
          |                    |
      exact match          no/ambiguous match
          |                    |
          v                    v
safe reconciliation       Needs attention
          |
          v
invoice/payment/inventory domain update
          |
          v
send confirmation only if consent + window/template policy permits
```

The chat event contributes a candidate and explanation. It does not itself create a confirmed payment.

## 18. WhatsApp product surfaces

### Connection and health

- Embedded Signup
- connected number and coexistence status
- quality/messaging health, webhook health, last event
- template sync status
- disconnect/revoke

### Inbox and customer context

- conversation list with assignment and unread state
- customer, invoices, open balance, payment status, and item availability alongside chat
- human handoff and automation pause
- link/unlink client with audit record

### Automation center

- templates grouped by operational use case
- trigger, timing, audience, quiet hours, cap, and estimated charging behavior
- preview with actual variable validation
- test send to authorized test recipient
- activity log and failure recovery

### Cost and policy visibility

- messages by category, region, status, and automation
- estimated provider charges versus LemonBooks plan allowance
- open-window versus template send
- template rejection and quality warnings

Do not promise exact final Meta cost until delivery and provider billing data are available.

## 19. WhatsApp API surface

- `POST /integrations/whatsapp/embedded-signup/session`
- `POST /integrations/whatsapp/embedded-signup/complete`
- `GET /integrations/whatsapp/connection`
- `DELETE /integrations/whatsapp/connection`
- `GET /integrations/whatsapp/templates`
- `POST /integrations/whatsapp/templates/sync`
- `GET /whatsapp/conversations`
- `GET /whatsapp/conversations/:id/messages`
- `POST /whatsapp/conversations/:id/messages`
- `POST /whatsapp/conversations/:id/assign`
- `POST /whatsapp/conversations/:id/resolve`
- `GET/POST/PATCH /whatsapp/automations`
- `GET /whatsapp/automation-runs`
- `GET /webhooks/whatsapp` for challenge verification
- `POST /webhooks/whatsapp` for events

Sending endpoints return an accepted command/run, not a false claim that Meta delivered the message.

## 20. Outbox and domain events

Add a transactional outbox. When LemonBooks changes invoice/payment/inventory state, write the domain change and outbox event in the same database transaction. Workers consume events such as:

- `invoice.sent`
- `invoice.due_soon`
- `invoice.overdue`
- `payment.confirmed`
- `payment.reversed`
- `inventory.low_stock`
- `bank_transaction.booked`
- `reconciliation.completed`

Event consumers are idempotent. A unique automation key such as `(business, rule_version, event_id, recipient)` prevents duplicate messages.

## 21. Security and privacy controls

- Encrypt provider credentials and sensitive payload fields at rest; TLS in transit.
- Use separate secrets per environment and provider connection where supported.
- Automated secret rotation, revocation, and key-version migration.
- Least-privilege scopes and short-lived access tokens.
- Webhook signature verification over raw bytes, timestamp validation, and replay detection.
- SSRF protection for provider/media URLs; allowlists where feasible.
- Malware scanning, MIME sniffing, size limits, and quarantining for attachments.
- Tenant-scoped authorization on every query and job.
- Separate permissions: connect integrations, view bank data, reconcile, override, manage WhatsApp, send templates, view conversations.
- Maker-checker for manual high-value reconciliation and rule changes.
- PII redaction in logs and support tooling.
- Defined retention for raw webhooks, chat content, media, financial records, and audit logs.
- DSAR, correction, portability, objection, and eligible deletion workflows.
- Data processing agreements, subprocessor register, cross-border transfer assessment, DPIA, breach plan, and annual compliance review.

Nigeria's data-protection rules can apply to a foreign company processing Nigerian data. Consent, transparency, purpose limitation, minimization, security, retention, and data-subject rights must be designed into onboarding and operations.

## 22. Reliability and observability

Initial proposed SLOs, to be validated against provider SLAs:

- 99.9% LemonBooks integration API availability monthly.
- 99% of valid webhooks durably accepted within 2 seconds.
- 99% of accepted webhook events normalized within 60 seconds.
- 99% of bank feeds no more than 15 minutes stale when provider service is healthy.
- Zero known duplicate financial postings.
- 100% of automatic matches carry rule version and explanation.

Metrics:

- webhook signature failures, lag, duplicates, and unknown schemas
- queue depth, oldest job, retries, dead letters
- token refresh failures and disconnected accounts
- feed cursor stalls and balance divergence
- match rate by confidence/rule/provider
- manual override and reversal rate
- WhatsApp send/delivered/read/failed by template and automation
- opt-outs, quality warnings, template rejection, and estimated cost

Alerts must be tenant-safe and include correlation IDs, never raw financial/chat content.

Operational tooling must support replaying an immutable event, re-running normalization with a version, pausing a connector/rule, and inspecting sanitized traces. Replaying may not bypass idempotency.

## 23. Testing and certification

### Contract tests

- captured provider fixtures, signed webhook fixtures, unknown fields
- schema/enum drift and missing optional fields
- token expiration/rotation and pagination
- pending-to-booked, reversal, duplicate, delayed, and out-of-order events

### Reconciliation tests

- exact, split, combined-invoice, partial, overpayment, fee/net settlement
- duplicate reference, same amount from different customers, currency mismatch
- reversal after reconciliation and inventory/accounting compensation
- concurrency tests proving one posting under webhook/poll/manual races
- property tests: allocations never exceed source; debits/credits remain balanced

### WhatsApp tests

- open/closed service window at boundary times and tenant timezone
- approved/rejected/paused template
- opt-in/opt-out and block handling
- duplicate inbound messages and status events
- automation frequency caps, quiet hours, cancellation after payment
- human handoff and failed-message recovery
- coexistence eligible/ineligible onboarding paths

### Security tests

- forged/replayed webhooks, timing-safe signature comparisons
- broken tenant access, privilege escalation, secret exposure
- malicious files/media and SSRF
- deletion/retention/consent revocation
- load and queue backpressure

No provider integration launches without sandbox certification, failure-mode exercise, runbook, rollback switch, and partner sign-off.

## 24. Delivery plan

### Phase 0 — discovery and partner gates (2–4 weeks)

- Moniepoint technical/commercial workshop and written capability matrix
- Meta business/app/Tech Provider readiness assessment
- legal basis, DPA, DPIA, privacy notice, consent language
- accounting treatment and reconciliation-control sign-off
- event taxonomy, provider contracts, threat model, and SLO approval

Exit: credentials/sandbox and permitted use are known; no speculative connector build.

### Phase 1 — integration foundation (3–5 weeks)

- connections, encrypted secrets, raw events, jobs, dead letters, audit log
- transactional outbox and domain events
- admin health/replay tools and metrics
- connector contract and test harness

Exit: duplicate/replay/load/failure tests pass without touching production money or messaging.

### Phase 2 — bank ingestion and manual reconciliation (4–6 weeks)

- first available Moniepoint/open-banking/statement adapter
- accounts, balances, normalized transactions, cursor/poll repair
- money feed and Needs attention UI
- manual match/split/create-expense/ignore/reverse with audit

Exit: pilot statements reconcile deterministically; provider totals and LemonBooks totals agree.

### Phase 3 — safe auto-reconciliation (3–5 weeks)

- candidate scoring/explanations
- exact-reference rules first
- automatic posting with confidence/configuration controls
- combined invoices, settlements, fees, reversals
- daily integrity jobs and exception alerts

Exit: shadow-mode precision target is met before posting is enabled tenant by tenant.

Recommended shadow gate: at least 99.5% precision on automatic candidates; prefer lower recall over incorrect posting.

### Phase 4 — WhatsApp connection and transactional messaging (4–7 weeks, parallel after foundation)

- Embedded Signup, webhook ingest, contact/conversation/message model
- consent/opt-out, policy/window service, template sync
- invoice/payment transactional automations
- delivery states, activity history, cost attribution, human escalation

Exit: Meta review/certification complete and all sends pass the centralized policy service.

### Phase 5 — inbound commerce and cross-signal reconciliation (4–6 weeks)

- deterministic intent extraction and review UI
- chat-to-client/invoice candidate linking
- bank-confirmed payment matching using chat as supporting evidence
- genuine inquiry follow-ups and commerce actions
- optional AI extraction in shadow mode, then human-assisted mode

Exit: no chat-derived signal can independently post a confirmed financial transaction.

### Phase 6 — multi-provider scale

- second bank connector proves adapter portability
- provider-specific capabilities and regional configuration
- reconciliation-rule library, additional settlement/fee models
- WhatsApp inbox/team workflow and advanced automations
- usage metering, plan enforcement, and enterprise audit exports

## 25. Team and ownership

Minimum production team for overlapping delivery:

- product manager/domain owner
- technical lead/platform engineer
- 2 backend/integration engineers
- 1 frontend engineer
- QA automation engineer
- part-time SRE/security engineer
- product designer
- accounting/control owner
- privacy/legal/compliance counsel
- provider partnership owner

Do not assign accounting correctness, privacy approval, or provider certification solely to engineering.

## 26. Release strategy

1. Internal synthetic accounts.
2. Provider sandbox.
3. Employee/test businesses with no auto-posting.
4. Design partners in shadow mode.
5. Manual reconciliation pilot.
6. Exact-reference auto-match for selected tenants.
7. Gradual expansion by provider, transaction type, and confidence rule.

Every stage has kill switches per provider, connection, automation, and reconciliation rule. A provider outage degrades to “data delayed,” never to invented or duplicated records.

## 27. Production definition of done

The program is not production-ready until:

- commercial and permitted-data-use agreements are signed
- Meta and bank/provider approvals are complete
- consent, revocation, privacy, and retention workflows are live
- webhook authentication, replay defense, idempotency, queues, and dead letters are proven
- credentials are encrypted and rotatable
- reconciliation is explainable, reversible, tenant-safe, and audited
- no WhatsApp signal alone confirms money
- opt-out and human escalation work end to end
- dashboards, alerts, runbooks, on-call ownership, and incident drills exist
- contract, concurrency, load, security, and disaster-recovery tests pass
- accounting/control, security, privacy, and provider owners sign off

## 28. Immediate decisions and partner questions

### Moniepoint

1. Is the target integration a business-bank account feed, POS transaction feed, Monnify collection feed, or all three?
2. Can a U.S. SaaS entity be the API consumer, or is a Nigerian entity/licensed partner required?
3. What merchant consent/account-linking flow is supported?
4. Are balances and complete historical transactions available, or only transactions initiated through the integration?
5. How are pending, booked, failed, reversed, refunded, charged-back, fee, and settlement events represented?
6. What are rate limits, pagination/cursors, retention, replay, webhook retry, support, and SLA terms?
7. Are sandbox and production schemas identical, and what certification is required?

### Meta

1. Will LemonBooks onboard as a direct Tech Provider or initially through an approved BSP?
2. Which countries/numbers are eligible for Embedded Signup and coexistence at launch?
3. Which permissions and advanced access reviews are required for the intended features?
4. What exact pricing, free-entry-point, template-category, and utility-window rules apply at launch?
5. What content may LemonBooks retain, for how long, and under which merchant/customer disclosures?

### Product

1. Is bank access read-only for the first release? Recommended: yes.
2. Is manual override maker-checker by default above a threshold? Recommended: configurable, enabled for high value.
3. Will LemonBooks host a shared inbox in phase one? Recommended: no; start with connection, automation, and operational history.
4. Will AI be allowed to post transactions? Recommended: no; extraction/suggestion only.
5. What retention periods and WhatsApp usage allowance belong to each plan?

## 29. Primary references reviewed

### Implemented Monnify collections integration

LemonBooks supports Monnify as an invoice collection provider alongside Paystack: credential verification and encrypted activation, hosted checkout initialization, server-side transaction verification, signed webhook settlement, payment-intent idempotency, and automatic invoice/ledger reconciliation. Activation uses an API key, secret key, and contract code because Monnify's public merchant documentation does not expose an OAuth or embedded account-linking flow. This covers payments initiated through LemonBooks; it is not a historical bank-account aggregation feed.

Production setup requires `INTEGRATION_CREDENTIALS_KEY`, public web/API URLs, a live Monnify merchant contract, and registration of the connection-specific webhook URL shown in Business settings.

- [Meta WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/)
- [Meta WhatsApp Business Platform API collection](https://www.postman.com/meta/whatsapp-business-platform/overview)
- [Moniepoint POS developer getting started](https://teamapt.atlassian.net/wiki/spaces/EI/pages/2170421476/Getting+Started)
- [Moniepoint webhook documentation](https://teamapt.atlassian.net/wiki/spaces/EI/pages/1492648078/Webhooks)
- [Moniepoint ERP/POS transaction API reference](https://teamapt.atlassian.net/wiki/spaces/EI/pages/1039826999/ERP+Integration+API+Reference)
- [CBN Operational Guidelines for Open Banking in Nigeria](https://www.cbn.gov.ng/Out/2023/CCD/Operational%20Guidelines%20for%20Open%20Banking%20in%20Nigeria.pdf)
- [Nigeria Data Protection Commission FAQs](https://www.ndpc.gov.ng/faqs/)

These references establish planning constraints, not automatic approval for LemonBooks to access any merchant account or message data. Provider contracts, current technical documentation, and counsel review control the launch decision.

## 30. WhatsApp merchant onboarding specification

### Product promise and ownership

LemonBooks uses one approved LemonBooks Meta application and one or more approved Embedded Signup configurations. A merchant never creates a Meta developer application, system user, webhook, or API token. Each merchant nevertheless owns its own Meta Business Portfolio, WABA, phone number, customer relationships, and message content. LemonBooks receives revocable authority to operate the permitted assets on the merchant's behalf.

The onboarding UI must avoid unexplained Meta terminology. Show WABA, phone-number, token, app-subscription, and portfolio identifiers only in an advanced diagnostic view available to authorized administrators and support staff.

### Entry paths

The first LemonBooks screen must ask which situation applies:

1. **Existing WhatsApp Business App number.** Launch the Meta-approved Coexistence variation. Explain that continued mobile-app use is subject to Meta eligibility and must not be promised before Meta confirms it.
2. **Existing unused phone number.** Launch standard Cloud API Embedded Signup. The number must be able to receive the Meta verification method and must not be bound to an incompatible WhatsApp account.
3. **Needs a new phone number.** Either send the merchant through an approved number-provisioning partner flow or explain that LemonBooks does not supply telephone numbers and require the merchant to obtain one before continuing. Meta account creation is not telephone-number provisioning.

Do not infer the path from the phone number alone. Record the merchant's selection and the Embedded Signup configuration/variation used.

### Standard Embedded Signup sequence

```text
Merchant clicks Connect WhatsApp
  -> LemonBooks authorizes owner/admin and creates one-time signup session
  -> frontend loads Meta JavaScript SDK from the approved origin
  -> frontend launches the approved Embedded Signup configuration
  -> merchant authenticates to Meta
  -> merchant selects or creates a Business Portfolio
  -> merchant selects or creates a WABA
  -> merchant selects/adds and verifies a phone number
  -> Meta returns authorization code plus session event data
  -> LemonBooks backend validates state, user, tenant, expiry and single use
  -> backend exchanges code for business token
  -> backend independently retrieves and validates authorized assets
  -> backend completes registration when required by the current Meta flow
  -> backend subscribes LemonBooks app to the WABA
  -> backend performs a capability/health read
  -> backend encrypts credentials and activates connection transactionally
  -> background worker performs initial template and health synchronization
  -> UI shows Connected only after all required activation checks pass
```

The frontend-provided WABA and phone-number IDs are untrusted hints. The backend must confirm them through Meta before storage. A signup session is bound to business, requesting user, intended onboarding path, configuration ID, state hash, creation time, expiry, and completion status. It is single use and expires within ten minutes.

### Coexistence sequence

Coexistence requires its own approved Meta configuration or documented feature variation. The implementation must:

- launch the current Meta WhatsApp Business App onboarding feature rather than the standard empty/default feature type
- collect Meta session logging and all required completion events
- let Meta determine number, country, app-version, account, and business eligibility
- record `eligible`, `ineligible`, `pending`, `active`, `attention`, or `disconnected`, plus a sanitized reason code
- confirm whether mobile-app history/contact synchronization was selected and completed when Meta exposes that state
- display “Keep using the WhatsApp Business App” only after an `active` result
- provide standard Cloud API migration, another number, or cancel as explicit fallbacks
- never attempt unofficial device linking, QR scraping, browser automation, or chat-history harvesting

Coexistence behavior and eligibility can change. The Meta documentation version and feature/configuration used must be stored with each onboarding attempt.

### Number registration and two-step verification

After signup, query the number's current registration and messaging state. If the applicable Meta flow requires `POST /{phone-number-id}/register`, perform it server-side with the required `messaging_product` and merchant-provided six-digit PIN. The PIN is a write-only secret: use it for registration, never log it, never return it, and never persist it after the request completes.

If registration is already complete, treat the operation as idempotent. If two-step verification or registration needs merchant action, set the connection to `attention`, provide a resumable task, and do not claim that the number is active.

### Meta-owned actions and verification

Meta controls authentication, authorization, phone OTP, asset ownership, display-name review, account restrictions, and Meta Business Verification. LemonBooks may launch or deep-link the applicable Meta experience, explain what is needed, poll permitted status fields, and show remediation state. LemonBooks must not claim to perform or approve Meta verification.

Business verification is not always a prerequisite for initial sandbox/testing capability, but any limit, production, feature, or regional requirement observed from Meta must be represented as a connection task. Store only status and permitted business metadata; do not copy verification documents into LemonBooks.

### Onboarding completion states

```text
not_connected
  -> onboarding
  -> awaiting_phone_verification
  -> awaiting_registration
  -> awaiting_business_verification
  -> synchronizing
  -> connected
  -> attention
  -> restricted | suspended | revoked | disconnected
```

Transitions are monotonic within one onboarding attempt except for explicit retry/recovery. `connected` requires a usable credential, verified asset relationship, registered/messaging-capable number, active app subscription, successful health read, and no known blocking restriction. UI success copy must correspond to this definition.

### Asset collision and transfer rule

A `(provider, environment, phone-number-id)` belongs to exactly one active LemonBooks business. A conflict must return an ownership error; an upsert must never silently replace `business_id`. Moving an asset requires an authenticated transfer workflow, authority checks on both sides where applicable, a Meta reauthorization, explicit confirmation, audit records, and revocation of the previous connection.

## 31. WhatsApp connection and credential lifecycle

Store, directly or in versioned capability metadata:

- LemonBooks business and connection IDs
- Meta Business Portfolio ID when returned/permitted
- WABA ID and name
- phone-number ID and masked/display number
- verified display name and its review state
- platform type and onboarding path
- Coexistence capability/state
- registration and messaging status
- quality rating and restriction reason
- app-subscription state
- Embedded Signup configuration and documented flow version
- token type, issued time, expiry, last validation, and credential key version
- default language, timezone, and merchant operational number
- last template sync, inbound webhook, outbound acceptance, health check, and error code

### Token handling

- Exchange authorization codes only on the backend using the Meta app secret.
- Encrypt business tokens with managed KMS/envelope encryption in production; local AES-GCM is a development fallback.
- Never return, log, place in analytics, or expose tokens to the browser after exchange.
- Validate credentials immediately and on a scheduled cadence.
- Warn authorized merchant administrators before known expiry.
- Mark `attention` on expired/revoked tokens or permission loss and provide reauthorization.
- Support encryption-key rotation without requiring merchant reconnection.
- Maintain only one current credential version; retain no readable historical secret.

### Health synchronization

A scheduled worker must refresh permitted account/number health, subscription state, template status, quality state, verification state, and token validity. Use bounded retries, provider-aware backoff, jitter, rate-limit handling, and sanitized errors. Provider outages produce `degraded/data_delayed`, not immediate disconnection.

### Disconnect and revoke

Disconnect is a workflow, not only a local soft delete:

1. Stop new automation claims and outbound sends.
2. Mark the connection `revoking` and drain or suppress queued work.
3. Unsubscribe the LemonBooks app from the WABA when authorized and appropriate.
4. Revoke/remove the applicable Meta business integration or token using the currently supported mechanism; if merchant action is required, provide it explicitly.
5. Delete encrypted credentials and invalidate local sessions.
6. Mark the connection revoked/disconnected and audit each result.
7. Apply the configured message/content retention policy without deleting accounting records that must legally remain.

Partial Meta-side revocation must remain visible as `attention`; the UI must not claim complete revocation until confirmed or clearly disclose the remaining merchant action.

## 32. Embedded Signup API contracts

The route prefix may remain `/api/v3/whatsapp`; naming differences from this specification do not change the contract.

### Create session

`POST /whatsapp/embedded-signup/session`

Request:

```json
{
  "onboardingPath": "standard|coexistence|provisioned_number",
  "returnPath": "/whatsapp"
}
```

Response contains only public SDK values, opaque state, expiry, flow/configuration identifier, and version. Validate owner/admin role, allowed HTTPS return path, environment configuration, rate limit, and absence of another active completion for the same attempt.

### Complete session

`POST /whatsapp/embedded-signup/complete`

Request:

```json
{
  "state": "opaque-one-time-state",
  "code": "short-lived-authorization-code",
  "wabaId": "meta-id-hint",
  "phoneNumberId": "meta-id-hint",
  "sessionInfo": {}
}
```

The backend validates and normalizes assets itself. Return `202 Accepted` with connection/onboarding status while post-signup work runs; return `201` only if every synchronous activation invariant has completed. Do not expose encrypted credentials or raw Meta payloads.

### Resume and status

- `GET /whatsapp/onboarding/:attemptId` returns safe status, tasks, and resumable action.
- `POST /whatsapp/onboarding/:attemptId/retry` retries only idempotent server work.
- `POST /whatsapp/onboarding/:attemptId/register` accepts a write-only PIN when required.
- `GET /whatsapp/connection` returns connection health and safe merchant-facing identifiers.
- `DELETE /whatsapp/connection` starts the asynchronous revocation workflow.

Use stable LemonBooks error codes such as `META_CONFIG_MISSING`, `SIGNUP_EXPIRED`, `ASSET_NOT_AUTHORIZED`, `ASSET_ALREADY_CONNECTED`, `PHONE_REGISTRATION_REQUIRED`, `COEXISTENCE_INELIGIBLE`, `META_VERIFICATION_REQUIRED`, `TOKEN_REAUTH_REQUIRED`, and `META_RATE_LIMITED`. Provider messages are diagnostics, never the public API contract.

## 33. Webhook event contract and processing

### Edge handling

The public Meta callback supports verification challenge and signed event delivery. For POST delivery:

1. Enforce HTTPS, supported content type, body-size limit, and request timeout.
2. Capture exact raw bytes before JSON parsing.
3. Validate the current Meta signature mechanism using constant-time comparison.
4. Resolve tenant/connection using a verified provider asset identifier.
5. Persist an immutable event envelope and deterministic provider event ID.
6. Enqueue processing transactionally.
7. Return success quickly without performing conversation/domain work inline.

Invalid signatures return an error and create a security metric without storing sensitive raw content in ordinary logs. Valid events for unknown assets are quarantined with restricted diagnostics and must not be assigned to a guessed tenant.

### Normalized event families

Support and version normalized schemas for:

- inbound text
- image, audio, video, document, and sticker metadata
- button and list replies
- location, contact, reaction, reply/context, and referral metadata when supported
- outbound accepted, sent, delivered, read, failed, and deleted/unsupported states
- template created, approved, rejected, paused, disabled, and category/language changes
- phone/account quality, restriction, capability, and verification changes
- Coexistence/history synchronization events made available by Meta
- unknown future fields/events preserved as `unknown` without failing the payload

Media is downloaded only when a configured business workflow needs it. Enforce allowlisted types, maximum size, malware scanning, encryption, access control, and deletion schedule. Never treat receipt-image OCR as settlement proof.

### Ordering, retries, and idempotency

- Deduplicate by stable provider event identity; if unavailable, use a documented fingerprint.
- Make status application safe when `delivered/read/failed` arrives before local message persistence.
- Keep retry attempt, next availability, lease, and dead-letter state.
- Do not acknowledge malformed authenticated events as processed; quarantine them for schema review.
- Store provider occurrence time and LemonBooks receipt/processing times separately.
- Replaying a dead-letter event must not duplicate messages, orders, invoices, payments, inventory postings, or automation sends.

## 34. Messaging and template delivery specification

### Central sender

Every manual or automated outbound message must use one production sender service. The sender:

1. Loads the tenant-owned active connection and decrypts its current credential.
2. Loads recipient consent, block, service-window, conversation, invoice/order, rule, and plan state.
3. Executes the centralized policy decision.
4. Validates and renders template parameters or free-form content.
5. Creates an idempotent pending command/run.
6. Calls Meta outside a long-running database transaction.
7. Stores the returned provider message ID as `accepted`.
8. Updates delivery state only from subsequent provider webhooks.

Never synthesize a Meta-looking ID in production. Never write `delivered` at API acceptance time. Mock providers must be explicitly labelled and isolated by environment.

### Template model

Persist template identity, name, language, category, status, component schema, header/body/footer/buttons, variable schema, example values, version/hash, rejection reason, and synchronization time. A LemonBooks use case maps to an approved template version rather than relying only on a name.

Before sending, validate:

- template is approved and belongs to the same WABA/connection
- requested language exists
- every required parameter is present and typed
- invoice/customer data belongs to the same tenant
- rendered values meet provider length/content constraints
- URL/button parameters are allowlisted and safe
- category and estimated charge are current enough for display

Store a redacted render snapshot for audit. Do not store secrets or unnecessary payment data in message bodies.

### Service window and consent

An inbound customer message opens the currently applicable customer-service window. Business messages never extend it. Outside the window, use only an approved template for a permitted purpose. Opt-out applies immediately across automation and manual send surfaces; opt-in source and timestamp must be auditable. Provide human escalation for automated interactions.

### Automation worker correction

The current simulated outbox delivery is a release blocker. Replace it with the central sender and require production tests proving that:

- the provider call occurs once per idempotency key
- accepted is distinct from delivered/read
- transient failures retry without duplication
- permanent failures become actionable runs
- suppression reasons remain inspectable
- invoice/payment state changes after enqueue cause re-evaluation before send

## 35. AI-assisted commerce and human review

### Allowed AI role

AI may classify intent and propose structured business actions. It may not independently confirm payment, post ledger entries, issue refunds, change bank data, delete records, or make irreversible inventory/accounting decisions.

### Inbound pipeline

```text
authenticated WhatsApp message
  -> deterministic commands (stop/help/reference)
  -> tenant/customer candidate lookup
  -> product/SKU catalogue retrieval scoped to tenant
  -> structured extraction/classification
  -> validation against price, stock, tax and customer rules
  -> confidence and ambiguity evaluation
  -> draft order/quotation/invoice proposal
  -> merchant review or narrowly approved auto-draft policy
  -> domain command with idempotency and audit
  -> policy-checked WhatsApp confirmation
```

The structured proposal schema includes intent, customer candidates, requested lines, source phrase references, SKU candidates, quantities/units, quoted price/currency, delivery details, invoice/payment references, confidence per field, ambiguity codes, model/provider/version, prompt/policy version, and redaction metadata.

### Product and quantity matching

Use deterministic exact SKU/barcode/alias matching first, then normalized catalogue search, then AI ranking. Never invent a product or price. Ambiguous units such as carton/piece/pack require tenant-configured conversions or merchant confirmation. Out-of-stock items produce alternatives or review, not negative inventory.

### Draft order and invoice rules

- Creating a draft is distinct from accepting an order.
- Stock reservation is transactional, expiring, reversible, and based on confirmed units.
- Prices, discounts, tax, currency, customer credit, and fulfillment terms come from LemonBooks domain services.
- Merchant confirmation is required by default before sending a final invoice.
- Auto-draft/auto-confirm eligibility is configurable per tenant, customer, value threshold, SKU, and confidence threshold.
- Every domain command includes source message/event IDs and an idempotency key.
- Editing or rejecting an AI proposal is retained as audit/correction data under the retention policy, not automatically used to train a model.

### AI privacy and safety

Minimize/redact message content before external model calls, contractually prohibit provider training where required, define region/retention, defend against prompt injection, isolate tenant context, and log metadata rather than raw prompts. Attachments and URLs are untrusted. Model output is parsed through a strict schema and validated against authoritative LemonBooks data.

## 36. WhatsApp payment claims and reconciliation commands

A message such as “Transferred NGN 250,000 for LB-1088” creates evidence, never a payment.

The production processor must:

1. Persist the authenticated message.
2. Extract amount, currency, invoice/reference, sender/customer candidates, transfer time, bank hints, and receipt attachment reference.
3. Resolve invoice candidates within the same tenant.
4. Search authoritative booked bank transactions and verified payment-provider settlements.
5. Create reconciliation candidates with reason codes and source links.
6. Auto-post only under the configured deterministic reconciliation policy.
7. Otherwise show the claim in Needs attention with merchant review actions.
8. Send payment confirmation only after the authoritative domain payment/reconciliation event commits.

Required states:

```text
claim_received -> searching -> matched_suggested -> confirmed
                              -> ambiguous -> needs_attention
                              -> no_match -> awaiting_settlement
                              -> rejected
```

Partial/fragmented payments allocate only verified settled amounts. Multiple transactions may satisfy one invoice, and one transaction may be split across invoices only through existing reconciliation controls. Reversals/chargebacks reverse the financial allocation and may trigger a policy-approved notification; the original WhatsApp claim remains evidence history.

## 37. WhatsApp product UX specification

### Integrations catalogue

Place WhatsApp alongside bank and payment integrations in a consistent catalogue. The card shows provider, safe connection state, masked connected number, WABA/display name, Coexistence state, health, last successful sync/event, and primary action. Sensitive identifiers remain masked; credentials are never displayed.

### Connect experience

- Explain the three onboarding paths before Meta opens.
- Clearly label Meta-controlled screens.
- Preserve LemonBooks context when popup cancellation/error occurs.
- Show progress and resumable tasks rather than generic failure.
- Do not show success until activation invariants pass.
- Provide accessible keyboard/focus behavior and responsive mobile layout.

### Connected experience

Show connection health, number, display name, mobile-app continuation status, verification/restriction tasks, template health, webhook health, token/reauthorization attention, last inbound/outbound event, and disconnect. Provide a test send only to an authorized recipient and clearly distinguish accepted/delivered/read.

### Inbox and automation

The inbox shows customer context, open invoices, payment evidence, order drafts, stock context, assignment, automation state, and human handoff without implying identity from phone equality alone. Automation setup previews the exact approved template and parameters, timing, quiet hours, frequency cap, audience, charge category, suppression rules, and test result.

### Honest status language

- `Connected`: verified and messaging-capable.
- `Accepted by WhatsApp`: provider returned a message ID.
- `Delivered`/`Read`: received through provider status webhook.
- `Payment claimed`: customer statement only.
- `Payment confirmed`: authoritative provider/bank/manual-control workflow completed.
- `Keep using WhatsApp Business`: only active Coexistence confirmation permits this copy.

## 38. Production configuration and Meta release checklist

### LemonBooks Meta assets

- dedicated LemonBooks Meta Business Portfolio under controlled corporate ownership
- dedicated production Meta developer app; separate development/staging app where permitted
- WhatsApp product and Facebook Login for Business configured
- approved Embedded Signup configurations for standard and Coexistence flows as applicable
- exact HTTPS domains, OAuth redirect origins, privacy policy, terms, and data-deletion URLs
- production webhook callback and strong verification secret
- app secret and credential-encryption keys in managed secret storage
- least-privilege business roles with MFA and recovery ownership

### Approval gates

- LemonBooks Meta business/access verification complete
- Tech Provider or selected BSP relationship approved
- App Review and Advanced Access approved for every permission actually used
- Embedded Signup and Coexistence variations approved for production use
- test business/WABA/number and reviewer credentials maintained
- review evidence demonstrates onboarding, inbound webhook, outbound delivery, opt-out, human handoff, data deletion, and requested-permission use
- merchant billing/payment-method responsibilities and messaging limits documented
- launch countries and number types validated against current Meta eligibility

### Environment configuration

At minimum configure and validate on startup:

- `META_APP_ID`
- `WHATSAPP_APP_SECRET` (or `META_APP_SECRET`)
- `META_WHATSAPP_CONFIG_ID`
- separate Coexistence configuration/feature setting when used
- pinned supported Graph API version
- webhook verification secret
- integration credential encryption/KMS configuration
- public HTTPS API and web origins
- queue/worker, retry, rate-limit, retention, and kill-switch configuration

Fail closed when production configuration is missing. Never silently fall back to mock delivery in production.

## 39. Detailed test and acceptance matrix

### Onboarding

- new merchant creates/selects portfolio and WABA without a developer app
- standard unused-number verification and activation
- existing WABA/number selection where Meta permits it
- Coexistence eligible, ineligible, cancelled, interrupted, and resumed paths
- OTP failure/expiry and registration PIN required/incorrect/success paths
- business verification pending/restricted/remediated
- popup blocked, SDK unavailable, code returned without session event and vice versa
- expired/replayed state and code, wrong user, wrong tenant, tampered asset IDs
- existing phone asset collision cannot reassign tenant

### Credentials and lifecycle

- encryption, decryption, KMS/key rotation, and secret redaction
- token expiry, revocation, permission loss, reauthorization, and provider outage
- app subscription lost/restored
- disconnect suppresses sends and performs/reports Meta-side revocation

### Webhooks

- valid and forged signatures over exact raw bytes
- duplicate, delayed, out-of-order, batched, malformed, oversized, and unknown events
- text, supported media, interactive, status, template, account, quality, and Coexistence events
- unknown asset never crosses tenants
- fast acknowledgement under production-shaped load
- retry/dead-letter replay has no duplicated domain effects

### Messaging

- service window boundary and clock/timezone behavior
- opt-in, immediate opt-out, block, human handoff, and automation pause
- approved/rejected/paused template and missing/wrong parameters
- accepted versus delivered/read/failed state progression
- manual and automated sends use the same policy/sender
- frequency, quiet-hours, duplicate, invoice-state, budget, plan, and kill-switch suppression
- no simulated provider ID or false delivery state in production

### AI commerce and reconciliation

- exact/ambiguous SKU, aliases, units, quantities, currency, price and stock
- prompt injection, malicious URL/attachment, schema-invalid output, provider timeout
- confidence threshold and mandatory human-review behavior
- idempotent draft order/invoice and expiring/reversible stock reservation
- payment claim with exact, partial, split, duplicate, absent, pending, reversed, and conflicting settlement
- WhatsApp evidence alone can never confirm or post payment

### Accessibility, privacy, and operations

- keyboard/screen-reader onboarding and mobile viewport
- data export/deletion/retention and accounting-record exception
- audit completeness with no credentials or unnecessary message content
- dashboards, alerts, trace correlation, redrive controls, backup/restore, and incident runbooks

## 40. WhatsApp implementation work packages

1. **Correctness remediation:** remove simulated production automation delivery, prevent cross-tenant asset reassignment, and make accepted/delivered states honest.
2. **Onboarding lifecycle:** three-path UX, persisted attempts/tasks, registration recovery, verification/health states, and resumability.
3. **Coexistence:** approved variation, eligibility/result persistence, fallback paths, and mobile-app status UX.
4. **Credential operations:** managed encryption, health validation, reauthorization, rotation, and complete revocation workflow.
5. **Webhook platform:** fast edge persistence, durable queue, normalized event families, media safety, ordering, and dead-letter operations.
6. **Messaging platform:** central sender, complete policy engine, versioned template components/parameters, retries, delivery state, metering, and kill switches.
7. **Transactional automation:** invoice, payment, receipt, overdue and low-stock events through the live sender with re-evaluation and idempotency.
8. **Inbound commerce:** deterministic extraction, catalogue matching, AI proposals, merchant review, draft orders/invoices, and inventory reservations.
9. **Reconciliation bridge:** evidence records, authoritative transaction search, candidates, partial/consolidated allocation, confirmation and reversals.
10. **Production approval:** Meta configuration, Tech Provider/App Review evidence, country eligibility, privacy/compliance, load/security testing, runbooks and staged rollout.

Each work package requires API/schema migrations, UI states, audit events, metrics, tests, operational documentation, feature flags, rollback strategy, and an owner. A work package is complete only when its production definition and failure paths are demonstrated end to end.

## 41. LemonBooks-owned WhatsApp entry point runbook

This connection is distinct from merchant Embedded Signup. It lets a prospective or existing user message the LemonBooks-owned number to receive onboarding guidance and safely submit a business request. It must be bound to one explicit internal platform tenant so all persisted records remain tenant-scoped.

### Meta-side sequence

1. In WhatsApp Manager, open the registered production number and complete its **Profile**: approved display name, square business logo/profile image, business description, category, website, support email, and address only where accurate. The Meta developer-app icon does not control the WhatsApp chat avatar.
2. Complete the business portfolio's verification and billing requirements. Use “business purposes” when LemonBooks is purchasing WhatsApp Business services for its commercial operation.
3. In Business Settings, create a dedicated system user, assign only the LemonBooks app and WABA assets it needs, and generate a non-expiring/permanent system-user token with `whatsapp_business_management` and `whatsapp_business_messaging`. Never use the temporary “Employee” testing token in production.
4. Configure `https://api.lemonbooks.io/api/v3/webhooks/whatsapp` as the callback, use the exact server `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, keep client-certificate attachment off unless deliberately deployed, and subscribe the WABA/app to `messages`.
5. Publish the approved Meta app. Confirm `/{WABA_ID}/subscribed_apps` returns the LemonBooks app and that a real inbound message produces HTTP 200 at the callback.

### Required production environment

```dotenv
META_APP_ID=848510244918866
WHATSAPP_APP_SECRET=<Meta app secret; META_APP_SECRET is also supported>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<strong private random value shared only with Meta>
WHATSAPP_PLATFORM_TENANT_SLUG=<existing internal LemonBooks tenant slug>
WHATSAPP_PLATFORM_WABA_ID=1059428370199321
WHATSAPP_PLATFORM_PHONE_NUMBER_ID=1356821100840583
WHATSAPP_PLATFORM_ACCESS_TOKEN=<permanent system-user token>
INTEGRATION_CREDENTIALS_KEY=<existing 32-byte integration encryption key>
PUBLIC_WEB_URL=https://lemonbooks.io
```

All four `WHATSAPP_PLATFORM_*` values are atomic: configure all or none. Startup fails closed for a partial configuration, a missing encryption key, an unknown platform tenant, or a phone number already owned by another tenant. The token is encrypted before database persistence and is never returned by an API.

After changing production environment values:

```bash
npm run build --workspace=apps/api
sudo systemctl restart lemonbooks-api
sudo systemctl status lemonbooks-api --no-pager
```

Expected startup output includes `WhatsApp platform connection ready for phone 1356821100840583`. Monitor delivery with:

```bash
sudo journalctl -u lemonbooks-api -f
sudo tail -f /var/log/nginx/access.log | grep --line-buffered '/api/v3/webhooks/whatsapp'
```

### Initial conversation behavior

- `REGISTER`, `SIGN UP`, `CREATE ACCOUNT`, `GET STARTED`, `CONNECT`, `LINK`, `LOGIN`, or `SIGN IN` returns a private, single-use HTTPS link expiring after 30 minutes. The recipient can choose signup or existing-account sign-in. Signup links only after email OTP verification; existing accounts link only after successful authentication and a verified email. The web form explicitly requests consent to connect the number that received the link. Passwords and OTPs are never collected in WhatsApp.
- Successful linking queues a WhatsApp confirmation in the same database transaction. `HELP` and subsequent requests recognize the linked workspace. `UNLINK` deletes the account association, cancels its pending confirmations, and invalidates outstanding links; business records remain intact. Changing accounts requires UNLINK first.
- `INVOICE`, `ORDER`, `SALE`, `EXPENSE`, `STOCK`, `INVENTORY`, `RESTOCK`, or `RECORD` stores the inbound request and identifies it explicitly as a draft awaiting review.
- `PAID`, `PAYMENT`, `TRANSFER`, `TRANSFERRED`, or `RECEIPT` stores evidence and states explicitly that payment remains unconfirmed until matched to authoritative provider/bank evidence.
- `STOP`, `UNSUBSCRIBE`, or `OPT OUT` records opt-out and suppresses the reply.
- Other text receives the welcome/help menu.

Only a connection carrying `capabilities.platformEntryPoint=true` may use these automatic replies. A send failure is logged without deactivating inbound ingestion. Duplicate provider message IDs do not produce duplicate replies.

### Acceptance test order

1. Restart and confirm the platform-connection startup line.
2. Send `HELP` from an authorized real WhatsApp account and confirm one inbound webhook HTTP 200, one stored inbound message, and one accepted reply.
3. Send `REGISTER`, follow the private link, consent to linking, and complete OTP signup. Confirm the web success screen and WhatsApp confirmation. Existing users should choose Sign in instead of registering again. Old generic signup links cannot connect a conversation retroactively: send CONNECT for a fresh link.
4. Send a payment claim and verify the response never says paid, settled, reconciled, or confirmed.
5. Send `STOP`, then another message, and verify automation remains suppressed.
6. Confirm the conversation appears in the tenant's LemonBooks WhatsApp inbox with inbound/outbound provider states.
7. Expire/revoke the test token in staging and prove the error is visible while subsequent inbound webhooks continue to be accepted.

### Deliberately deferred lifecycle

Account linking is implemented; conversational messages do not yet create accounting records. Record creation still requires explicit confirmation, validated structured commands, domain-service execution, idempotency, and merchant/human review as specified in sections 35 and 36. Conversations remain in the internal platform inbox, with a separate association to the authenticated user's workspace; they are not moved into another merchant's inbox. Merchant self-service WhatsApp connection continues to use Embedded Signup; the platform-number token must never be reused as a merchant credential.

### Account-link storage and delivery

- `whatsapp_account_link_tickets` stores a SHA-256 hash of a cryptographically random 256-bit token, the originating contact/conversation, expiry, and consumption time. The browser receives the secret in the URL fragment, which is omitted from HTTP request URLs and Referer headers; outbound inbox copies redact it. Signup challenges retain only the hash. A new link invalidates prior unconsumed links for the sender.
- `whatsapp_account_links` maps a contact to a verified user and workspace membership. No account is inferred from a matching phone number. Expired, tampered, consumed, opted-out, or disconnected tickets cannot link. An existing association cannot be reassigned to another user/workspace. Removing membership cascades the association and queued confirmation; lookups also check membership. Link/unlink actions are audited without storing tokens.
- `whatsapp_link_notifications` is processed by the existing worker. PostgreSQL row locks prevent simultaneous workers sending the same queued job. Provider failure retries up to five attempts with exponential backoff. Opt-out, connection loss, membership loss, or a closed 24-hour window suppresses free-form confirmation. A later HELP still shows the linked workspace. Provider acceptance is stored separately from delivered/read status.
- As with other external sends, an ambiguous network timeout or crash after provider acceptance but before database commit may duplicate a notification on retry; this is not an exactly-once delivery guarantee. No financial posting occurs in this worker.
- Migrations create the three tables at API startup. No new environment values are required. Deploy both API and web changes. Existing generic links must be replaced by requesting CONNECT again. To roll back replies, disable the platform connection; preserve link tables for recovery and audit.
- Regression test: `RUN_DB_TESTS=1 node --import tsx --test apps/api/src/integrations/whatsapp-account-link.integration.test.ts` uses a randomly named temporary PostgreSQL schema, mocks email/Meta, and verifies signup, login, duplicate webhooks, consumed/expired links, cross-account rejection, retries, opt-out, closed windows, membership revocation, and absence of accounting posts.

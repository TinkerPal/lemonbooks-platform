import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { env } from "../config";
import { query, transaction } from "../database/pool";
import { HttpError } from "../http";
import { decryptMetaCredentials, sendMetaMessage } from "./meta-whatsapp.service";
import { claimAccountPhone } from "./account-phone.service";

export type LinkResult = { status: "linked" | "unavailable"; message: string };
const unavailable: LinkResult = { status: "unavailable", message: "Your account is ready, but this WhatsApp link has expired or is unavailable. Send CONNECT to LemonBooks on WhatsApp for a fresh link, then sign in." };

export function hashWhatsAppLink(token: unknown): string | null {
  return typeof token === "string" && /^[a-f0-9]{64}$/.test(token)
    ? crypto.createHash("sha256").update(token).digest("hex") : null;
}

export async function createWhatsAppLink(contactId: string, conversationId: string) {
  const token = crypto.randomBytes(32).toString("hex");
  await transaction(async client => {
    // Serialize issuance against linking and invalidate earlier links for this sender.
    const { rows } = await client.query(`SELECT c.id FROM whatsapp_contacts c
      JOIN integration_connections i ON i.id=c.connection_id
      JOIN whatsapp_conversations v ON v.contact_id=c.id AND v.connection_id=i.id
      WHERE c.id=$1 AND v.id=$2 AND c.consent_state='opted_in'
        AND i.status='active' AND i.deleted_at IS NULL
        AND i.capabilities->>'platformEntryPoint'='true' FOR UPDATE OF c`, [contactId, conversationId]);
    if (!rows.length) throw new HttpError(409, "WhatsApp connection is unavailable");
    await client.query("UPDATE whatsapp_account_link_tickets SET consumed_at=now() WHERE contact_id=$1 AND consumed_at IS NULL", [contactId]);
    await client.query(`INSERT INTO whatsapp_account_link_tickets(token_hash,contact_id,conversation_id,expires_at)
      VALUES($1,$2,$3,now()+interval '30 minutes')`, [hashWhatsAppLink(token), contactId, conversationId]);
  });
  const url = new URL("/login", env.publicWebUrl);
  url.searchParams.set("mode", "signup");
  // Fragments are not sent in HTTP requests or Referer headers.
  url.hash = `whatsapp_link=${token}`;
  return url.toString();
}

// Called only after account authentication, within the same transaction as signup/linking.
export async function completeWhatsAppLink(client: PoolClient, hash: string | null, userId: string, businessId: string): Promise<LinkResult> {
  if (!hash) return unavailable;
  const { rows: [ticket] } = await client.query(`SELECT t.id,t.contact_id,t.conversation_id
    FROM whatsapp_account_link_tickets t
    JOIN whatsapp_contacts c ON c.id=t.contact_id
    JOIN integration_connections i ON i.id=c.connection_id
    WHERE t.token_hash=$1 AND t.consumed_at IS NULL AND t.expires_at>now()
      AND c.consent_state='opted_in' AND i.status='active' AND i.deleted_at IS NULL
      AND i.capabilities->>'platformEntryPoint'='true' FOR UPDATE OF c,t`, [hash]);
  if (!ticket) return unavailable;
  const { rows: [member] } = await client.query(`SELECT b.name FROM memberships m
    JOIN businesses b ON b.id=m.business_id JOIN users u ON u.id=m.user_id
    WHERE m.user_id=$1 AND m.business_id=$2 AND (u.email_verified_at IS NOT NULL
      OR EXISTS(SELECT 1 FROM whatsapp_auth_identities a WHERE a.user_id=u.id))`, [userId, businessId]);
  if (!member) return unavailable;
  const { rows: [contact] } = await client.query<{ phone_e164: string }>("SELECT phone_e164 FROM whatsapp_contacts WHERE id=$1", [ticket.contact_id]);
  try { await claimAccountPhone(client, contact?.phone_e164, userId, businessId); }
  catch (error) { if (error instanceof HttpError && error.code === "PHONE_ALREADY_IN_USE") return { status: "unavailable", message: error.message }; throw error; }
  const { rows: [existing] } = await client.query("SELECT business_id,user_id FROM whatsapp_account_links WHERE contact_id=$1", [ticket.contact_id]);
  if (existing && (existing.business_id !== businessId || existing.user_id !== userId)) {
    return { status: "unavailable", message: "This WhatsApp number is already linked to another account. Send UNLINK from that WhatsApp number before connecting a different account." };
  }
  await client.query(`INSERT INTO whatsapp_account_links(contact_id,business_id,user_id) VALUES($1,$2,$3)
    ON CONFLICT(contact_id) DO NOTHING`, [ticket.contact_id, businessId, userId]);
  await client.query("UPDATE whatsapp_account_link_tickets SET consumed_at=now() WHERE id=$1", [ticket.id]);
  await client.query(`INSERT INTO integration_audit_log(business_id,actor_type,actor_id,action,resource_type,resource_id)
    VALUES($1,'user',$2,'whatsapp.account_linked','whatsapp_contact',$3)`, [businessId, userId, ticket.contact_id]);
  await client.query(`INSERT INTO whatsapp_link_notifications(ticket_id,contact_id,conversation_id,body)
    VALUES($1,$2,$3,$4) ON CONFLICT(ticket_id) DO NOTHING`, [ticket.id, ticket.contact_id, ticket.conversation_id,
    `Your workspace ${member.name} is ready and linked to this WhatsApp number. Reply HELP to continue. You can send business requests here; accounting records still require review. Reply UNLINK to disconnect your account.`]);
  return { status: "linked", message: `WhatsApp is connected to ${member.name}. A confirmation has been queued for your chat.` };
}

export async function getWhatsAppLinkedWorkspace(contactId: string) {
  return (await query<{ name: string; tenant_slug: string }>(`SELECT b.name,b.tenant_slug FROM whatsapp_account_links l
    JOIN memberships m ON m.business_id=l.business_id AND m.user_id=l.user_id
    JOIN businesses b ON b.id=l.business_id WHERE l.contact_id=$1`, [contactId]))[0];
}

export async function unlinkWhatsAppAccount(contactId: string) {
  await transaction(async client => {
    await client.query("SELECT id FROM whatsapp_contacts WHERE id=$1 FOR UPDATE", [contactId]);
    const { rows: [removed] } = await client.query("DELETE FROM whatsapp_account_links WHERE contact_id=$1 RETURNING business_id", [contactId]);
    if (removed) await client.query(`INSERT INTO integration_audit_log(business_id,actor_type,actor_id,action,resource_type,resource_id)
      VALUES($1,'whatsapp_contact',$2,'whatsapp.account_unlinked','whatsapp_contact',$2)`, [removed.business_id, contactId]);
    await client.query("UPDATE whatsapp_account_link_tickets SET consumed_at=now() WHERE contact_id=$1 AND consumed_at IS NULL", [contactId]);
  });
}

export async function processWhatsAppLinkNotifications() {
  await transaction(async client => {
    const { rows: [job] } = await client.query(`SELECT * FROM whatsapp_link_notifications
      WHERE state='pending' AND next_attempt_at<=now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!job) return;
    const { rows: [target] } = await client.query(`SELECT c.*,i.encrypted_credentials,i.external_account_id,i.status AS connection_status,
      i.deleted_at,i.capabilities FROM whatsapp_contacts c JOIN integration_connections i ON i.id=c.connection_id
      JOIN whatsapp_account_links l ON l.contact_id=c.id
      JOIN memberships m ON m.user_id=l.user_id AND m.business_id=l.business_id WHERE c.id=$1`, [job.contact_id]);
    if (!target || target.consent_state !== "opted_in" || target.connection_status !== "active" || target.deleted_at
      || target.capabilities?.platformEntryPoint !== true || !target.service_window_expires_at
      || new Date(target.service_window_expires_at).getTime() <= Date.now()) {
      await client.query("UPDATE whatsapp_link_notifications SET state='suppressed' WHERE id=$1", [job.id]);
      return;
    }
    let providerId: string;
    try {
      const credentials = decryptMetaCredentials(target.encrypted_credentials);
      providerId = await sendMetaMessage({ accessToken: credentials.accessToken, phoneNumberId: target.external_account_id, to: target.phone_e164, body: job.body });
    } catch {
      await client.query(`UPDATE whatsapp_link_notifications SET attempts=attempts+1,
        state=CASE WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,
        next_attempt_at=now()+interval '30 seconds'*power(2,attempts) WHERE id=$1`, [job.id]);
      console.warn(`WhatsApp account-link confirmation failed; notification ${job.id}, attempt ${job.attempts + 1}`);
      return;
    }
    await client.query(`INSERT INTO whatsapp_messages(business_id,conversation_id,provider_message_id,direction,message_type,body,provider_status,occurred_at)
      VALUES($1,$2,$3,'outbound','text',$4,'accepted',now()) ON CONFLICT(business_id,provider_message_id) DO NOTHING`, [target.business_id, job.conversation_id, providerId, job.body]);
    await client.query("UPDATE whatsapp_conversations SET last_outbound_at=now(),state='awaiting_customer',updated_at=now() WHERE id=$1", [job.conversation_id]);
    await client.query("UPDATE whatsapp_link_notifications SET state='sent',provider_message_id=$2,attempts=attempts+1 WHERE id=$1", [job.id, providerId]);
    console.log(`WhatsApp account-link confirmation accepted: ${job.id}`);
  });
}

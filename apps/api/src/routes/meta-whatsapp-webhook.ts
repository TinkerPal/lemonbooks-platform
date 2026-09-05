import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config";
import { query, transaction } from "../database/pool";
import { HttpError } from "../http";
import { extractBusinessSignals } from "../services/whatsapp.service";
import { decryptMetaCredentials, sendMetaMessage } from "../services/meta-whatsapp.service";
import { linkedPlatformReply } from "../services/whatsapp-platform.service";
import { unlinkWhatsAppAccount } from "../services/whatsapp-account-link.service";

export function metaWebhookVerification(req: Request, res: Response) {
  if (!env.whatsapp.verifyToken || String(req.query["hub.verify_token"] ?? "") !== env.whatsapp.verifyToken) return res.sendStatus(403);
  return res.status(200).send(String(req.query["hub.challenge"] ?? ""));
}

export async function metaWebhookReceiver(req: Request, res: Response, next: NextFunction) {
  try {
    if (!env.whatsapp.appSecret || !req.rawBody) throw new HttpError(503, "WhatsApp webhook is not configured");
    const supplied = String(req.headers["x-hub-signature-256"] ?? "").replace(/^sha256=/, "");
    const expected = crypto.createHmac("sha256", env.whatsapp.appSecret).update(req.rawBody).digest("hex");
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new HttpError(401, "Invalid WhatsApp signature");
    for (const entry of req.body?.entry ?? []) for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const phoneId = String(value.metadata?.phone_number_id ?? "");
      const connection = (await query<Record<string, unknown>>("SELECT * FROM integration_connections WHERE provider='meta_whatsapp' AND environment='production' AND external_account_id=$1 AND status='active' AND deleted_at IS NULL", [phoneId]))[0];
      if (!connection) {
        console.warn(`WhatsApp webhook ignored: no active connection for phone ${phoneId || "unknown"}`);
        continue;
      }
      for (const message of value.messages ?? []) await ingestMessage(connection, message, value.contacts?.[0]);
      for (const status of value.statuses ?? []) await ingestStatus(connection, status);
    }
    console.log(`WhatsApp webhook accepted: ${req.body?.entry?.length ?? 0} entr${req.body?.entry?.length === 1 ? "y" : "ies"}`);
    res.sendStatus(200);
  } catch (error) { next(error); }
}

async function ingestMessage(connection: Record<string, any>, message: Record<string, any>, profile?: Record<string, any>) {
  const providerEventId = `message:${message.id}`;
  const occurredAt = new Date(Number(message.timestamp) * 1000);
  const body = String(message.text?.body ?? message.button?.text ?? message.interactive?.button_reply?.title ?? "");
  const ingested = await transaction(async client => {
    const event = (await client.query<Record<string, any>>(`INSERT INTO integration_events(business_id,connection_id,provider,environment,provider_event_id,event_type,payload_hash,raw_payload,signature_valid,occurred_at,status,processed_at) VALUES($1,$2,'meta_whatsapp','production',$3,'messages',$4,$5,true,$6,'processed',now()) ON CONFLICT(provider,environment,provider_event_id) DO NOTHING RETURNING id`, [connection.business_id, connection.id, providerEventId, crypto.createHash("sha256").update(JSON.stringify(message)).digest("hex"), JSON.stringify(message), occurredAt])).rows[0];
    if (!event) return null;
    const phone = `+${String(message.from ?? "").replace(/\D/g, "")}`;
    const signals = extractBusinessSignals(body);
    const clientMatch = (await client.query<Record<string, any>>("SELECT id FROM clients WHERE business_id=$1 AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g') AND deleted_at IS NULL LIMIT 1", [connection.business_id, phone])).rows[0];
    const contact = (await client.query<Record<string, any>>(`INSERT INTO whatsapp_contacts(business_id,connection_id,client_id,provider_contact_id,phone_e164,display_name,consent_state,consent_source,consented_at,last_inbound_at,service_window_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'customer_initiated',CASE WHEN $7='opted_in' THEN now() END,$8::timestamptz,$8::timestamptz+interval '24 hours') ON CONFLICT(connection_id,phone_e164) DO UPDATE SET client_id=COALESCE(whatsapp_contacts.client_id,EXCLUDED.client_id),display_name=COALESCE(EXCLUDED.display_name,whatsapp_contacts.display_name),consent_state=CASE WHEN whatsapp_contacts.consent_state='opted_out' THEN 'opted_out' ELSE EXCLUDED.consent_state END,last_inbound_at=$8::timestamptz,service_window_expires_at=$8::timestamptz+interval '24 hours',updated_at=now() RETURNING *`, [connection.business_id, connection.id, clientMatch?.id ?? null, message.from, phone, profile?.profile?.name ?? null, signals.optOut ? "opted_out" : "opted_in", occurredAt])).rows[0]!;
    if (signals.optOut) await client.query("UPDATE whatsapp_contacts SET opted_out_at=now() WHERE id=$1", [contact.id]);
    const conversation = (await client.query<Record<string, any>>(`INSERT INTO whatsapp_conversations(business_id,connection_id,contact_id,state,last_inbound_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(connection_id,contact_id) DO UPDATE SET state=EXCLUDED.state,last_inbound_at=$5,updated_at=now() RETURNING *`, [connection.business_id, connection.id, contact.id, signals.optOut ? "blocked" : "awaiting_business", occurredAt])).rows[0]!;
    const storedMessage = (await client.query<Record<string, any>>(`INSERT INTO whatsapp_messages(business_id,conversation_id,provider_message_id,direction,message_type,body,provider_status,occurred_at) VALUES($1,$2,$3,'inbound',$4,$5,'received',$6) ON CONFLICT(business_id,provider_message_id) DO UPDATE SET body=whatsapp_messages.body RETURNING id`, [connection.business_id, conversation.id, message.id, message.type ?? "text", body, occurredAt])).rows[0];
    if (message.type === "audio" && message.audio?.id && storedMessage) {
      await client.query(`INSERT INTO whatsapp_media_jobs(business_id,connection_id,conversation_id,message_id,provider_media_id,media_type,mime_type)
        VALUES($1,$2,$3,$4,$5,'audio',$6) ON CONFLICT(connection_id,provider_media_id) DO NOTHING`, [connection.business_id, connection.id, conversation.id, storedMessage.id, String(message.audio.id), "audio/ogg"]);
    }
    await client.query("UPDATE integration_connections SET last_success_at=now(),last_error_code=NULL,updated_at=now() WHERE id=$1", [connection.id]);
    return { conversationId: conversation.id, contactId: contact.id, phone, consentState: contact.consent_state, audio: message.type === "audio" };
  });
  if (!ingested || !isPlatformConnection(connection)) return;
  if (ingested.audio) return;
  if (ingested.consentState === "opted_out") {
    if (/^unlink$/i.test(body.trim())) await unlinkWhatsAppAccount(ingested.contactId);
    return;
  }
  try {
    const reply = await linkedPlatformReply({ body, contactId: ingested.contactId, conversationId: ingested.conversationId, displayName: profile?.profile?.name, publicWebUrl: env.publicWebUrl });
    if (!reply) return;
    const credentials = decryptMetaCredentials(String(connection.encrypted_credentials ?? ""));
    const providerId = await sendMetaMessage({ accessToken: credentials.accessToken, phoneNumberId: String(connection.external_account_id), to: ingested.phone, body: reply });
    await transaction(async client => {
      await client.query(`INSERT INTO whatsapp_messages(business_id,conversation_id,provider_message_id,direction,message_type,body,provider_status,reply_to_provider_id,occurred_at) VALUES($1,$2,$3,'outbound','text',$4,'accepted',$5,now()) ON CONFLICT(business_id,provider_message_id) DO NOTHING`, [connection.business_id, ingested.conversationId, providerId, reply.replace(/whatsapp_link=[a-f0-9]{64}/g, "whatsapp_link=[private link]"), message.id]);
      await client.query("UPDATE whatsapp_conversations SET state='awaiting_customer',last_outbound_at=now(),updated_at=now() WHERE id=$1", [ingested.conversationId]);
    });
    console.log(`WhatsApp platform reply accepted for conversation ${ingested.conversationId}`);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "WhatsApp platform reply failed";
    await query("UPDATE integration_connections SET last_error_code=$1,updated_at=now() WHERE id=$2", [messageText.slice(0, 120), connection.id]);
    console.error(`WhatsApp platform reply failed: ${messageText}`);
  }
}

function isPlatformConnection(connection: Record<string, any>) {
  try {
    const capabilities = typeof connection.capabilities === "string" ? JSON.parse(connection.capabilities) : connection.capabilities;
    return capabilities?.platformEntryPoint === true;
  } catch {
    return false;
  }
}

async function ingestStatus(connection: Record<string, any>, status: Record<string, any>) {
  const eventId = `status:${status.id}:${status.status}:${status.timestamp}`;
  await transaction(async client => {
    const event = (await client.query(`INSERT INTO integration_events(business_id,connection_id,provider,environment,provider_event_id,event_type,payload_hash,raw_payload,signature_valid,occurred_at,status,processed_at) VALUES($1,$2,'meta_whatsapp','production',$3,'message_status',$4,$5,true,to_timestamp($6),'processed',now()) ON CONFLICT(provider,environment,provider_event_id) DO NOTHING RETURNING id`, [connection.business_id, connection.id, eventId, crypto.createHash("sha256").update(JSON.stringify(status)).digest("hex"), JSON.stringify(status), Number(status.timestamp)])).rows[0];
    if (!event) return;
    await client.query("UPDATE whatsapp_messages SET provider_status=$1 WHERE business_id=$2 AND provider_message_id=$3", [String(status.status ?? "unknown"), connection.business_id, status.id]);
    await client.query("UPDATE integration_connections SET last_success_at=now(),last_error_code=NULL,updated_at=now() WHERE id=$1", [connection.id]);
  });
}

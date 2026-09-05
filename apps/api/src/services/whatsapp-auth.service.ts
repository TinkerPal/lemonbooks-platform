import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { PoolClient } from "pg";
import { transaction } from "../database/pool";
import { HttpError } from "../http";
import { createSessionToken } from "../middleware/auth";
import { publicBusiness, slugify } from "./auth.service";
import { completeWhatsAppLink, hashWhatsAppLink } from "./whatsapp-account-link.service";
import { decryptMetaCredentials, sendMetaMessage } from "./meta-whatsapp.service";
import { claimAccountPhone } from "./account-phone.service";

async function ticket(client: PoolClient, token: unknown) {
  const { rows: [row] } = await client.query(`SELECT t.id,c.id AS contact_id,c.phone_e164,
    i.encrypted_credentials,i.external_account_id FROM whatsapp_account_link_tickets t
    JOIN whatsapp_contacts c ON c.id=t.contact_id JOIN integration_connections i ON i.id=c.connection_id
    WHERE t.token_hash=$1 AND t.consumed_at IS NULL AND t.expires_at>now()
    AND c.consent_state='opted_in' AND c.service_window_expires_at>now()
    AND i.status='active' AND i.deleted_at IS NULL AND i.capabilities->>'platformEntryPoint'='true'
    FOR UPDATE OF c,t`, [hashWhatsAppLink(token)]);
  if (!row) throw new HttpError(410, "This link is unavailable. Send LOGIN or REGISTER to LemonBooks on WhatsApp for a new link.");
  // Serialize identities across contacts and tickets belonging to the same phone.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [row.phone_e164]);
  return row;
}

export async function requestWhatsAppCode(token: unknown) {
  return transaction(async client => {
    const t = await ticket(client, token);
    const { rows: [rate] } = await client.query(`SELECT count(*)::int AS count FROM whatsapp_auth_challenges a
      JOIN whatsapp_account_link_tickets t ON t.id=a.ticket_id JOIN whatsapp_contacts c ON c.id=t.contact_id
      WHERE c.phone_e164=$1 AND a.sent_at>now()-interval '1 minute'`, [t.phone_e164]);
    if (rate.count) throw new HttpError(429, "Wait a minute before requesting another code.");
    const { rows: [budget] } = await client.query(`SELECT COALESCE(sum(a.send_count),0)::int AS count
      FROM whatsapp_auth_challenges a JOIN whatsapp_account_link_tickets t ON t.id=a.ticket_id
      JOIN whatsapp_contacts c ON c.id=t.contact_id WHERE c.phone_e164=$1 AND a.sent_at>now()-interval '1 hour'`, [t.phone_e164]);
    if (budget.count >= 10) throw new HttpError(429, "Too many codes requested. Try again in an hour.");
    const otp = String(crypto.randomInt(100000, 1000000));
    await client.query(`INSERT INTO whatsapp_auth_challenges(ticket_id,otp_hash,expires_at)
      VALUES($1,$2,now()+interval '10 minutes') ON CONFLICT(ticket_id) DO UPDATE SET
      otp_hash=EXCLUDED.otp_hash,expires_at=EXCLUDED.expires_at,sent_at=now(),attempts=0,proof_hash=NULL,verified_at=NULL,
      send_count=CASE WHEN whatsapp_auth_challenges.sent_at<now()-interval '1 hour' THEN 1 ELSE whatsapp_auth_challenges.send_count+1 END`,
    [t.id, await bcrypt.hash(otp, 10)]);
    try {
      await sendMetaMessage({ accessToken: decryptMetaCredentials(t.encrypted_credentials).accessToken,
        phoneNumberId: t.external_account_id, to: t.phone_e164,
        body: `Your LemonBooks verification code is ${otp}. It expires in 10 minutes. Enter it only on the LemonBooks page you opened. Do not share this code.` });
    } catch { throw new HttpError(502, "Your code could not be sent. Please try again shortly."); }
    return { phone: `••••${t.phone_e164.slice(-4)}` };
  });
}

export async function verifyWhatsAppCode(token: unknown, otp: unknown) {
  const result = await transaction(async client => {
    const t = await ticket(client, token);
    const { rows: [a] } = await client.query(`SELECT * FROM whatsapp_auth_challenges
      WHERE ticket_id=$1 AND expires_at>now() AND verified_at IS NULL FOR UPDATE`, [t.id]);
    if (!a) throw new HttpError(410, "Request a new verification code.");
    if (a.attempts >= 5) throw new HttpError(429, "Too many attempts. Request a new code.");
    if (typeof otp !== "string" || !/^\d{6}$/.test(otp) || !await bcrypt.compare(otp, a.otp_hash)) {
      await client.query("UPDATE whatsapp_auth_challenges SET attempts=attempts+1 WHERE ticket_id=$1", [t.id]);
      return null; // Commit the attempt before returning an error.
    }
    const proof = crypto.randomBytes(32).toString("hex");
    await client.query("UPDATE whatsapp_auth_challenges SET verified_at=now(),proof_hash=$2 WHERE ticket_id=$1", [t.id, hashWhatsAppLink(proof)]);
    const { rows: identities } = await client.query(`SELECT user_id FROM whatsapp_auth_identities WHERE phone=$1
      UNION SELECT user_id FROM account_phone_claims WHERE phone=regexp_replace($1,'[^0-9]','','g')
      UNION SELECT user_id FROM whatsapp_account_links WHERE contact_id=$2`, [t.phone_e164, t.contact_id]);
    if (identities.length > 1) throw new HttpError(409, "This number has conflicting account links. Contact support to resolve them.");
    const identity = identities[0];
    if (identity) {
      await client.query("INSERT INTO whatsapp_auth_identities(phone,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [t.phone_e164, identity.user_id]);
      const { rows: workspaces } = await client.query(`SELECT b.id,b.name FROM memberships m JOIN businesses b ON b.id=m.business_id WHERE m.user_id=$1`, [identity.user_id]);
      return { proof, workspaces, existing: true };
    }
    return { proof, workspaces: [], existing: false };
  });
  if (!result) throw new HttpError(400, "That verification code is not correct.");
  return result;
}

export async function finishWhatsAppAuth(input: Record<string, unknown>) {
  return transaction(async client => {
    const t = await ticket(client, input.whatsappLinkToken);
    const { rows: [a] } = await client.query(`SELECT ticket_id FROM whatsapp_auth_challenges
      WHERE ticket_id=$1 AND proof_hash=$2 AND verified_at IS NOT NULL AND expires_at>now() FOR UPDATE`, [t.id, hashWhatsAppLink(input.proof)]);
    if (!a) throw new HttpError(401, "Verify your WhatsApp number again to continue.");
    const { rows: [identity] } = await client.query("SELECT user_id FROM whatsapp_auth_identities WHERE phone=$1", [t.phone_e164]);
    let userId: string | undefined = identity?.user_id as string | undefined;
    let businessId: string | undefined = typeof input.businessId === "string" ? input.businessId : undefined;
    if (!userId) {
      const field = (key: string, max: number) => typeof input[key] === "string" ? (input[key] as string).trim().slice(0,max) : "";
      const name = field("name",120), businessName = field("businessName",160);
      const country = field("countryCode",2), currency = field("currency",3), timezone = field("timezone",80);
      if (!name || !slugify(businessName) || !/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, "Enter your name, business name, country and currency.");
      try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { throw new HttpError(400, "Choose a valid timezone."); }
      const { rows: [user] } = await client.query("INSERT INTO users(name) VALUES($1) RETURNING id", [name]);
      userId = String(user.id);
      const { rows: [business] } = await client.query(`INSERT INTO businesses(tenant_slug,name,phone,address,country_code,currency,timezone,onboarding_completed)
        VALUES($1,$2,$3,$4,$5,$6,$7,true) RETURNING id`, [slugify(businessName)+"-"+crypto.randomBytes(4).toString("hex"),businessName,t.phone_e164,field("address",500),country,currency,timezone]);
      businessId = String(business.id);
      await client.query(`INSERT INTO memberships(business_id,user_id,role,permissions) VALUES($1,$2,'owner','["all"]')`, [businessId,userId]);
      await claimAccountPhone(client, t.phone_e164, userId, businessId);
      await client.query("INSERT INTO whatsapp_auth_identities(phone,user_id) VALUES($1,$2)", [t.phone_e164,userId]);
    }
    if (!userId || !businessId) throw new HttpError(400, "Complete the account details to continue.");
    const { rows: [member] } = await client.query(`SELECT b.*,m.role,u.name AS user_name,u.email AS user_email
      FROM memberships m JOIN businesses b ON b.id=m.business_id JOIN users u ON u.id=m.user_id
      WHERE m.user_id=$1 AND b.id::text=$2`, [userId,typeof businessId === "string" ? businessId : ""]);
    if (!member) throw new HttpError(403, "Choose a workspace you belong to.");
    const whatsappLink = await completeWhatsAppLink(client, hashWhatsAppLink(input.whatsappLinkToken), userId, member.id);
    if (whatsappLink.status !== "linked") throw new HttpError(409, whatsappLink.message);
    await client.query("UPDATE whatsapp_auth_challenges SET proof_hash=NULL,otp_hash='',expires_at=now() WHERE ticket_id=$1", [t.id]);
    return { token: createSessionToken({sub:userId,businessId:member.id,tenantSlug:member.tenant_slug,role:member.role}),
      user:{id:userId,name:member.user_name,email:member.user_email,role:member.role},business:publicBusiness(member) };
  });
}

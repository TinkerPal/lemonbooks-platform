import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../http";

export function normalizeAccountPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

export async function claimAccountPhone(client: PoolClient, phone: unknown, userId: string, businessId: string) {
  const normalized = normalizeAccountPhone(phone);
  if (!normalized) return;
  const lock = crypto.createHash("sha256").update(normalized).digest().readInt32BE(0);
  await client.query("SELECT pg_advisory_xact_lock($1)", [lock]);
  const { rows: [claim] } = await client.query("SELECT user_id,business_id FROM account_phone_claims WHERE phone=$1 FOR UPDATE", [normalized]);
  const { rows: [business] } = await client.query(`SELECT id FROM businesses WHERE id<>$2
    AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=$1 LIMIT 1`, [normalized, businessId]);
  if ((claim && (claim.user_id !== userId || claim.business_id !== businessId)) || business) {
    throw new HttpError(409, "This phone number is already associated with another LemonBooks account.", "PHONE_ALREADY_IN_USE");
  }
  await client.query(`INSERT INTO account_phone_claims(phone,user_id,business_id) VALUES($1,$2,$3)
    ON CONFLICT(phone) DO NOTHING`, [normalized, userId, businessId]);
}

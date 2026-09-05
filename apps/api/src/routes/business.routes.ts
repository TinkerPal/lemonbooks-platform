import { Router } from "express";
import { query, transaction } from "../database/pool";
import { asyncRoute, HttpError } from "../http";
import { publicBusiness } from "../services/auth.service";
import { env } from "../config";
import { paystack } from "./paystack.routes";
import { claimAccountPhone } from "../services/account-phone.service";

export const businessRouter = Router();

async function fetchPaystackResource(path: string): Promise<Record<string, any> | null> {
  if (!env.paystackSecretKey) return null;
  const response = await fetch(`https://api.paystack.co${path}`, { headers: { Authorization: `Bearer ${env.paystackSecretKey}` } });
  if (response.status === 404) return null;
  const payload = await response.json() as { status: boolean; message?: string; data?: Record<string, any> };
  if (!response.ok || !payload.status) throw new HttpError(502, payload.message || "Could not refresh Paystack account status");
  return payload.data ?? null;
}

businessRouter.get("/me", asyncRoute(async (req, res) => {
  const rows = await query<Record<string, unknown>>("SELECT * FROM businesses WHERE id=$1", [req.auth!.businessId]);
  if (!rows[0]) throw new HttpError(404, "Business not found");
  res.json({ success: true, data: publicBusiness(rows[0]) });
}));

businessRouter.patch("/me", asyncRoute(async (req, res) => {
  const { name, phone, address, countryCode, currency, timezone, logoUrl, email } = req.body;
  if (email !== undefined && (typeof email !== "string" || (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())))) throw new HttpError(400, "Enter a valid contact email");
  if (!name?.trim()) throw new HttpError(400, "Business name is required");
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, "Currency must be a three-letter code");
  const rows = await transaction(async client => {
    await claimAccountPhone(client, phone, req.auth!.userId, req.auth!.businessId);
    return (await client.query<Record<string, unknown>>(
      `UPDATE businesses SET name=$2,phone=$3,address=$4,country_code=$5,currency=$6,timezone=COALESCE($7,timezone),
       logo_url=$8,email=CASE WHEN $9::boolean THEN $10::text ELSE email END,onboarding_completed=true,updated_at=now() WHERE id=$1 RETURNING *`,
      [req.auth!.businessId, name.trim(), phone || null, address || null, countryCode || null, currency || null, timezone || null, logoUrl || null, email !== undefined, email?.trim().toLowerCase() || null],
    )).rows;
  });
  res.json({ success: true, message: "Business settings saved", data: publicBusiness(rows[0]!) });
}));

businessRouter.get("/summary", asyncRoute(async (req, res) => {
  const [summary] = await query<Record<string, string>>(
    `SELECT
      (SELECT count(*) FROM clients WHERE business_id=$1 AND deleted_at IS NULL)::text AS clients,
      (SELECT count(*) FROM items WHERE business_id=$1 AND deleted_at IS NULL)::text AS items,
      (SELECT count(*) FROM invoices WHERE business_id=$1 AND deleted_at IS NULL)::text AS invoices,
      (SELECT COALESCE(sum(total-amount_paid),0) FROM invoices WHERE business_id=$1 AND status NOT IN ('paid','cancelled') AND deleted_at IS NULL)::text AS outstanding,
      (SELECT COALESCE(sum(amount),0) FROM payments WHERE business_id=$1 AND deleted_at IS NULL AND received_at >= date_trunc('month',now()))::text AS received_this_month`,
    [req.auth!.businessId],
  );
  res.json({ success: true, data: {
    clients: Number(summary?.clients ?? 0), items: Number(summary?.items ?? 0), invoices: Number(summary?.invoices ?? 0),
    outstanding: Number(summary?.outstanding ?? 0), receivedThisMonth: Number(summary?.received_this_month ?? 0),
  }});
}));

businessRouter.get("/payment-providers", (_req, res) => {
  res.json({ success: true, data: [
    { id: "paystack", name: "Paystack", description: "Accept cards, bank transfers, USSD, and mobile money.", status: env.paystackSecretKey ? "available" : "setup_required" },
    { id: "manual", name: "Manual payments", description: "Record cash, bank transfer, and POS payments.", status: "available" },
  ]});
});

businessRouter.get("/payment-account", asyncRoute(async (req, res) => {
  let rows = await query<Record<string, any>>(
    `SELECT status,settlement_bank_code,settlement_bank_name,settlement_account_number,settlement_account_name,
     platform_fee_percent,provider_subaccount_code,provider_customer_code,virtual_bank_name,virtual_account_number,virtual_account_name,currency,failure_reason,updated_at
     FROM business_payment_accounts WHERE business_id=$1`, [req.auth!.businessId],
  );
  const local = rows[0];
  if (local?.provider_subaccount_code && env.paystackSecretKey) {
    const remoteSubaccount = await fetchPaystackResource(`/subaccount/${encodeURIComponent(local.provider_subaccount_code)}`);
    if (!remoteSubaccount || remoteSubaccount.active === false || remoteSubaccount.active === 0) {
      rows = await query<Record<string, any>>(
        `UPDATE business_payment_accounts SET status='failed',failure_reason='The mapped Paystack subaccount was deleted or deactivated. Set up the payment account again.',updated_at=now() WHERE business_id=$1 RETURNING *`,
        [req.auth!.businessId],
      );
    } else if (local.provider_customer_code && !local.virtual_account_number) {
      let dvaResponse: Record<string, any> | null = null;
      try { dvaResponse = await fetchPaystackResource(`/dedicated_account?customer=${encodeURIComponent(local.provider_customer_code)}&active=true`); }
      catch { /* DVA is optional and may not be enabled for this Paystack integration. */ }
      const dvaList = Array.isArray(dvaResponse) ? dvaResponse : [];
      const dva = dvaList.find((entry: Record<string, any>) => entry.active && entry.assigned);
      rows = dva ? await query<Record<string, any>>(
        `UPDATE business_payment_accounts SET status='active',provider_dva_id=$2,virtual_bank_name=$3,virtual_bank_slug=$4,virtual_account_number=$5,virtual_account_name=$6,currency=$7,provider_payload=provider_payload || $8::jsonb,failure_reason=NULL,updated_at=now() WHERE business_id=$1 RETURNING *`,
        [req.auth!.businessId, String(dva.id), dva.bank?.name, dva.bank?.slug, dva.account_number, dva.account_name, dva.currency ?? "NGN", JSON.stringify({ dedicatedAccount: dva })],
      ) : await query<Record<string, any>>(
        `UPDATE business_payment_accounts SET status='active',failure_reason='Paystack checkout and split settlement are active. Dedicated NUBAN is not enabled or has not been assigned.',updated_at=now() WHERE business_id=$1 RETURNING *`,
        [req.auth!.businessId],
      );
    }
  }
  const result = rows[0] ?? null;
  if (result?.status === "active" && !result.virtual_account_number) Object.assign(result, {
    virtual_bank_name: "Paystack checkout",
    virtual_account_number: "Active",
    virtual_account_name: result.failure_reason || "Card and checkout payments settle to this business account",
  });
  res.json({ success: true, data: result });
}));

businessRouter.get("/payment-account/banks", asyncRoute(async (_req, res) => {
  if (env.paystackSecretKey.startsWith("sk_test_")) return res.json({ success: true, data: [{ name: "Zenith Bank (Paystack test)", code: "057" }] });
  const response = await paystack("/bank?country=nigeria&currency=NGN&perPage=100");
  return res.json({ success: true, data: response.data.map((bank: Record<string, unknown>) => ({ name: bank.name, code: bank.code })) });
}));

businessRouter.get("/transfer-account", asyncRoute(async (req, res) => {
  const [account] = await query<Record<string, unknown>>(
    `SELECT bank_code,bank_name,account_number,account_name,verified_at,updated_at
     FROM business_transfer_accounts WHERE business_id=$1`,
    [req.auth!.businessId],
  );
  res.json({ success: true, data: account ?? null });
}));

businessRouter.put("/transfer-account", asyncRoute(async (req, res) => {
  const bankCode = String(req.body.bankCode ?? "").trim();
  const accountNumber = String(req.body.accountNumber ?? "").trim();
  if (!bankCode) throw new HttpError(400, "Choose the receiving bank");
  if (!/^\d{10}$/.test(accountNumber)) throw new HttpError(400, "Enter a valid 10-digit account number");
  if (!env.paystackSecretKey) throw new HttpError(503, "Bank account verification is not configured");
  const testMode = env.paystackSecretKey.startsWith("sk_test_");
  if (testMode && (bankCode !== "057" || accountNumber !== "0000000000"))
    throw new HttpError(400, "In test mode use Zenith Bank (057) and account number 0000000000");
  const resolution = testMode
    ? { data: { bank_name: "Zenith Bank", account_name: "PAYSTACK TEST ACCOUNT" } }
    : await paystack(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
  const bankName = String(resolution.data.bank_name ?? "").trim();
  const accountName = String(resolution.data.account_name ?? "").trim();
  if (!bankName || !accountName) throw new HttpError(502, "The bank could not verify this account");
  const [account] = await query<Record<string, unknown>>(
    `INSERT INTO business_transfer_accounts(business_id,bank_code,bank_name,account_number,account_name)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(business_id) DO UPDATE SET bank_code=EXCLUDED.bank_code,bank_name=EXCLUDED.bank_name,
       account_number=EXCLUDED.account_number,account_name=EXCLUDED.account_name,verified_at=now(),updated_at=now()
     RETURNING bank_code,bank_name,account_number,account_name,verified_at,updated_at`,
    [req.auth!.businessId, bankCode, bankName, accountNumber, accountName],
  );
  res.json({ success: true, message: "Transfer account verified and saved", data: account });
}));

businessRouter.delete("/transfer-account", asyncRoute(async (req, res) => {
  await query("DELETE FROM business_transfer_accounts WHERE business_id=$1", [req.auth!.businessId]);
  res.json({ success: true, message: "Transfer account removed", data: null });
}));

businessRouter.post("/payment-account/provision", asyncRoute(async (req, res) => {
  const { bankCode, accountNumber, preferredBank, bvn } = req.body;
  if (!/^\d{10}$/.test(String(accountNumber ?? ""))) throw new HttpError(400, "Enter a valid 10-digit settlement account number");
  if (!bankCode) throw new HttpError(400, "Choose the settlement bank");
  const testMode = env.paystackSecretKey.startsWith("sk_test_");
  if (testMode && (bankCode !== "057" || accountNumber !== "0000000000")) throw new HttpError(400, "In test mode use Zenith Bank (057) and account number 0000000000");
  const businesses = await query<Record<string, any>>("SELECT * FROM businesses WHERE id=$1", [req.auth!.businessId]); const business = businesses[0];
  if (!business || !business.phone || !business.country_code) throw new HttpError(409, "Complete your business phone and country before setting up payments");
  if (!business.email) throw new HttpError(409, "Add a business contact email in Settings before activating Paystack.");
  if (!['NG','GH'].includes(business.country_code)) throw new HttpError(409, "Paystack dedicated accounts currently support Nigerian and Ghanaian businesses");
  const existing = await query<Record<string, any>>("SELECT * FROM business_payment_accounts WHERE business_id=$1", [business.id]);
  if (existing[0]?.status === "active") throw new HttpError(409, "Payment account is already active");
  if (existing[0]?.status === "pending" && existing[0].provider_subaccount_code) {
    const [fallback] = await query<Record<string, unknown>>(
      `UPDATE business_payment_accounts SET status='active',failure_reason=COALESCE(failure_reason,'Paystack checkout is active; Dedicated NUBAN approval is pending or unavailable.'),updated_at=now() WHERE business_id=$1 RETURNING *`, [business.id],
    );
    return res.json({ success: true, message: "Paystack checkout and split settlement are active. Dedicated NUBAN requires Paystack enablement.", data: fallback });
  }
  const resolution = testMode ? { data: { bank_name: "Zenith Bank", account_name: "PAYSTACK TEST ACCOUNT" } } : await paystack(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
  const sub = await paystack("/subaccount", { method: "POST", body: JSON.stringify({ business_name: business.name, settlement_bank: bankCode, account_number: accountNumber, percentage_charge: env.paystackPlatformFeePercent, primary_contact_email: business.email, primary_contact_phone: business.phone, description: `LemonBooks merchant ${business.tenant_slug}`, metadata: JSON.stringify({ businessId: business.id, tenantSlug: business.tenant_slug }) }) });
  const names = String(business.name).trim().split(/\s+/); const firstName = names.shift()!; const lastName = names.join(" ") || "Business";
  const customer = await paystack("/customer", { method: "POST", body: JSON.stringify({ email: business.email, first_name: firstName, last_name: lastName, phone: business.phone, metadata: { businessId: business.id, role: "lemonbooks_merchant" } }) });
  const [account] = await query<Record<string, unknown>>(
    `INSERT INTO business_payment_accounts (business_id,status,settlement_bank_code,settlement_bank_name,settlement_account_number,
     settlement_account_name,platform_fee_percent,provider_subaccount_code,provider_customer_code,currency,provider_payload)
     VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (business_id) DO UPDATE SET status='pending',settlement_bank_code=EXCLUDED.settlement_bank_code,
     settlement_bank_name=EXCLUDED.settlement_bank_name,settlement_account_number=EXCLUDED.settlement_account_number,
     settlement_account_name=EXCLUDED.settlement_account_name,platform_fee_percent=EXCLUDED.platform_fee_percent,
     provider_subaccount_code=EXCLUDED.provider_subaccount_code,provider_customer_code=EXCLUDED.provider_customer_code,
     provider_payload=EXCLUDED.provider_payload,failure_reason=NULL,updated_at=now() RETURNING *`,
    [business.id, bankCode, resolution.data.bank_name ?? null, accountNumber, resolution.data.account_name, env.paystackPlatformFeePercent, sub.data.subaccount_code, customer.data.customer_code, business.currency ?? "NGN", JSON.stringify({ subaccount: sub.data, customer: customer.data })],
  );
  const dvaPayload: Record<string, unknown> = { customer: customer.data.customer_code, preferred_bank: preferredBank || (env.nodeEnv === "production" ? "titan-paystack" : "test-bank"), subaccount: sub.data.subaccount_code, first_name: firstName, last_name: lastName, phone: business.phone };
  if (bvn) Object.assign(dvaPayload, { bvn, account_number: accountNumber, bank_code: bankCode });
  let dva: Awaited<ReturnType<typeof paystack>>;
  try { dva = await paystack("/dedicated_account", { method: "POST", body: JSON.stringify(dvaPayload) }); }
  catch (reason) {
    const message = reason instanceof Error ? reason.message : "Dedicated virtual account is unavailable";
    const [fallback] = await query<Record<string, unknown>>(
      `UPDATE business_payment_accounts SET status='active',failure_reason=$2,updated_at=now() WHERE business_id=$1 RETURNING *`,
      [business.id, `Paystack checkout and split settlement are active. Virtual account unavailable: ${message}`],
    );
    return res.status(201).json({ success: true, message: "Paystack checkout and business settlement are active, but Dedicated NUBAN is not enabled for this Paystack integration", data: fallback });
  }
  if (dva.data?.account_number) await query(`UPDATE business_payment_accounts SET status='active',provider_dva_id=$2,virtual_bank_name=$3,virtual_bank_slug=$4,virtual_account_number=$5,virtual_account_name=$6,currency=$7,provider_payload=provider_payload || $8::jsonb,updated_at=now() WHERE business_id=$1`, [business.id, String(dva.data.id), dva.data.bank?.name, dva.data.bank?.slug, dva.data.account_number, dva.data.account_name, dva.data.currency ?? "NGN", JSON.stringify({ dedicatedAccount: dva.data })]);
  return res.status(201).json({ success: true, message: dva.data?.account_number ? "Business payment account activated" : "Paystack is assigning the business payment account", data: { ...account, ...(dva.data?.account_number ? { status: "active", virtual_bank_name: dva.data.bank?.name, virtual_account_number: dva.data.account_number, virtual_account_name: dva.data.account_name } : {}) } });
}));

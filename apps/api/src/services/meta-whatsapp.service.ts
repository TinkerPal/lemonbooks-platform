import crypto from "node:crypto";
import { env } from "../config";
import { HttpError } from "../http";

type MetaError = { error?: { message?: string; code?: number; error_subcode?: number } };
export type MetaCredentials = { accessToken: string; tokenType?: string; expiresAt?: string | null };

function configured() {
  if (!env.whatsapp.appId || !env.whatsapp.appSecret || !env.whatsapp.configId)
    throw new HttpError(503, "Meta Embedded Signup is not configured");
}

function encryptionKey() {
  if (!env.whatsapp.credentialsKey) throw new HttpError(503, "Integration credential encryption is not configured");
  const decoded = Buffer.from(env.whatsapp.credentialsKey, "base64");
  if (decoded.length !== 32) throw new HttpError(503, "INTEGRATION_CREDENTIALS_KEY must be a 32-byte base64 value");
  return decoded;
}

export function encryptMetaCredentials(value: MetaCredentials) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptMetaCredentials(value: string): MetaCredentials {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new HttpError(503, "Stored Meta credentials are invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8"));
}

async function graph<T>(path: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://graph.facebook.com/${env.whatsapp.graphVersion}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as T & MetaError;
  if (!response.ok || body.error) throw new HttpError(502, body.error?.message ?? "Meta Graph API request failed", "META_GRAPH_ERROR");
  return body;
}

export function embeddedSignupConfiguration() {
  configured();
  return { appId: env.whatsapp.appId, configId: env.whatsapp.configId, graphVersion: env.whatsapp.graphVersion };
}

export async function exchangeEmbeddedSignupCode(code: string): Promise<MetaCredentials> {
  configured();
  const parameters = new URLSearchParams({ client_id: env.whatsapp.appId, client_secret: env.whatsapp.appSecret, code });
  const response = await fetch(`https://graph.facebook.com/${env.whatsapp.graphVersion}/oauth/access_token?${parameters}`, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json() as { access_token?: string; token_type?: string; expires_in?: number } & MetaError;
  if (!response.ok || !body.access_token) throw new HttpError(502, body.error?.message ?? "Meta authorization code exchange failed", "META_OAUTH_ERROR");
  return { accessToken: body.access_token, tokenType: body.token_type, expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null };
}

export async function verifyWhatsAppAssets(accessToken: string, wabaId: string, phoneNumberId: string) {
  const [waba, phones] = await Promise.all([
    graph<{ id: string; name?: string; currency?: string; timezone_id?: string }>(`${wabaId}?fields=id,name,currency,timezone_id`, accessToken),
    graph<{ data: Array<{ id: string; display_phone_number?: string; verified_name?: string; quality_rating?: string; platform_type?: string }> }>(`${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,platform_type`, accessToken),
  ]);
  const phone = phones.data.find((row) => row.id === phoneNumberId);
  if (!phone) throw new HttpError(409, "The selected phone number does not belong to the authorized WhatsApp Business Account");
  return { waba, phone };
}

export async function subscribeWaba(accessToken: string, wabaId: string) {
  return graph<{ success: boolean }>(`${wabaId}/subscribed_apps`, accessToken, { method: "POST", body: "{}" });
}

export async function fetchTemplates(accessToken: string, wabaId: string) {
  return graph<{ data: Array<{ id?: string; name: string; language: string; category: string; status: string; components?: Array<{ type: string; text?: string }> }> }>(`${wabaId}/message_templates?limit=250`, accessToken);
}

export async function sendMetaMessage(input: { accessToken: string; phoneNumberId: string; to: string; body: string; templateName?: string | null; language?: string }) {
  const payload = input.templateName
    ? { messaging_product: "whatsapp", recipient_type: "individual", to: input.to.replace(/\D/g, ""), type: "template", template: { name: input.templateName, language: { code: input.language ?? "en" } } }
    : { messaging_product: "whatsapp", recipient_type: "individual", to: input.to.replace(/\D/g, ""), type: "text", text: { preview_url: false, body: input.body } };
  const result = await graph<{ messages: Array<{ id: string }>}>(`${input.phoneNumberId}/messages`, input.accessToken, { method: "POST", body: JSON.stringify(payload) });
  if (!result.messages[0]?.id) throw new HttpError(502, "Meta accepted no WhatsApp message");
  return result.messages[0].id;
}

export async function downloadMetaMedia(input: { accessToken: string; mediaId: string }) {
  const metadata = await graph<{ url?: string; mime_type?: string; file_size?: number }>(input.mediaId, input.accessToken);
  if (!metadata.url) throw new HttpError(502, "Meta did not return an audio URL", "META_MEDIA_URL_MISSING");
  const response = await fetch(metadata.url, { headers: { Authorization: `Bearer ${input.accessToken}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new HttpError(502, "Could not download the WhatsApp audio", "META_MEDIA_DOWNLOAD_FAILED");
  const contentType = metadata.mime_type ?? response.headers.get("content-type") ?? "audio/ogg";
  if (!contentType.toLowerCase().startsWith("audio/")) throw new HttpError(415, "WhatsApp media is not an audio file", "UNSUPPORTED_AUDIO_TYPE");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > 16 * 1024 * 1024) throw new HttpError(413, "Audio messages must be 16 MB or smaller", "AUDIO_TOO_LARGE");
  return { bytes, mimeType: contentType };
}

import { env } from "../config";
import { query, transaction } from "../database/pool";
import { extractBusinessSignals } from "./whatsapp.service";
import { decryptMetaCredentials, downloadMetaMedia, sendMetaMessage } from "./meta-whatsapp.service";
import { linkedPlatformReply } from "./whatsapp-platform.service";

type Extraction = {
  intent: "order" | "payment" | "expense" | "inventory" | "invoice" | "other";
  summary: string; customer?: string; invoiceReference?: string; amount?: number; currency?: string;
  items?: Array<{ name: string; quantity?: number; unit?: string }>; confidence: number;
};

function fallbackExtraction(transcript: string): Extraction {
  const signals = extractBusinessSignals(transcript);
  const lower = transcript.toLowerCase();
  const intent: Extraction["intent"] = signals.paymentIntent ? "payment" : /invoice/.test(lower) ? "invoice" : /stock|inventory|restock/.test(lower) ? "inventory" : /order|sale|buy/.test(lower) ? "order" : "other";
  return { intent, summary: transcript.slice(0, 500), invoiceReference: signals.invoiceReference, amount: signals.amount, confidence: 0.35 };
}

export async function transcribeAndExtract(bytes: Buffer, mimeType: string): Promise<{ transcript: string; extraction: Extraction }> {
  if (!env.openai.apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), "whatsapp-audio");
  form.append("model", "whisper-1");
  form.append("response_format", "json");
  const transcriptionResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${env.openai.apiKey}` }, body: form, signal: AbortSignal.timeout(90_000),
  });
  const transcription = await transcriptionResponse.json() as { text?: string; error?: { message?: string } };
  if (!transcriptionResponse.ok || !transcription.text?.trim()) throw new Error(transcription.error?.message ?? "Audio transcription failed");
  const transcript = transcription.text.trim();
  const extractionResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${env.openai.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.openai.model, temperature: 0, response_format: { type: "json_object" },
      messages: [{ role: "system", content: "Extract a LemonBooks business request from a transcript. Return only JSON with intent (order|payment|expense|inventory|invoice|other), summary, optional customer, invoiceReference, amount, currency, items [{name,quantity,unit}], confidence (0 to 1). Never claim payment is confirmed." }, { role: "user", content: transcript }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const completion = await extractionResponse.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!extractionResponse.ok || !completion.choices?.[0]?.message?.content) return { transcript, extraction: fallbackExtraction(transcript) };
  try { return { transcript, extraction: { ...fallbackExtraction(transcript), ...JSON.parse(completion.choices[0].message.content) } }; }
  catch { return { transcript, extraction: fallbackExtraction(transcript) }; }
}

export async function processWhatsAppAudioJobs(limit = 3) {
  const jobs = await transaction(async client => (await client.query<Record<string, any>>(`WITH claimed AS (
    SELECT id FROM whatsapp_media_jobs WHERE status IN ('queued','failed') AND available_at<=now() AND attempts<5
    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
    UPDATE whatsapp_media_jobs j SET status='processing',attempts=attempts+1,updated_at=now() FROM claimed
    WHERE j.id=claimed.id RETURNING j.*`, [limit])).rows);
  for (const job of jobs) {
    try {
      const connection = (await query<Record<string, any>>("SELECT * FROM integration_connections WHERE id=$1 AND status='active' AND deleted_at IS NULL", [job.connection_id]))[0];
      if (!connection) throw new Error("WhatsApp connection is unavailable");
      const credentials = decryptMetaCredentials(connection.encrypted_credentials);
      const media = await downloadMetaMedia({ accessToken: credentials.accessToken, mediaId: job.provider_media_id });
      const result = await transcribeAndExtract(media.bytes, media.mimeType);
      const contact = (await query<Record<string, any>>(`SELECT c.phone_e164,c.consent_state FROM whatsapp_contacts c JOIN whatsapp_conversations v ON v.contact_id=c.id WHERE v.id=$1`, [job.conversation_id]))[0];
      await transaction(async client => {
        await client.query("UPDATE whatsapp_media_jobs SET status='completed',transcript=$2,extraction=$3,error=NULL,updated_at=now() WHERE id=$1", [job.id, result.transcript, JSON.stringify(result.extraction)]);
        await client.query("UPDATE whatsapp_messages SET body=$2 WHERE id=$1", [job.message_id, `🎙️ ${result.transcript}`]);
      });
      if (contact?.consent_state === "opted_in" && connection.capabilities?.platformEntryPoint === true) {
        const reply = await linkedPlatformReply({ body: result.transcript, contactId: (await query<{ contact_id:string }>("SELECT contact_id FROM whatsapp_conversations WHERE id=$1", [job.conversation_id]))[0]!.contact_id, conversationId: job.conversation_id, publicWebUrl: env.publicWebUrl });
        const summary = `I received your voice note and transcribed it:\n“${result.transcript.slice(0, 600)}”\n\nDraft extracted (${result.extraction.intent}, ${Math.round(Number(result.extraction.confidence ?? 0) * 100)}% confidence): ${result.extraction.summary}\n\nNothing has been posted. Reply CONFIRM after reviewing the details, or send a correction.`;
        const body = reply && /welcome|register|connect/i.test(reply) ? reply : summary;
        const providerId = await sendMetaMessage({ accessToken: credentials.accessToken, phoneNumberId: String(connection.external_account_id), to: contact.phone_e164, body });
        await query(`INSERT INTO whatsapp_messages(business_id,conversation_id,provider_message_id,direction,message_type,body,provider_status,occurred_at)
          VALUES($1,$2,$3,'outbound','text',$4,'accepted',now()) ON CONFLICT(business_id,provider_message_id) DO NOTHING`, [job.business_id, job.conversation_id, providerId, body]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "AUDIO_PROCESSING_FAILED";
      await query(`UPDATE whatsapp_media_jobs SET status=CASE WHEN attempts>=5 THEN 'dead_letter' ELSE 'failed' END,
        error=$2,available_at=now()+interval '1 minute'*LEAST(attempts,5),updated_at=now() WHERE id=$1`, [job.id, message.slice(0, 500)]);
      console.error(`WhatsApp audio job ${job.id} failed: ${message}`);
    }
  }
  return jobs.length;
}

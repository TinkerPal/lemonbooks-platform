import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 5000),
  databaseUrl: required("DATABASE_URL", "postgresql://lemonbooks:lemonbooks@127.0.0.1:5436/lemonbooks"),
  jwtSecret: required("JWT_SECRET", "local-only-change-before-production"),
  clientUrls: (process.env.CLIENT_URL ?? "http://localhost:5173,http://localhost:5174")
    .split(",").map((url) => url.trim()).filter(Boolean),
  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES ?? 10),
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY?.trim() ?? "",
  paystackPlatformFeePercent: Math.max(0, Math.min(100, Number(process.env.PAYSTACK_PLATFORM_FEE_PERCENT ?? 0))),
  paystackCallbackUrl: process.env.PAYSTACK_CALLBACK_URL?.trim() ?? `${(process.env.CLIENT_URL ?? "http://localhost:5173").split(",")[0]!.trim()}/payments/paystack/callback`,
  publicWebUrl: process.env.PUBLIC_WEB_URL?.trim() ?? (process.env.CLIENT_URL ?? "http://localhost:5173").split(",")[0]!.trim(),
  publicApiUrl: process.env.PUBLIC_API_URL?.trim() ?? `http://localhost:${Number(process.env.PORT ?? 5000)}`,
  openai: {
    apiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
    model: process.env.OPENAI_EXTRACTION_MODEL?.trim() ?? "gpt-4o-mini",
  },
  whatsapp: {
    appId: process.env.META_APP_ID?.trim() ?? "",
    appSecret: process.env.WHATSAPP_APP_SECRET?.trim() ?? process.env.META_APP_SECRET?.trim() ?? "",
    configId: process.env.META_WHATSAPP_CONFIG_ID?.trim() ?? "",
    graphVersion: process.env.META_GRAPH_API_VERSION?.trim() ?? "v23.0",
    verifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim() ?? "",
    credentialsKey: process.env.INTEGRATION_CREDENTIALS_KEY?.trim() ?? "",
    platformTenantSlug: process.env.WHATSAPP_PLATFORM_TENANT_SLUG?.trim() ?? "",
    platformWabaId: process.env.WHATSAPP_PLATFORM_WABA_ID?.trim() ?? "",
    platformPhoneNumberId: process.env.WHATSAPP_PLATFORM_PHONE_NUMBER_ID?.trim() ?? "",
    platformAccessToken: process.env.WHATSAPP_PLATFORM_ACCESS_TOKEN?.trim() ?? "",
  },
  smtp: {
    host: process.env.SMTP_HOST?.trim() ?? "",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER?.trim() ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim() || "invoices@lemonbooks.app",
  },
};

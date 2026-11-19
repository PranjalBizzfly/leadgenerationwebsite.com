/**
 * Sends one lead to a Salesforge inbound webhook in the Salesforge standard format.
 * Used by every form through sendLeadToSalesforge(formId, submitted, context). It never throws.
 *
 * Retries are held in memory: a restart or deploy while a lead is waiting to be retried loses that retry.
 * On serverless hosts the whole retry window (~36 s of waits plus up to 10 s per try) can exceed the
 * function's time limit; the route raises its limit (maxDuration) to cover it. A job queue would be better.
 *
 * A lead that ends NOT delivered is logged in full on one line so it can be resent with
 * `npm run salesforge:test-lead -- --resend <file>`. That line holds the visitor's personal data:
 * keep access to the server logs restricted. Delivered leads are never logged with their body.
 */
import { createHmac, randomUUID } from "node:crypto";
import { SALESFORGE_FORMS, type LeadKey, type SalesforgeForm } from "./forms.ts";
import { getSalesforgeSettings, type ListenerSettings, type SalesforgeSettings } from "./settings.ts";

export interface LeadContext {
  page?: { url?: string; title?: string };
  utm?: Partial<Record<"source" | "medium" | "campaign" | "term" | "content", string>>;
}

export interface SendResult {
  delivered: boolean;
  status: number | null;
  body: string | null;
  webhookId: string | null;
  formId: string;
  /** The listener actually used: "default", a route name, or null when none was configured. */
  listener: string | null;
  /** True when the form's route had no URL and the default listener was used instead. */
  fallback: boolean;
}

type Logger = Pick<Console, "info" | "warn" | "error">;
type Env = Record<string, string | undefined>;

export interface SendOptions {
  /** Retries after the first try (default 3). */
  retries?: number;
  timeoutMs?: number;
  delaysMs?: number[];
  fetch?: typeof fetch;
  settings?: SalesforgeSettings;
  env?: Env;
  logger?: Logger;
  forms?: Record<string, SalesforgeForm>;
  /** Send this body unchanged (used to resend a NOT delivered lead). */
  resendBody?: Record<string, unknown>;
}

const LEAD_KEYS: LeadKey[] = ["name", "first_name", "last_name", "phone", "email", "city", "state", "pincode", "language", "notes"];
const RESERVED = new Set<string>([...LEAD_KEYS, "product", "external_id", "form", "page", "utm"]);
const SECRET_FIELD = /pass(word)?|card|cvv|cvc|otp|token|secret|pin$|file|upload/i;
const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;
const DEFAULT_DELAYS = [1_000, 5_000, 30_000];

const warned = new Set<string>();
function warnOnce(logger: Logger, key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}

const text = (v: unknown, max = 200) => (typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, max) : "");

/** International form when possible; otherwise as typed. */
export function normalisePhone(raw: string, countryCode?: string): string {
  const typed = raw.trim();
  const p = typed.replace(/[\s\-.()]/g, "");
  if (!p) return "";
  if (p.startsWith("+")) return p;
  if (p.startsWith("00")) return `+${p.slice(2)}`;
  if (!countryCode) return typed;
  const code = countryCode.replace(/\D/g, "");
  const local = p.startsWith("0") ? p.slice(1) : p;
  if (local.startsWith(code) && local.length - code.length >= 8) return `+${local}`;
  return `+${code}${local}`;
}

/** Builds the flat standard body for one form submission. */
export function buildLeadBody(formId: string, form: SalesforgeForm, submitted: Record<string, unknown>, context: LeadContext = {}, countryCode?: string) {
  const body: Record<string, unknown> = {};
  for (const key of LEAD_KEYS) {
    const field = form.fields[key];
    if (!field) continue;
    const value = text(submitted[field], key === "notes" ? 4000 : 200);
    if (!value) continue;
    body[key] = key === "phone" ? normalisePhone(value, countryCode) : value;
  }

  const product = form.product;
  if (product) {
    const value = "fixed" in product ? product.fixed : "field" in product ? text(submitted[product.field]) : text(context.page?.title);
    if (value) body.product = value;
  }

  body.external_id = randomUUID();
  body.form = { id: formId, name: form.name };

  const page = { url: text(context.page?.url, 2000), title: text(context.page?.title, 200) };
  if (page.url || page.title) body.page = Object.fromEntries(Object.entries(page).filter(([, v]) => v));
  const utm = Object.fromEntries(UTM_KEYS.map((k) => [k, text(context.utm?.[k])]).filter(([, v]) => v));
  if (Object.keys(utm).length) body.utm = utm;

  // Only the listed extras, never the raw submission; a clash with a lead key is renamed, secrets are dropped.
  for (const field of form.extras ?? []) {
    if (SECRET_FIELD.test(field)) continue;
    const value = text(submitted[field]);
    if (!value) continue;
    body[RESERVED.has(field) ? `form_${field}` : field] = value;
  }
  return body;
}

/** Picks the listener for a form, by the rules: its route if set, else default, else none. */
function pickListener(form: SalesforgeForm, settings: SalesforgeSettings, formId: string, logger: Logger) {
  if (form.route) {
    const route = settings.listeners[form.route];
    if (route?.url) return { name: form.route, listener: route, fallback: false };
    warnOnce(logger, `route:${form.route}`, `[salesforge] SALESFORGE_INBOUND_URL_${form.route} is not set; form "${formId}" falls back to the default listener`);
  }
  const def = settings.listeners.default;
  if (def?.url) return { name: "default", listener: def, fallback: Boolean(form.route) };
  return null;
}

/** Standard Webhooks signature, signed by hand with HMAC-SHA256 over `{id}.{timestamp}.{body}`. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string) {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function headersFor(listener: ListenerSettings, webhookId: string, body: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", "webhook-id": webhookId };
  if (listener.secret) {
    const ts = Math.floor(Date.now() / 1000);
    headers["webhook-timestamp"] = String(ts);
    headers["webhook-signature"] = signWebhook(listener.secret, webhookId, ts, body);
  } else if (listener.token) {
    headers.authorization = `Bearer ${listener.token}`;
  }
  return headers;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 408 || status === 429 || status >= 500;

export async function sendLeadToSalesforge(formId: string, submitted: Record<string, unknown>, context: LeadContext = {}, options: SendOptions = {}): Promise<SendResult> {
  const logger = options.logger ?? console;
  const forms = options.forms ?? SALESFORGE_FORMS;
  const result: SendResult = { delivered: false, status: null, body: null, webhookId: null, formId, listener: null, fallback: false };
  try {
    const form = forms[formId];
    if (!form) {
      logger.error(`[salesforge] Unknown form id "${formId}"; nothing sent`);
      return result;
    }
    const routes = [...new Set(Object.values(forms).map((f) => f.route).filter((r): r is string => Boolean(r)))];
    const settings = options.settings ?? getSalesforgeSettings(options.env ?? process.env, routes);

    const lead = options.resendBody ?? buildLeadBody(formId, form, submitted, context, settings.countryCode);
    const webhookId = `lead_${String(lead.external_id)}`;
    result.webhookId = webhookId;
    const payload = JSON.stringify(lead);
    if (!lead.phone) logger.warn(`[salesforge] Lead ${webhookId} from "${formId}" has no phone; Salesforge will put it in "needs review"`);

    const picked = pickListener(form, settings, formId, logger);
    if (!picked) {
      warnOnce(logger, "no-listener", "[salesforge] SALESFORGE_INBOUND_URL is not set; leads are not delivered (logged in full instead)");
      logger.error(`Salesforge lead NOT delivered ${JSON.stringify({ formId, listener: null, status: null, webhookId, body: lead })}`);
      return result;
    }
    result.listener = picked.name;
    result.fallback = picked.fallback;

    const doFetch = options.fetch ?? fetch;
    const delays = options.delaysMs ?? DEFAULT_DELAYS;
    const retries = options.retries ?? 3;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);
      let status: number | null = null;
      let answer: string | null = null;
      try {
        // Re-signed on every try with a fresh timestamp; the webhook-id stays the same.
        const res = await doFetch(picked.listener.url!, {
          method: "POST",
          headers: headersFor(picked.listener, webhookId, payload),
          body: payload,
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
        status = res.status;
        answer = await res.text().catch(() => "");
      } catch {
        // Network error or timeout: retried below.
      }
      result.status = status;
      result.body = answer;

      if (status !== null && (status === 409 || (status >= 200 && status < 300))) {
        result.delivered = true;
        let kind = "";
        try {
          kind = String(JSON.parse(answer ?? "")?.status ?? "");
        } catch {}
        if (status === 202 && kind === "test") logger.info(`[salesforge] ${webhookId} received in test mode`);
        if (status === 202 && kind === "needs_review") logger.warn(`[salesforge] ${webhookId} received but needs review (name or phone missing)`);
        return result;
      }
      if (status !== null && !retryable(status)) break;
    }

    logger.error(`Salesforge lead NOT delivered ${JSON.stringify({ formId, listener: result.listener, status: result.status, webhookId, body: lead })}`);
    return result;
  } catch (err) {
    logger.error(`[salesforge] Unexpected error sending a "${formId}" lead`, err instanceof Error ? err.message : err);
    return result;
  }
}

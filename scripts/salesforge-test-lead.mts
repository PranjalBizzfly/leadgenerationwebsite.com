// Sends test leads to Salesforge through the same sender and forms list the site uses (no retries).
// Usage:
//   npm run salesforge:test-lead -- --form contact
//   npm run salesforge:test-lead -- --all
//   npm run salesforge:test-lead -- --resend not-delivered.txt   (one "NOT delivered" log line, or just its JSON)
// Reads SALESFORGE_* from the environment (.env.local / .env are loaded by the npm script when present).
// Exit code 0 when every lead sent was delivered, else 1.
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { SALESFORGE_FORMS, type SalesforgeForm } from "../src/lib/salesforge/forms.ts";
import { sendLeadToSalesforge, type SendResult } from "../src/lib/salesforge/sender.ts";
import { getSalesforgeSettings } from "../src/lib/salesforge/settings.ts";

const SITE = "LeadGen AI";
const args = process.argv.slice(2);
const arg = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

/** A new phone number every run, so a second run is not a 409 duplicate. */
function testPhone() {
  const digits = Array.from({ length: 10 }, (_, i) => (i === 0 ? randomInt(6, 10) : randomInt(0, 10))).join("");
  const code = getSalesforgeSettings().countryCode;
  return code ? `${code}${digits}` : digits;
}

function testValues(formId: string, form: SalesforgeForm) {
  const v: Record<string, string> = {};
  const f = form.fields;
  if (f.name) v[f.name] = `Test Lead (${formId})`;
  if (f.first_name) v[f.first_name] = "Test";
  if (f.last_name) v[f.last_name] = `Lead (${formId})`;
  if (f.phone) v[f.phone] = testPhone();
  if (f.email) v[f.email] = "test.lead@example.com";
  if (f.notes) v[f.notes] = `Test from ${SITE}`;
  if (form.product && "field" in form.product) v[form.product.field] = form.product.options[0];
  for (const extra of form.extras ?? []) v[extra] ??= `Sample ${extra}`;
  return v;
}

const line = (r: SendResult) => `${r.formId} · ${r.listener ?? "no listener"} · ${r.status ?? "no answer"} · ${r.body ?? ""}`;
const once = { retries: 0 };

let results: SendResult[] = [];
const resendFile = arg("--resend");
const formId = arg("--form");

if (resendFile) {
  const raw = readFileSync(resendFile, "utf8").trim();
  const json = JSON.parse(raw.slice(raw.indexOf("{")));
  const body = json.body ?? json;
  const id = body?.form?.id ?? json.formId;
  if (!SALESFORGE_FORMS[id]) throw new Error(`Unknown form id in the resend file: ${id}`);
  results = [await sendLeadToSalesforge(id, {}, {}, { ...once, resendBody: body })];
} else if (formId) {
  const form = SALESFORGE_FORMS[formId];
  if (!form) throw new Error(`Unknown form id: ${formId}. Known: ${Object.keys(SALESFORGE_FORMS).join(", ")}`);
  results = [await sendLeadToSalesforge(formId, testValues(formId, form), { page: { url: "https://leadgen-ai.test/test-lead", title: "Test lead" } }, once)];
} else if (args.includes("--all")) {
  for (const [id, form] of Object.entries(SALESFORGE_FORMS)) {
    results.push(await sendLeadToSalesforge(id, testValues(id, form), { page: { url: "https://leadgen-ai.test/test-lead", title: "Test lead" } }, once));
  }
} else {
  console.log("Usage: --form <id> | --all | --resend <file>");
  process.exit(1);
}

for (const r of results) console.log(line(r));
process.exit(results.every((r) => r.delivered) ? 0 : 1);

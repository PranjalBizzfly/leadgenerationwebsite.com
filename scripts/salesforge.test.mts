// Tests for the Salesforge lead sender. Run: npm run test:salesforge
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { SALESFORGE_FORMS, type SalesforgeForm } from "../src/lib/salesforge/forms.ts";
import { normalisePhone, sendLeadToSalesforge, type SendOptions } from "../src/lib/salesforge/sender.ts";
import { getSalesforgeSettings } from "../src/lib/salesforge/settings.ts";

const SECRET = `whsec_${Buffer.from("default-secret-0123456789").toString("base64")}`;
const ROUTE_SECRET = `whsec_${Buffer.from("visits-secret-9876543210").toString("base64")}`;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A mocked fetch that answers with the given statuses in turn (the last one repeats) and records calls. */
function mockFetch(statuses: number[] = [201], answer = "{}") {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    if (status === 0) throw new TypeError("network down");
    return new Response(answer, { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function quietLogger() {
  const lines: string[] = [];
  const log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  return { logger: { info: log, warn: log, error: log }, lines };
}

const fast = (extra: SendOptions = {}): SendOptions => ({ delaysMs: [1, 1, 1], timeoutMs: 500, ...quietLogger(), ...extra });

function verify(secret: string, call: Call) {
  const key = Buffer.from(secret.slice(6), "base64");
  const expected = createHmac("sha256", key).update(`${call.headers["webhook-id"]}.${call.headers["webhook-timestamp"]}.${call.body}`).digest("base64");
  return call.headers["webhook-signature"] === `v1,${expected}`;
}

/** A submission that uses a form's own field names. */
function submissionFor(form: SalesforgeForm) {
  const v: Record<string, string> = { unlisted_field: "must not be sent" };
  for (const [, field] of Object.entries(form.fields)) v[field!] = `value of ${field}`;
  if (form.fields.phone) v[form.fields.phone] = "+919876543210";
  if (form.product && "field" in form.product) v[form.product.field] = form.product.options[1];
  for (const e of form.extras ?? []) v[e] = `extra ${e}`;
  return v;
}

const env = { SALESFORGE_INBOUND_URL: "https://sf.test/default", SALESFORGE_INBOUND_SECRET: SECRET };

describe("forms list", () => {
  for (const [id, form] of Object.entries(SALESFORGE_FORMS)) {
    test(`${id}: builds the standard body and calls its listener once`, async () => {
      const { fn, calls } = mockFetch();
      const r = await sendLeadToSalesforge(id, submissionFor(form), { page: { url: "https://site.test/x", title: "X" }, utm: { source: "google" } }, fast({ fetch: fn, env }));
      assert.equal(r.delivered, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://sf.test/default");
      const body = JSON.parse(calls[0].body);
      assert.equal(body.form.id, id);
      assert.equal(body.form.name, form.name);
      assert.equal(body.name, `value of ${form.fields.name}`);
      assert.equal(body.phone, "+919876543210");
      assert.match(body.external_id, /^[0-9a-f-]{36}$/);
      assert.equal(calls[0].headers["webhook-id"], `lead_${body.external_id}`);
      for (const e of form.extras ?? []) assert.equal(body[e], `extra ${e}`);
      assert.equal(body.unlisted_field, undefined);
      assert.deepEqual(body.page, { url: "https://site.test/x", title: "X" });
      assert.deepEqual(body.utm, { source: "google" });
    });
  }
});

describe("product", () => {
  test("a field product takes the visitor's choice", async () => {
    const { fn, calls } = mockFetch();
    await sendLeadToSalesforge("request-access", { name: "A", phone: "+911234567890", source: "LinkedIn" }, {}, fast({ fetch: fn, env }));
    assert.equal(JSON.parse(calls[0].body).product, "LinkedIn");
  });

  test("a fixed product is sent as is", async () => {
    const { fn, calls } = mockFetch();
    const forms = { visit: { name: "Visit", fields: { name: "n", phone: "p" }, product: { fixed: "Campus Visit" } } };
    await sendLeadToSalesforge("visit", { n: "A", p: "+911234567890" }, {}, fast({ fetch: fn, env, forms }));
    assert.equal(JSON.parse(calls[0].body).product, "Campus Visit");
  });
});

describe("routes and listeners", () => {
  const forms = { visit: { name: "Visit", fields: { name: "n", phone: "p" }, route: "VISITS" } };

  test("a routed form uses that route's URL and secret", async () => {
    const { fn, calls } = mockFetch();
    const r = await sendLeadToSalesforge("visit", { n: "A", p: "+911234567890" }, {}, fast({ fetch: fn, forms, env: { ...env, SALESFORGE_INBOUND_URL_VISITS: "https://sf.test/visits", SALESFORGE_INBOUND_SECRET_VISITS: ROUTE_SECRET } }));
    assert.equal(r.listener, "VISITS");
    assert.equal(calls[0].url, "https://sf.test/visits");
    assert.ok(verify(ROUTE_SECRET, calls[0]), "verifies with the route secret");
    assert.ok(!verify(SECRET, calls[0]), "not with the default secret");
  });

  test("a route with no URL falls back to default and warns", async () => {
    const { fn, calls } = mockFetch();
    const q = quietLogger();
    const r = await sendLeadToSalesforge("visit", { n: "A", p: "+911234567890" }, {}, { ...fast({ fetch: fn, env, forms }), logger: q.logger });
    assert.equal(r.fallback, true);
    assert.equal(r.listener, "default");
    assert.equal(calls[0].url, "https://sf.test/default");
    assert.ok(q.lines.some((l) => l.includes("SALESFORGE_INBOUND_URL_VISITS")));
  });

  test("with no URL at all the lead is logged as NOT delivered", async () => {
    const { fn, calls } = mockFetch();
    const q = quietLogger();
    const r = await sendLeadToSalesforge("contact", { name: "A", phone: "+911234567890" }, {}, { ...fast({ fetch: fn, env: {} }), logger: q.logger });
    assert.equal(r.delivered, false);
    assert.equal(r.listener, null);
    assert.equal(calls.length, 0);
    assert.ok(q.lines.some((l) => l.startsWith("Salesforge lead NOT delivered ") && l.includes('"formId":"contact"')));
  });
});

describe("body rules", () => {
  test("an extra named like a lead key is sent as form_<name>", async () => {
    const { fn, calls } = mockFetch();
    const forms = { f: { name: "F", fields: { name: "n", phone: "p" }, extras: ["email"] } };
    await sendLeadToSalesforge("f", { n: "A", p: "+911234567890", email: "x@y.z" }, {}, fast({ fetch: fn, env, forms }));
    const body = JSON.parse(calls[0].body);
    assert.equal(body.form_email, "x@y.z");
    assert.equal(body.email, undefined);
  });

  test("an unknown (skipped) form sends nothing", async () => {
    const { fn, calls } = mockFetch();
    const r = await sendLeadToSalesforge("newsletter", { email: "x@y.z" }, {}, fast({ fetch: fn, env }));
    assert.equal(r.delivered, false);
    assert.equal(calls.length, 0);
  });
});

describe("auth", () => {
  test("with a secret: signature headers are present and verify against the exact body", async () => {
    const { fn, calls } = mockFetch();
    await sendLeadToSalesforge("contact", { name: "A", phone: "+911234567890" }, {}, fast({ fetch: fn, env }));
    const h = calls[0].headers;
    assert.ok(h["webhook-id"] && h["webhook-timestamp"] && h["webhook-signature"]);
    assert.ok(verify(SECRET, calls[0]));
    assert.equal(h.authorization, undefined);
  });

  test("with only a token: Bearer and webhook-id are sent", async () => {
    const { fn, calls } = mockFetch();
    await sendLeadToSalesforge("contact", { name: "A", phone: "+911234567890" }, {}, fast({ fetch: fn, env: { SALESFORGE_INBOUND_URL: "https://sf.test/default", SALESFORGE_INBOUND_TOKEN: "tok_123" } }));
    assert.equal(calls[0].headers.authorization, "Bearer tok_123");
    assert.ok(calls[0].headers["webhook-id"]);
    assert.equal(calls[0].headers["webhook-signature"], undefined);
  });
});

describe("answers and retries", () => {
  test("a 5xx is retried with the same webhook-id", async () => {
    const { fn, calls } = mockFetch([503, 500, 201]);
    const r = await sendLeadToSalesforge("contact", { name: "A", phone: "+911234567890" }, {}, fast({ fetch: fn, env }));
    assert.equal(r.delivered, true);
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map((c) => c.headers["webhook-id"])).size, 1);
  });

  test("a 401 is not retried and is logged NOT delivered with the form id and full body", async () => {
    const { fn, calls } = mockFetch([401]);
    const q = quietLogger();
    const r = await sendLeadToSalesforge("contact", { name: "A", phone: "+911234567890", message: "Hello there" }, {}, { ...fast({ fetch: fn, env }), logger: q.logger });
    assert.equal(r.delivered, false);
    assert.equal(calls.length, 1);
    const line = q.lines.find((l) => l.startsWith("Salesforge lead NOT delivered "))!;
    const logged = JSON.parse(line.slice("Salesforge lead NOT delivered ".length));
    assert.equal(logged.formId, "contact");
    assert.equal(logged.status, 401);
    assert.equal(logged.body.notes, "Hello there");
  });

  test("network errors and 5xx are retried up to 3 times, then given up; the sender never throws", async () => {
    const { fn, calls } = mockFetch([0, 500]);
    const r = await sendLeadToSalesforge("contact", { name: "A", phone: "+911234567890" }, {}, fast({ fetch: fn, env }));
    assert.equal(r.delivered, false);
    assert.equal(calls.length, 4);
  });

  test("409 duplicate and 202 test mode count as delivered", async () => {
    for (const [status, answer] of [[409, "{}"], [202, '{"status":"test"}']] as const) {
      const { fn } = mockFetch([status], answer);
      assert.equal((await sendLeadToSalesforge("contact", { name: "A", phone: "+911234567890" }, {}, fast({ fetch: fn, env }))).delivered, true);
    }
  });
});

describe("phone rules", () => {
  test("local numbers get the default country code", () => {
    assert.equal(normalisePhone("098765 43210", "+91"), "+919876543210");
    assert.equal(normalisePhone("0091 98765 43210", "+91"), "+919876543210");
    assert.equal(normalisePhone("919876543210", "+91"), "+919876543210");
    assert.equal(normalisePhone("(98765) 43210", "+91"), "+919876543210");
  });
  test("without a country code a local number is sent as typed", () => {
    assert.equal(normalisePhone("98765 43210"), "98765 43210");
  });
});

describe("settings", () => {
  test("reads the default listener and route listeners from env", () => {
    const s = getSalesforgeSettings({ SALESFORGE_INBOUND_URL: " https://a ", SALESFORGE_INBOUND_URL_VISITS: "https://b", SALESFORGE_DEFAULT_COUNTRY_CODE: "+91" }, ["VISITS"]);
    assert.equal(s.listeners.default.url, "https://a");
    assert.equal(s.listeners.VISITS.url, "https://b");
    assert.equal(s.countryCode, "+91");
  });
});

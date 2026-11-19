/**
 * The one Salesforge settings reader. Every value comes from an environment variable: the site has no
 * admin area or settings store, so there is no settings page (env vars are the only safe place for secrets).
 *
 * Default listener: SALESFORGE_INBOUND_URL, SALESFORGE_INBOUND_SECRET, SALESFORGE_INBOUND_TOKEN.
 * A route <ROUTE> uses the same names with _<ROUTE> on the end. Optional: SALESFORGE_DEFAULT_COUNTRY_CODE.
 */

export interface ListenerSettings {
  url?: string;
  /** Standard Webhooks signing secret (whsec_…). Wins over the token when both are set. */
  secret?: string;
  token?: string;
}

export interface SalesforgeSettings {
  /** "default" plus one entry per route name. */
  listeners: Record<string, ListenerSettings>;
  /** E.g. "+91"; used to complete local phone numbers. */
  countryCode?: string;
}

type Env = Record<string, string | undefined>;

const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

function listener(env: Env, suffix: string): ListenerSettings {
  return {
    url: clean(env[`SALESFORGE_INBOUND_URL${suffix}`]),
    secret: clean(env[`SALESFORGE_INBOUND_SECRET${suffix}`]),
    token: clean(env[`SALESFORGE_INBOUND_TOKEN${suffix}`]),
  };
}

/** Reads the settings in force. Pass `routes` to read the listeners those routes use. */
export function getSalesforgeSettings(env: Env = process.env, routes: string[] = []): SalesforgeSettings {
  const listeners: Record<string, ListenerSettings> = { default: listener(env, "") };
  for (const r of routes) listeners[r] = listener(env, `_${r}`);
  return { listeners, countryCode: clean(env.SALESFORGE_DEFAULT_COUNTRY_CODE) };
}

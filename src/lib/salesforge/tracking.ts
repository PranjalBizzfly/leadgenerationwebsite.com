/**
 * Browser-side page and UTM tracking for leads sent to Salesforge.
 * The utm_* values of the FIRST landing URL in a visit are kept in sessionStorage, so they survive moving
 * between pages before the visitor fills a form. Storage can be unavailable (private mode); then UTM is omitted.
 */
const KEY = "salesforge-utm";
const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;

export type Utm = Partial<Record<(typeof UTM_KEYS)[number], string>>;

/** Called once per page load: stores the landing URL's utm_* values if none are stored yet this visit. */
export function rememberLandingUtm() {
  try {
    if (sessionStorage.getItem(KEY)) return;
    const params = new URLSearchParams(location.search);
    const utm: Utm = {};
    for (const k of UTM_KEYS) {
      const v = params.get(`utm_${k}`);
      if (v) utm[k] = v.slice(0, 200);
    }
    sessionStorage.setItem(KEY, JSON.stringify(utm));
  } catch {}
}

/** The page the form is on plus the visit's landing UTM values, to add to a form's JSON. */
export function salesforgeTracking(): { page: { url: string; title: string }; utm: Utm } {
  let utm: Utm = {};
  try {
    utm = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Utm;
  } catch {}
  return { page: { url: location.href.slice(0, 2000), title: document.title.slice(0, 200) }, utm };
}

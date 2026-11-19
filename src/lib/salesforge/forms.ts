/**
 * Every lead form on the site that is sent to Salesforge (the forms list).
 * Adding a form later means adding one entry here and calling sendLeadToSalesforge() from its submit handler.
 *
 * Not sent: none skipped. The site has no pop-up, landing-page, newsletter or third-party embedded forms;
 * the only other <form> is the site search in the mobile menu, which is not a lead form.
 */

/** Standard Salesforge lead keys a form field can map to. */
export type LeadKey = "name" | "first_name" | "last_name" | "phone" | "email" | "city" | "state" | "pincode" | "language" | "notes";

export interface SalesforgeForm {
  /** Shown to the team in Salesforge as form.name. */
  name: string;
  /** Our lead key → the field name the form submits. */
  fields: Partial<Record<LeadKey, string>>;
  /** The form's own field names to pass through as extra keys. */
  extras?: string[];
  /** fixed: the form is about one thing; field: the visitor's choice (options feed the test-lead command); fromPage: the page title. */
  product?: { fixed: string } | { field: string; options: string[] } | { fromPage: true };
  /** Left out = the default listener. */
  route?: string;
}

export const SALESFORGE_FORMS: Record<string, SalesforgeForm> = {
  // /contact — the two-step LeadForm (kind "contact"), posted by JS to /api/contact.
  contact: {
    name: "Contact",
    fields: { name: "name", phone: "phone", email: "email", notes: "message" },
    extras: ["company", "topic"],
  },
  // /request-access — the two-step LeadForm (kind "demo"), posted by JS to /api/contact.
  "request-access": {
    name: "Request Access",
    fields: { name: "name", phone: "phone", email: "email", notes: "message" },
    extras: ["company"],
    // Keep in step with the "Main Source Of Interest" options in src/components/LeadForm.tsx.
    product: { field: "source", options: ["Google Maps", "LinkedIn", "IndiaMART", "Several Sources"] },
  },
};

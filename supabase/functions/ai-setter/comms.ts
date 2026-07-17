// GHL messaging + contact helpers + internal email for the AI setter.
import { admin } from "../_shared/db.ts";

const BASE = "https://services.leadconnectorhq.com";
const MSG_VERSION = "2021-04-15";
const CONTACT_VERSION = "2021-07-28";
const LOC = Deno.env.get("GHL_LOCATION_ID") || "z4t41ywW9EayYdtYsUBH";

export async function getSecret(name: string): Promise<string | null> {
  const env = Deno.env.get(name);
  if (env) return env;
  const { data, error } = await admin().rpc("get_secret", { p_name: name });
  if (error || !data) return null;
  return data as string;
}

async function ghlToken(): Promise<string> {
  const t = await getSecret("GHL_TOKEN");
  if (!t) throw new Error("GHL_TOKEN not found (env or Vault)");
  return t;
}

async function ghl(path: string, version: string, init: RequestInit = {}) {
  const token = await ghlToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`, Version: version,
      Accept: "application/json", "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`GHL ${init.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

export async function sendMessage(conv: any, text: string, brand: any) {
  if (conv.channel === "email") {
    const subject = `Re: your ${brand.display_name} inquiry`;
    const html = text.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
    return await ghl(`/conversations/messages`, MSG_VERSION, {
      method: "POST",
      body: JSON.stringify({ type: "Email", contactId: conv.ghl_contact_id, subject, html, emailTo: conv.contact_email ?? undefined }),
    });
  }
  return await ghl(`/conversations/messages`, MSG_VERSION, {
    method: "POST",
    body: JSON.stringify({ type: "SMS", contactId: conv.ghl_contact_id, message: text }),
  });
}

export async function sendSmsToPhone(phone: string, message: string) {
  const up = await ghl(`/contacts/upsert`, CONTACT_VERSION, {
    method: "POST",
    body: JSON.stringify({ locationId: LOC, phone }),
  });
  const contactId = up?.contact?.id ?? up?.id;
  if (!contactId) throw new Error(`could not upsert contact for ${phone}`);
  return await ghl(`/conversations/messages`, MSG_VERSION, {
    method: "POST",
    body: JSON.stringify({ type: "SMS", contactId, message }),
  });
}

// Find-or-create a GHL contact by phone/email; returns its id.
export async function ghlUpsertContact(c: { phone?: string; email?: string; name?: string }): Promise<{ contactId: string }> {
  const body: Record<string, unknown> = { locationId: LOC };
  if (c.phone) body.phone = c.phone;
  if (c.email && /@/.test(c.email)) body.email = c.email;
  if (c.name) body.name = c.name;
  const up = await ghl(`/contacts/upsert`, CONTACT_VERSION, { method: "POST", body: JSON.stringify(body) });
  const contactId = up?.contact?.id ?? up?.id;
  if (!contactId) throw new Error("contact upsert returned no id");
  return { contactId };
}

export async function getRecentMessages(contactId: string): Promise<{ convId: string | null; messages: any[] }> {
  const s = await ghl(`/conversations/search?locationId=${LOC}&contactId=${contactId}`, MSG_VERSION);
  const convId = s?.conversations?.[0]?.id ?? null;
  if (!convId) return { convId: null, messages: [] };
  const j = await ghl(`/conversations/${convId}/messages?limit=60`, MSG_VERSION);
  const blk = j?.messages;
  return { convId, messages: (blk && blk.messages) || [] };
}

export async function getContactDetails(contactId: string): Promise<{ tags: string[]; source?: string; dateAdded?: string; address?: string; customFields: any[] }> {
  const data = await ghl(`/contacts/${contactId}`, CONTACT_VERSION);
  const c = data?.contact ?? {};
  const addr = [c.address1, c.city, c.state, c.postalCode].filter(Boolean).join(", ");
  return {
    tags: c.tags ?? [],
    source: c.source ?? undefined,
    dateAdded: c.dateAdded ?? undefined,
    address: addr || undefined,
    customFields: c.customFields ?? c.customField ?? [],
  };
}

export async function getContactTags(contactId: string): Promise<string[]> {
  return (await getContactDetails(contactId)).tags;
}

export async function addTags(contactId: string, tags: string[]) {
  return await ghl(`/contacts/${contactId}/tags`, CONTACT_VERSION, {
    method: "POST",
    body: JSON.stringify({ tags }),
  });
}

export async function removeTags(contactId: string, tags: string[]) {
  return await ghl(`/contacts/${contactId}/tags`, CONTACT_VERSION, {
    method: "DELETE",
    body: JSON.stringify({ tags }),
  });
}

export async function sendInternalEmail(to: string[], subject: string, html: string): Promise<boolean> {
  const key = await getSecret("RESEND_API_KEY");
  if (!key) { console.error("RESEND_API_KEY not set; cannot send internal email:", subject); return false; }
  const from = (await getSecret("MAIL_FROM")) || "Advosy Growth <onboarding@resend.dev>";
  const rs = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!rs.ok) console.error("Resend send failed:", rs.status, await rs.text().catch(() => ""));
  return rs.ok;
}

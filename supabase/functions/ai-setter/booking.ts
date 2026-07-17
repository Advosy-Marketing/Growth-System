// Availability, appointment booking, and sold-account creation for the AI
// agent, reusing the same provider adapters as the Growth booking app.
import { admin, getServiceConfig } from "../_shared/db.ts";
import { ghlProvider } from "../_shared/ghl.ts";
import { serviceTitanProvider } from "../_shared/servicetitan.ts";
import { frProvider, frCreateSale } from "../_shared/fieldroutes.ts";
import { sendInternalEmail, sendSmsToPhone } from "./comms.ts";
import type { AvailabilityProvider, Provider } from "../_shared/providers.ts";

const PROVIDERS: Partial<Record<Provider, AvailabilityProvider>> = {
  ghl: ghlProvider,
  servicetitan: serviceTitanProvider,
  fieldroutes: frProvider,
};

const PESTKEE_SOLD_NOTIFY_EMAIL = ["Julia@pestkee.com", "Zach@pestkee.com", "Tucker@pestkee.com"];
const PESTKEE_SOLD_NOTIFY_SMS = ["+18018211243", "+12089579971"];

export interface SlotOption { start: string; end: string; label: string; ref?: string; tech?: string; }

export async function getSlots(serviceType: string, daysAhead = 7, tz = "America/Phoenix"): Promise<SlotOption[]> {
  const db = admin();
  const cfg = await getServiceConfig(db, serviceType);
  const provider = PROVIDERS[cfg.provider as Provider];
  if (!provider) throw new Error(`Online booking is not wired for ${serviceType}; collect preferred times and flag_for_human instead.`);
  const startMs = Date.now() + 90 * 60_000;
  const endMs = Date.now() + daysAhead * 86_400_000;
  const slots = await provider.getAvailability(cfg, startMs, endMs, tz);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const perDay: Record<string, number> = {};
  const out: SlotOption[] = [];
  for (const s of slots) {
    const day = s.start.slice(0, 10);
    if ((perDay[day] ?? 0) >= 3) continue;
    perDay[day] = (perDay[day] ?? 0) + 1;
    out.push({ start: s.start, end: s.end, label: fmt.format(new Date(s.start)), ...(s.ref ? { ref: s.ref } : {}), ...(s.assignedRep ? { tech: s.assignedRep } : {}) });
    if (out.length >= 12) break;
  }
  return out;
}

const SOURCE_CHANNEL: Record<string, { channel: string; channel_other?: string }> = {
  facebook: { channel: "meta_ads" },
  thumbtack: { channel: "thumbtack" },
  website: { channel: "other", channel_other: "Website Form" },
};

export async function bookSlot(db: any, input: any, conv: any) {
  const cfg = await getServiceConfig(db, input.service_type);
  const provider = PROVIDERS[cfg.provider as Provider];
  if (!provider) throw new Error(`Provider ${cfg.provider} not wired for AI booking`);

  const slotStart = new Date(input.slot_start);
  if (isNaN(slotStart.getTime())) throw new Error("slot_start is not a valid ISO time");
  const slotEnd = new Date(slotStart.getTime() + (cfg.default_duration_min ?? 60) * 60_000).toISOString();

  const srcMap = SOURCE_CHANNEL[conv.lead_source ?? ""] ?? { channel: "other", channel_other: conv.lead_source ?? "AI Setter" };
  const customer = {
    name: input.name || conv.contact_name || "Unknown",
    phone: input.phone || conv.contact_phone || undefined,
    email: input.email || conv.contact_email || undefined,
    address: input.address || undefined,
  };

  const r = await provider.createBooking(cfg, {
    serviceType: input.service_type,
    appointmentType: "AI Set Appointment",
    customer,
    slot: { start: slotStart.toISOString(), end: slotEnd, ...(input.slot_ref ? { ref: String(input.slot_ref) } : {}) },
    notes: input.notes ? `${input.notes} (set by AI assistant)` : "Set by AI assistant",
    channel: srcMap.channel === "meta_ads" ? "Meta Ads" : (srcMap.channel === "thumbtack" ? "Thumbtack" : (srcMap.channel_other ?? "Other")),
    campaign: "High Intent",
  });

  try {
    const { data: cust } = await db.from("customers").insert({
      name: customer.name, phone: customer.phone ?? null, email: customer.email ?? null, address: customer.address ?? null,
    }).select().single();
    const { data: bs } = await db.from("booking_sessions").insert({
      customer_id: cust?.id, rep_id: null, source: "AI Setter",
      channel: srcMap.channel, channel_other: srcMap.channel_other ?? null,
      campaign: "high_intent", notes: input.notes ?? null,
    }).select().single();
    if (bs?.id) {
      await db.from("booking_items").insert({
        session_id: bs.id, service_type: input.service_type, appointment_type: "AI Set Appointment",
        provider: cfg.provider, provider_ref: r.providerRef, slot_start: slotStart.toISOString(), slot_end: slotEnd,
        status: "booked", assigned_rep: r.assignedRep ?? null,
      });
    }
  } catch (e) {
    console.error("local booking record failed (booking itself succeeded):", e);
  }
  return r;
}

export async function sellAccount(db: any, input: any, conv: any) {
  const cfg = await getServiceConfig(db, "pest_control");
  const initial = Number(input.initial_charge);
  const perVisit = Number(input.service_charge);
  const freq = Number(input.frequency_days ?? 90);
  if (!(initial >= 0) || !(perVisit > 0)) throw new Error("initial_charge and service_charge must be valid numbers");
  if (![30, 60, 90].includes(freq)) throw new Error("frequency_days must be 30, 60, or 90");

  const customer = {
    name: String(input.name),
    phone: input.phone ? String(input.phone) : (conv.contact_phone ?? undefined),
    email: input.email ? String(input.email) : (conv.contact_email ?? undefined),
    street: String(input.street), city: String(input.city), state: String(input.state), zip: String(input.zip),
    address: `${input.street}, ${input.city}, ${input.state} ${input.zip}`,
  };

  const srcMap = SOURCE_CHANNEL[conv.lead_source ?? ""] ?? { channel: "other", channel_other: conv.lead_source ?? "AI Setter" };
  const channelLabel = srcMap.channel === "meta_ads" ? "Meta Ads" : (srcMap.channel === "thumbtack" ? "Thumbtack" : (srcMap.channel_other ?? "Other"));
  const sale = await frCreateSale(cfg, {
    customer,
    initialCharge: initial,
    serviceCharge: perVisit,
    frequencyDays: freq,
    notes: [input.plan ? `Plan: ${input.plan}` : null, input.notes ?? null, conv.campaign ? `Campaign: ${conv.campaign}` : null, "Sold by AI setter"].filter(Boolean).join(" | "),
    channel: channelLabel,
    campaign: "High Intent",
    emailContract: true,
  });

  let firstServiceBooked = false;
  let firstServiceLabel = "Office to schedule (no slot chosen in chat)";
  const tz = "America/Phoenix";
  if (input.first_service_slot_start) {
    try {
      const slotStart = new Date(String(input.first_service_slot_start));
      const slotEnd = new Date(slotStart.getTime() + (cfg.default_duration_min ?? 45) * 60_000).toISOString();
      await frProvider.createBooking(cfg, {
        serviceType: "pest_control",
        appointmentType: "Initial Service (AI Sold)",
        customer,
        slot: { start: slotStart.toISOString(), end: slotEnd, ...(input.first_service_slot_ref ? { ref: String(input.first_service_slot_ref) } : {}) },
        notes: `Initial flush-out / first service. ${input.notes ?? ""} (sold + scheduled by AI setter)`,
        channel: channelLabel,
        campaign: "High Intent",
      });
      firstServiceBooked = true;
      firstServiceLabel = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(slotStart);
    } catch (e) {
      console.error("first-service booking failed (sale stands):", e);
      firstServiceLabel = "FAILED to auto-book, office must schedule: " + String((e as Error)?.message ?? e).slice(0, 120);
    }
  }

  const visitsPerYear = Math.round(360 / freq);
  const contractValue = initial + visitsPerYear * perVisit;
  const planLabel = String(input.plan ?? "custom").replace("_", " ");

  try {
    const { data: cust } = await db.from("customers").insert({
      name: customer.name, phone: customer.phone ?? null, email: customer.email ?? null, address: customer.address ?? null,
    }).select().single();
    const { data: bs } = await db.from("booking_sessions").insert({
      customer_id: cust?.id, rep_id: null, source: "AI Setter",
      channel: srcMap.channel, channel_other: srcMap.channel_other ?? null,
      campaign: "high_intent", notes: input.notes ?? null,
    }).select().single();
    if (bs?.id) {
      await db.from("booking_items").insert({
        session_id: bs.id, service_type: "pest_control", appointment_type: "sold_customer",
        provider: "fieldroutes", provider_ref: `SUB-${sale.subscriptionID}`,
        slot_start: firstServiceBooked ? new Date(String(input.first_service_slot_start)).toISOString() : null,
        status: "booked", contract_value: contractValue,
      });
    }
  } catch (e) {
    console.error("local sold record failed (sale itself succeeded):", e);
  }

  try {
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:auto;color:#1a2230">
    <h2 style="color:#16834a;margin:0 0 12px">New Sold Account (AI Setter)</h2>
    <p style="margin:0 0 14px">A lead was just closed by the AI appointment setter and needs the <b>subscription finalized</b>${firstServiceBooked ? " (first service is already on the route, please verify)" : " and needs to be <b>put on the route</b>"}.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">Customer</td><td style="padding:6px 10px;border-bottom:1px solid #eee"><b>${customer.name}</b></td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">Phone</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${customer.phone ?? "n/a"}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">Email</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${customer.email ?? "n/a"}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">Address</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${customer.address}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">Plan</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${planLabel} (every ${freq} days)</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">Initial</td><td style="padding:6px 10px;border-bottom:1px solid #eee">$${initial.toFixed(2)}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">Per visit</td><td style="padding:6px 10px;border-bottom:1px solid #eee">$${perVisit.toFixed(2)}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">First service</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${firstServiceLabel}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">Est. annual value</td><td style="padding:6px 10px;border-bottom:1px solid #eee">$${contractValue.toFixed(2)}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">FieldRoutes customer</td><td style="padding:6px 10px;border-bottom:1px solid #eee">#${sale.customerID}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">Subscription</td><td style="padding:6px 10px;border-bottom:1px solid #eee">#${sale.subscriptionID}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">E-sign agreement</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${sale.contractSent ? "Sent to customer ✅" : "FAILED to send ⚠️ please send manually: " + (sale.contractError ?? "unknown error")}</td></tr>
    </table>
    ${input.notes ? `<p style="font-size:14px;margin-top:12px"><b>Notes:</b> ${input.notes}</p>` : ""}
    <p style="color:#999;font-size:12px;margin-top:16px">Sent automatically by the Advosy Growth AI setter.</p></div>`;
    await sendInternalEmail(PESTKEE_SOLD_NOTIFY_EMAIL, `SOLD: ${customer.name}, Pestkee ${planLabel} plan${firstServiceBooked ? ", first service " + firstServiceLabel : ", needs routing"}`, html);
  } catch (e) {
    console.error("sold-notification email failed:", e);
  }

  try {
    const sms = `Pestkee SOLD (AI): ${customer.name}, ${customer.city}. ${planLabel} plan $${perVisit.toFixed(0)}/visit + $${initial.toFixed(0)} initial. First service: ${firstServiceLabel}. ${customer.address}. FR cust #${sale.customerID}, sub #${sale.subscriptionID}. Contract ${sale.contractSent ? "emailed" : "NOT sent, send manually"}.`;
    for (const ph of PESTKEE_SOLD_NOTIFY_SMS) {
      try { await sendSmsToPhone(ph, sms); } catch (e) { console.error(`sold SMS to ${ph} failed:`, e); }
    }
  } catch (e) {
    console.error("sold-notification SMS failed:", e);
  }

  return { ...sale, firstServiceBooked };
}

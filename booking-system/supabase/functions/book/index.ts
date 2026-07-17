// =====================================================================
// POST /functions/v1/book
// Body: {
//   session: { customer:{name,phone,email,address}, source, channel,
//              channel_other?, campaign, campaign_other?, rep_id? },
//   items:   [{ service_type, appointment_type, slot:{start,end},
//               assigned_user_id?, is_upsell? }]
// }
// Creates the customer + booking_session, books each item in its backend,
// writes booking_items, and returns the results (partial failures included).
// =====================================================================

import { admin, getServiceConfig } from "../_shared/db.ts";
import { audit } from "../_shared/audit.ts";
import { ghlProvider } from "../_shared/ghl.ts";
import { serviceTitanProvider } from "../_shared/servicetitan.ts";
import { frProvider, frCreateSale } from "../_shared/fieldroutes.ts";
import type { AvailabilityProvider, Provider, BookingInput } from "../_shared/providers.ts";

const PROVIDERS: Partial<Record<Provider, AvailabilityProvider>> = {
  ghl: ghlProvider,
  servicetitan: serviceTitanProvider,
  fieldroutes: frProvider,
};

// service_type -> backend provider. Used so booking_items.provider (NOT NULL) is
// ALWAYS populated, even when the booking attempt fails or the service_catalog
// row can't be loaded. Without this, a failed/unknown booking violated the
// not-null constraint and the row was silently dropped (session saved, item lost).
const PROVIDER_BY_SERVICE: Record<string, Provider> = {
  hvac: "servicetitan",
  plumbing: "servicetitan",
  roofing: "ghl",
  restoration: "ghl",
  pest_control: "fieldroutes",
};

// Readable labels for the attribution dropdowns, so the CRMs receive human-friendly
// text (not raw keys like "lsa"). Mirrors CHANNELS / CAMPAIGNS in book.html.
const CHANNEL_LABELS: Record<string, string> = {
  meta_ads: "Meta Ads", lsa: "LSA (Local Services Ads)", thumbtack: "Thumbtack",
  outbound_calling: "Outbound Calling", organic_social: "Organic Social",
  jobsite_marketing: "Jobsite Marketing", eddm: "EDDM (Direct Mail)",
  b2b_affiliate: "B2B Affiliate", other: "Other",
};
const CAMPAIGN_LABELS: Record<string, string> = {
  demand_generation: "Demand Generation", high_intent: "High Intent",
  we_are_advosy: "We Are Advosy", sales_enablement: "Sales Enablement",
  brand_awareness: "Brand Awareness", other: "Other",
};
const labelFor = (map: Record<string, string>, key?: string, other?: string) =>
  !key ? undefined : (key === "other" ? (other || "Other") : (map[key] || key));

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { session, items } = await req.json();
    if (!session?.customer?.name || !Array.isArray(items) || items.length === 0) {
      return json({ error: "session.customer.name and at least one item are required" }, 400);
    }

    const db = admin();

    // ---- Rep authentication (public.verify_pin: bcrypt + lockout) — STRICT ----
    if (!session.rep_id || session.pin == null) {
      return json({ error: "rep_id and pin required — refresh the booking page" }, 401);
    }
    const { data: auth, error: vErr } = await db.rpc("verify_pin", { p_user: session.rep_id, p_pin: String(session.pin) });
    if (vErr) return json({ error: vErr.message }, 500);
    if (!auth?.ok) return json({ error: auth?.error ?? "invalid pin" }, 401);

    // 1) Customer (entered once, reused for every item).
    const { data: cust, error: cErr } = await db.from("customers").insert({
      name: session.customer.name,
      phone: session.customer.phone ?? null,
      email: session.customer.email ?? null,
      address: session.customer.address ?? null,
      created_by: session.rep_id ?? null,
    }).select().single();
    if (cErr) throw new Error(`customers insert: ${cErr.message}`);

    // 2) Booking session (attribution lives here).
    const { data: bs, error: sErr } = await db.from("booking_sessions").insert({
      customer_id: cust.id,
      rep_id: session.rep_id ?? null,
      source: session.source,
      channel: session.channel,
      channel_other: session.channel_other ?? null,
      campaign: session.campaign,
      campaign_other: session.campaign_other ?? null,
      notes: session.notes ?? null,
      gate_code: session.gate_code ?? null,
      emergency: !!session.emergency,
    }).select().single();
    if (sErr) throw new Error(`booking_sessions insert: ${sErr.message}`);

    // 3) Book each item in its backend; record success/failure per item.
    const results: unknown[] = [];
    for (const it of items) {
      // Resolve a provider up front so the row is always persistable (provider is NOT NULL).
      const fallbackProvider: Provider = PROVIDER_BY_SERVICE[it.service_type] ?? "servicetitan";
      let row: Record<string, unknown> = {
        session_id: bs.id,
        service_type: it.service_type,
        appointment_type: it.appointment_type,
        provider: fallbackProvider, // refined below on a successful backend booking
        slot_start: it.slot?.start ?? null,
        slot_end: it.slot?.end ?? null,
        is_upsell: !!it.is_upsell,
        contract_value: it.contract_value ?? null,
        sale_type: it.sale_type ?? null,
        sale_type_other: it.sale_type_other ?? null,
      };
      // "New Sold Customer" = a sale closed on the phone, not a scheduled appointment.
      // It does not touch a backend calendar — we record the opportunity + sale locally,
      // and for FieldRoutes lines (pest) we ALSO push the close into the CRM:
      // customer -> subscription (pricing) -> contract e-sign email.
      if (it.appointment_type === "sold_customer") {
        const cfg = await getServiceConfig(db, it.service_type).catch(() => null);
        row = { ...row, provider: cfg?.provider ?? fallbackProvider, provider_ref: null, assigned_rep: session?.setter ?? null, status: "booked" };
        if (cfg?.provider === "fieldroutes" && cfg.fr_office_id && cfg.fr_service_type_id) {
          const saleReq = {
            service_type: it.service_type, appointment_type: it.appointment_type,
            contract_value: it.contract_value ?? null, service_charge: it.service_charge ?? null,
            customer: { name: session.customer.name, phone: session.customer.phone ?? null },
            rep_id: session.rep_id ?? null,
          };
          try {
            const sale = await frCreateSale(cfg, {
              customer: session.customer,
              initialCharge: Number(it.contract_value) || 0,
              serviceCharge: it.service_charge != null ? Number(it.service_charge) : undefined,
              frequencyDays: it.fr_frequency != null ? Number(it.fr_frequency) : undefined,
              soldByEmployeeID: it.fr_sold_by ?? undefined,
              notes: [it.sale_type ? `Sold: ${it.sale_type}` : null, session.notes ?? null].filter(Boolean).join(" | ") || undefined,
              channel: labelFor(CHANNEL_LABELS, session.channel, session.channel_other),
              campaign: labelFor(CAMPAIGN_LABELS, session.campaign, session.campaign_other),
              emailContract: it.email_contract !== false,
            });
            row = {
              ...row,
              provider_ref: `SUB-${sale.subscriptionID}`,
              // Sale pushed; contract email failure is non-fatal but visible.
              error_detail: sale.contractSent ? null : `contract email failed: ${sale.contractError ?? "unknown"}`,
            };
            await audit(db, bs.id, "fieldroutes", "create_sale", saleReq,
              { subscription_id: sale.subscriptionID, fr_customer_id: sale.customerID, contract_sent: sale.contractSent }, true);
          } catch (e) {
            const msg = String((e as Error)?.message ?? e);
            // Local sale record stands (phone sales must never be lost); surface the CRM error.
            row = { ...row, error_detail: `FieldRoutes sale push failed: ${msg}` };
            await audit(db, bs.id, "fieldroutes", "create_sale", saleReq, { error: msg }, false);
          }
        }
      } else {
        const auditReq = {
          service_type: it.service_type,
          appointment_type: it.appointment_type,
          slot: it.slot ?? null,
          customer: { name: session.customer.name, phone: session.customer.phone ?? null },
          rep_id: session.rep_id ?? null,
        };
        try {
          const cfg = await getServiceConfig(db, it.service_type);
          // Per-item override: specific ServiceTitan job type / business unit (two-tier picker).
          if (it.st_job_type_id) cfg.st_job_type_id = String(it.st_job_type_id);
          if (it.st_business_unit_id) cfg.st_business_unit_id = String(it.st_business_unit_id);
          const provider = PROVIDERS[cfg.provider];
          if (!provider) throw new Error(`Provider "${cfg.provider}" not wired yet`);
          const input: BookingInput = {
            serviceType: it.service_type,
            appointmentType: it.appointment_type,
            customer: session.customer,
            slot: it.slot,
            assignedUserId: it.assigned_user_id,
            notes: session.notes ?? undefined,
            gateCode: session.gate_code ?? undefined,
            emergency: !!session.emergency,
            channel: labelFor(CHANNEL_LABELS, session.channel, session.channel_other),
            campaign: labelFor(CAMPAIGN_LABELS, session.campaign, session.campaign_other),
            campaignId: it.st_campaign_id ?? undefined,
          };
          const r = await provider.createBooking(cfg, input);
          row = { ...row, provider: cfg.provider, provider_ref: r.providerRef, assigned_rep: r.assignedRep ?? null, status: "booked" };
          await audit(db, bs.id, cfg.provider, "create_booking", auditReq, { provider_ref: r.providerRef, assigned_rep: r.assignedRep ?? null }, true);
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          row = { ...row, status: "failed", error_detail: msg };
          await audit(db, bs.id, (row.provider as string) ?? null, "create_booking", auditReq, { error: msg }, false);
        }
      }
      const { data: saved, error: iErr } = await db.from("booking_items").insert(row).select().single();
      if (iErr) {
        // Never silently drop a booking again: if the row won't persist, report it
        // back as a failed item (with the DB error) instead of returning a phantom success.
        results.push({ ...row, status: "failed", error_detail: `persist failed: ${iErr.message}` });
      } else {
        results.push(saved);
      }
    }

    return json({ session_id: bs.id, customer_id: cust.id, items: results });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

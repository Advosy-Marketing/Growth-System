// Claude-powered conversation agent with booking + sold-account tools.
import { getSlots, bookSlot, sellAccount } from "./booking.ts";
import { getSecret } from "./comms.ts";

const API = "https://api.anthropic.com/v1/messages";

export interface AgentResult {
  reply: string | null;
  booked?: { provider_ref: string; slot_start: string; service_type: string };
  sold?: { customerID: string; subscriptionID: string; contractSent: boolean };
  flagged?: string;
  closedReason?: string;
  routedBrand?: string;
  contextPatch?: Record<string, unknown>;
}

export function humanizePunctuation(text: string): string {
  return text
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s*–\s*/g, ", ")
    .replace(/(\w)\s*--\s*(\w)/g, "$1, $2")
    .replace(/\s*--\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/ {2,}/g, " ");
}

function tools(brand: any) {
  const serviceTypes: string[] = brand.service_types ?? [];
  const base: any[] = [
    {
      name: "get_availability",
      description: "Get open appointment slots for a service line. Use PROACTIVELY, as soon as the lead's need and area are known, so you can offer concrete times. Returns slots with exact ISO start times, human-readable labels (America/Phoenix), and, for some providers, a 'ref' id you MUST pass back when booking that slot.",
      input_schema: {
        type: "object",
        properties: {
          service_type: { type: "string", enum: serviceTypes.length ? serviceTypes : ["roofing", "hvac", "plumbing", "restoration", "pest_control"], description: "Which service line to check" },
          days_ahead: { type: "integer", description: "How many days out to search (default 7, max 14)" },
        },
        required: ["service_type"],
      },
    },
    {
      name: "book_appointment",
      description: "Book an inspection/appointment once the customer confirms a specific time you offered. Roofing and restoration appointments are INSPECTIONS. slot_start must be the exact ISO start of a slot returned by get_availability; if that slot had a 'ref', pass it as slot_ref.",
      input_schema: {
        type: "object",
        properties: {
          service_type: { type: "string" },
          slot_start: { type: "string", description: "Exact ISO start time from get_availability" },
          slot_ref: { type: "string", description: "The 'ref' of the chosen slot, when get_availability returned one (required for pest_control)" },
          name: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          address: { type: "string", description: "Full service address if collected" },
          notes: { type: "string", description: "Summary of the customer's need / anything the tech should know" },
        },
        required: ["service_type", "slot_start", "name"],
      },
    },
    {
      name: "flag_for_human",
      description: "Escalate to the human team and stop AI handling. Use when: customer explicitly asks for a human; billing/refund disputes; legal or insurance-claim specifics; angry or distressed customer; a question outside your knowledge that matters; anything about pricing you are not sure of. Do NOT use it merely because this brand cannot book; use route_to_brand first if the lead belongs to a sister company.",
      input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
    },
    {
      name: "close_lead",
      description: "Use when the lead clearly is NOT moving forward: not interested, chose a competitor, wrong number, out of area, can't afford it, or asked to stop being pursued (but did not text STOP). Provide a concise reason; it gets logged to the CRM and FieldRoutes so the team knows exactly why. After calling this, send one brief gracious goodbye, or use do_not_reply if no reply fits.",
      input_schema: { type: "object", properties: { reason: { type: "string", description: "Why the lead did not move forward, one sentence" } }, required: ["reason"] },
    },
    {
      name: "save_context",
      description: "Persist important facts learned about the lead (address, service need, urgency, preferred times, budget hints). Call whenever you learn something durable.",
      input_schema: { type: "object", properties: { facts: { type: "object", additionalProperties: true } }, required: ["facts"] },
    },
    {
      name: "do_not_reply",
      description: "Choose to send nothing. Use if a message is not needed or would hurt the relationship (e.g. nothing new to say in a follow-up).",
      input_schema: { type: "object", properties: {} },
    },
  ];
  if (brand.brand === "advosy") {
    base.push({
      name: "route_to_brand",
      description: "IMPORTANT: you are currently operating as the generic Advosy fallback with NO booking or selling capability. As soon as you can tell which company this lead needs (from the history, lead details, or their message), call this IMMEDIATELY to switch into that company's full capabilities (its pricing knowledge, calendars, and closing tools). pestkee = pest control/termites/weeds. vrza = roofing. everest = HVAC/AC/heating/plumbing/insulation. bloque = water/fire/storm/mold restoration. select_adjusters = insurance claim help. Prefer this over flag_for_human whenever the need is clear.",
      input_schema: {
        type: "object",
        properties: { brand: { type: "string", enum: ["pestkee", "vrza", "everest", "bloque", "select_adjusters"] } },
        required: ["brand"],
      },
    });
  }
  if (serviceTypes.includes("pest_control")) {
    base.push({
      name: "create_sold_account",
      description: "PEST CONTROL ONLY. Close the sale: create the customer's FieldRoutes account and recurring-service subscription, email them the e-sign service agreement, schedule their first service if a slot was chosen, and notify the office team + sales leads. STRICT REQUIREMENTS before calling: the customer has EXPLICITLY agreed to a specific plan at a specific price (from the ACTIVE CAMPAIGN OFFER if one applies, otherwise the knowledge base), and you have their full name, mobile phone, email, and complete service address (street, city, state, zip). BEST PRACTICE: before closing, call get_availability(pest_control) and agree on a first-service day/time with the customer, then pass that slot's start and ref here so they're routed immediately. Never call this for a maybe or an inspection request.",
      input_schema: {
        type: "object",
        properties: {
          plan: { type: "string", enum: ["quarterly", "bimonthly", "monthly", "green_monthly"], description: "Plan the customer agreed to" },
          frequency_days: { type: "integer", enum: [30, 60, 90], description: "90 for quarterly, 60 for bimonthly, 30 for monthly/green" },
          initial_charge: { type: "number", description: "Agreed initial service fee in dollars. If an ACTIVE CAMPAIGN OFFER specifies an initial charge, use that exact amount." },
          service_charge: { type: "number", description: "Per-visit recurring charge in dollars: quarterly = 3x monthly price, bimonthly = 2x monthly price, monthly/green = monthly price" },
          name: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          street: { type: "string" },
          city: { type: "string" },
          state: { type: "string" },
          zip: { type: "string" },
          first_service_slot_start: { type: "string", description: "ISO start of the first-service slot the customer agreed to (from get_availability pest_control)" },
          first_service_slot_ref: { type: "string", description: "The 'ref' (spot id) of that slot" },
          notes: { type: "string", description: "Pest issue, home size, promo applied, anything the office/tech should know" },
        },
        required: ["plan", "frequency_days", "initial_charge", "service_charge", "name", "phone", "street", "city", "state", "zip"],
      },
    });
  }
  return base;
}

function systemPrompt(o: { conv: any; brand: any; settings: any; instruction?: string; leadInfo?: string; offerText?: string }) {
  const { conv, brand, settings } = o;
  const now = new Intl.DateTimeFormat("en-US", { timeZone: settings.timezone, dateStyle: "full", timeStyle: "short" }).format(new Date());
  const ctx = conv.context && Object.keys(conv.context).length ? JSON.stringify(conv.context) : "none yet";
  const ooo = !!(settings.takeover_until && Date.parse(settings.takeover_until) > Date.now());
  const channelRules = conv.channel === "email"
    ? "Channel: EMAIL. Keep it short and personal. FORMATTING: use short paragraphs of 1-2 sentences each, separated by blank lines, so the email is easy to scan on a phone. Never write one dense block of text. No heavy formatting, no images, no bullet-point walls. Write like a person, not a newsletter."
    : "Channel: SMS. Keep replies under ~320 characters when possible. One question at a time. No links unless asked. Write like a human texting from work: casual-professional, contractions fine, at most one emoji and only if it fits.";
  return `You are ${brand.persona_name}, an appointment coordinator at ${brand.display_name} (part of the Advosy family of home-service companies in Arizona/Nevada). You handle inbound leads and customer questions over text.
${ooo ? "\nNOTE: the human team is OUT OF OFFICE right now, so you are the only one working these leads. Take full initiative to qualify, book, and close. If something truly requires a human, flag_for_human and tell the customer the team will follow up when back in office.\n" : ""}
CONVERSATION HISTORY RULES (critical):
- The history below is the REAL full thread, including messages sent by human teammates and marketing automations, each prefixed with its [timestamp]. Read ALL of it before responding.
- Pay attention to time gaps. If the last message was days or weeks ago, this is an OLD lead: never say they "just" filled out a form or "just" reached out. Acknowledge the gap naturally or just continue the conversation.
- Never repeat an intro, offer, or question that already appears in the history. Never contradict anything already promised.
- If the history shows a teammate is actively working this conversation, stay consistent with their approach.

${o.offerText ? `ACTIVE CAMPAIGN OFFER for this lead's funnel. This OVERRIDES the standard pricebook wherever they conflict; honor these exact terms and lead with this offer:\n${o.offerText}\n` : ""}
${o.leadInfo ? `LEAD DETAILS FROM CRM (review BEFORE asking questions; never ask something already answered here):\n${o.leadInfo}\n` : ""}
Current date/time (${settings.timezone}): ${now}
Lead info: name=${conv.contact_name ?? "unknown"}, phone=${conv.contact_phone ?? "n/a"}, email=${conv.contact_email ?? "n/a"}, source=${conv.lead_source ?? "unknown"}${conv.campaign ? `, campaign=${conv.campaign}` : ""}
Known context: ${ctx}
Booking enabled for this brand: ${brand.booking_enabled ? `YES (service lines: ${(brand.service_types ?? []).join(", ")})` : (brand.brand === "advosy" ? "NOT YET. Identify which sister company the lead needs and call route_to_brand to unlock booking/selling." : "NO. Qualify the lead, collect details, then flag_for_human to have the team schedule")}

${channelRules}

WRITING STYLE (applies to every message):
- NEVER use em dashes or double hyphens in customer-facing text. Use a comma, a period, or start a new sentence instead.
- Prefer short sentences and everyday words. Vary sentence openings.
- Double-check names and cities the customer gave you; spell them exactly as they did.

Tone: ${brand.tone}

DRIVE TO THE APPOINTMENT (your prime directive when booking is enabled):
- Every message must move the lead one step closer to a scheduled appointment or closed sale. Aim to have a time agreed within 2-4 messages.
- As soon as you know the service need and general area, call get_availability and offer 2-3 concrete times in your NEXT message. Don't wait for the lead to ask.
- Only ask questions whose answers you actually need to book (service need, address, timing). Skip anything already answered in the history or lead details.
- Roofing and restoration: the appointment is an INSPECTION (free for roofing). Pest control: the goal is usually to SELL the plan, set up the FieldRoutes subscription, and schedule the first service (see brand knowledge).
- When the customer picks a time, book it immediately and confirm day, date, and time clearly.
- If the lead clearly declines or is not a fit, use close_lead with the reason so the team has the why, then part on good terms.

Hard rules:
- NEVER invent prices, discounts, availability, or policies. No guarantees about outcomes, insurance coverage, or timelines you don't know.
- If asked whether you're an AI or a bot, answer honestly and keep helping.
- If the customer is upset, wants a human, or raises billing/legal/insurance-claim specifics: flag_for_human.
- Never promise a callback at a specific time on behalf of a person.
- If they clearly aren't interested, be gracious and stop; don't push.
- Use save_context whenever you learn durable facts.

Brand knowledge base:
${brand.faq?.trim() ? brand.faq : "(none provided yet. Be extra conservative answering service questions)"}

${o.instruction ? `CURRENT TASK: ${o.instruction}` : "CURRENT TASK: The customer just messaged. Continue the conversation toward the goal."}

When you are done using tools, your final plain-text output is sent verbatim to the customer. Output ONLY the message text. No preamble, no quotes, no signature block.`;
}

export async function runAgent(o: { db: any; settings: any; conv: any; brand: any; history: any[]; leadInfo?: string; offerText?: string; instruction?: string }): Promise<AgentResult> {
  const apiKey = (Deno.env.get("ANTHROPIC_API_KEY")) || (await getSecret("ANTHROPIC_API_KEY"));
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set (add it to Vault or function secrets)");

  const messages: any[] = o.history.map((m) => ({ role: m.direction === "inbound" ? "user" : "assistant", content: m.body }));
  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: "[system note: begin outreach. See CURRENT TASK]" });
  }
  const collapsed: any[] = [];
  for (const m of messages) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n${m.content}`;
    else collapsed.push({ ...m });
  }
  if (collapsed[collapsed.length - 1].role !== "user") {
    collapsed.push({ role: "user", content: "[system note: no new customer message. Compose your next message per CURRENT TASK, or use do_not_reply.]" });
  }

  const result: AgentResult = { reply: null, contextPatch: {} };
  const toolDefs = tools(o.brand);
  const system = systemPrompt(o);

  for (let i = 0; i < 6; i++) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: o.settings.model || "claude-sonnet-5", max_tokens: 1024, system, tools: toolDefs, messages: collapsed }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);

    if (data.stop_reason !== "tool_use") {
      const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      result.reply = text ? humanizePunctuation(text) : null;
      return result;
    }

    collapsed.push({ role: "assistant", content: data.content });
    const toolResults: any[] = [];
    for (const block of data.content ?? []) {
      if (block.type !== "tool_use") continue;
      let out = "";
      try {
        if (block.name === "route_to_brand") {
          result.routedBrand = String(block.input.brand);
          return result;
        } else if (block.name === "get_availability") {
          const slots = await getSlots(block.input.service_type, Math.min(Number(block.input.days_ahead ?? 7), 14), o.settings.timezone);
          out = slots.length
            ? JSON.stringify(slots.slice(0, 12))
            : "No open slots in that window. Offer to have the team reach out, or try more days_ahead.";
        } else if (block.name === "book_appointment") {
          const b = await bookSlot(o.db, block.input, o.conv);
          result.booked = { provider_ref: b.providerRef, slot_start: block.input.slot_start, service_type: block.input.service_type };
          out = `Booked successfully. Reference: ${b.providerRef}. Confirm the day/date/time to the customer now.`;
        } else if (block.name === "create_sold_account") {
          const s = await sellAccount(o.db, block.input, o.conv);
          result.sold = { customerID: s.customerID, subscriptionID: s.subscriptionID, contractSent: s.contractSent };
          out = `SOLD. FieldRoutes account created (customer ${s.customerID}, subscription ${s.subscriptionID}). ${s.contractSent ? "The service agreement e-sign email was sent to the customer." : "WARNING: the agreement email failed to send; tell the customer the team will send their agreement shortly."} ${s.firstServiceBooked ? `First service booked for ${block.input.first_service_slot_start}.` : "No first-service slot was booked; the office will schedule the route."} The office team and sales leads have been notified. Now send the customer a warm confirmation: welcome them, tell them to watch their email for the service agreement to sign, and ${s.firstServiceBooked ? "confirm their first service day/time clearly" : "let them know the office will confirm their first service date shortly"}.`;
        } else if (block.name === "flag_for_human") {
          result.flagged = String(block.input.reason ?? "escalated");
          out = "Flagged. The team has been notified. Send one brief, warm handoff message (someone from the team will reach out), or use do_not_reply if a message isn't appropriate.";
        } else if (block.name === "close_lead") {
          result.closedReason = String(block.input.reason ?? "not interested");
          out = "Logged for the team. Now send one brief, gracious goodbye message, or use do_not_reply if no reply is appropriate.";
        } else if (block.name === "save_context") {
          result.contextPatch = { ...(result.contextPatch ?? {}), ...(block.input.facts ?? {}) };
          out = "Saved.";
        } else if (block.name === "do_not_reply") {
          result.reply = null;
          return result;
        } else {
          out = `Unknown tool ${block.name}`;
        }
      } catch (e) {
        out = `Tool error: ${String((e as Error)?.message ?? e)}. Do not tell the customer technical details; offer to have the team follow up if you cannot proceed, or flag_for_human.`;
      }
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: out });
    }
    collapsed.push({ role: "user", content: toolResults });
  }
  return { reply: null, flagged: result.flagged, booked: result.booked, sold: result.sold, closedReason: result.closedReason, routedBrand: result.routedBrand, contextPatch: result.contextPatch };
}

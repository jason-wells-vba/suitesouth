import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { checkApiKey } from "@/lib/api/auth";
import { checkAvailability } from "@/lib/availability";
import { isValidDate, todayLocal } from "@/lib/dates";
import { nightsBetween } from "@/lib/calc";
import { createCustomer, findPossibleDuplicates, getCustomer, listCustomers } from "@/lib/db/customers";
import { findEventForStay, getEvent, listEvents, listUpcomingEvents, priorYearPrices } from "@/lib/db/events";
import { listProperties } from "@/lib/db/properties";
import { parseLogStayInput } from "@/lib/services/stay-input";
import {
  editStay,
  getStayWithPayments,
  listStays,
  logStay,
  previewStay,
  recordStayPayment,
  refreshStayPaths,
  setStayStatus,
  StayError,
} from "@/lib/services/stays";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * MCP server for Suite South, served over Streamable HTTP at /api/mcp.
 * Same bearer key as the REST API. Every tool calls the shared service layer,
 * so a stay logged from Grok follows exactly the rules the website enforces.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const failure = (e: unknown) => {
  const payload =
    e instanceof StayError
      ? { error: e.message, code: e.code, ...e.details }
      : { error: "Something went wrong.", detail: e instanceof Error ? e.message : String(e) };
  return { ...text(payload), isError: true };
};

async function run<T>(fn: () => Promise<T>) {
  try {
    return text(await fn());
  } catch (e) {
    return failure(e);
  }
}

const mcp = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_properties",
      {
        title: "List properties",
        description: "The three condos, with their current turnaround days and rate terms.",
        inputSchema: z.object({}),
      },
      async () => run(() => listProperties()),
    );

    server.registerTool(
      "check_availability",
      {
        title: "Check availability",
        description:
          "For a check-in/check-out window, says which condos are free, who is in the way otherwise, the matching event and its suggested rate, and what prior years paid for the same event.",
        inputSchema: z.object({
          check_in: date,
          check_out: date,
          event_id: z.string().optional().describe("Force a specific event instead of auto-matching."),
        }),
      },
      async ({ check_in, check_out, event_id }) =>
        run(async () => {
          if (nightsBetween(check_in, check_out) <= 0) {
            throw new StayError("invalid", "check_out must be after check_in.");
          }
          const event = event_id ? await getEvent(event_id) : await findEventForStay(check_in, check_out);
          if (event_id && !event) throw new StayError("not_found", `Unknown event "${event_id}".`);
          const priorYears = event ? await priorYearPrices(event.name, event.year) : [];
          const rows = await checkAvailability({ checkIn: check_in, checkOut: check_out, event, priorYears });
          return {
            checkIn: check_in,
            checkOut: check_out,
            nights: nightsBetween(check_in, check_out),
            event: event ? { id: event.id, name: event.name, year: event.year } : null,
            properties: rows.map((p) => ({
              id: p.property.id,
              name: p.property.name,
              available: p.available,
              conflicts: p.conflicts,
              suggestedRate: p.suggestedRate,
              rateSource: p.rateSource,
              priorYears: p.priorYears,
            })),
          };
        }),
    );

    server.registerTool(
      "list_stays",
      {
        title: "List stays",
        description:
          "Stays, newest check-in first. Filter by property (id or name), customer, event, date window, or derived state (hold, committed, booked, confirmed, cancelled).",
        inputSchema: z.object({
          property: z.string().optional(),
          customer_id: z.string().optional(),
          event_id: z.string().optional(),
          from: date.optional().describe("Include stays checking out on or after this date."),
          to: date.optional().describe("Include stays checking in on or before this date."),
          state: z.enum(["hold", "committed", "booked", "confirmed", "cancelled"]).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        }),
      },
      async (args) =>
        run(() =>
          listStays({
            propertyId: args.property,
            customerId: args.customer_id,
            eventId: args.event_id,
            from: args.from,
            to: args.to,
            state: args.state,
            limit: args.limit ?? 50,
          }),
        ),
    );

    server.registerTool(
      "get_stay",
      {
        title: "Get stay",
        description: "One stay with its money split, statuses, derived state, and payments.",
        inputSchema: z.object({ id: z.string() }),
      },
      async ({ id }) => run(() => getStayWithPayments(id)),
    );

    const logStaySchema = z.object({
      property: z.string().describe("Property id or name, e.g. 'The Kerry'."),
      check_in: date,
      check_out: date,
      room_revenue: z.number().min(0).describe("Total revenue for the WHOLE stay, not per night."),
      customer_id: z.string().optional().describe("An existing customer. Omit to create one from customer."),
      customer: z
        .object({
          last_name: z.string(),
          first_name: z.string().optional(),
          phone: z.string().optional(),
          email: z.string().optional(),
        })
        .optional(),
      nights: z.number().int().min(1).optional().describe("Defaults to the nights between the dates."),
      fees: z.number().min(0).optional(),
      tax_amount: z.number().min(0).optional(),
      amount_received: z.number().min(0).optional(),
      notes: z.string().optional(),
      confirmed: z.boolean().optional().describe("Contract signed and paid in full at entry."),
      event_id: z.string().nullable().optional().describe("Omit to auto-match the overlapping event; null for none."),
      acknowledge_overlap: z.boolean().optional().describe("Save even though the dates overlap another stay."),
    });

    server.registerTool(
      "preview_stay",
      {
        title: "Preview a stay",
        description:
          "Computes the money split, matched event and any date overlaps for a stay WITHOUT saving. Call this first, show the user the numbers, then call log_stay.",
        inputSchema: logStaySchema,
      },
      async (args) =>
        run(async () => {
          const parsed = parseLogStayInput(args);
          if (!parsed.ok) throw new StayError("invalid", "Check the input.", { errors: parsed.errors });
          const p = await previewStay(parsed.value);
          return {
            property: { id: p.property.id, name: p.property.name },
            nights: p.nights,
            calc: p.calc,
            event: p.event ? { id: p.event.id, name: p.event.name, year: p.event.year } : null,
            warnings: p.warnings,
            conflicts: p.conflicts,
          };
        }),
    );

    server.registerTool(
      "log_stay",
      {
        title: "Log a stay",
        description:
          "Saves a stay. Use preview_stay first and confirm the figures with the user. If the dates overlap another stay the call fails with code 'conflict' and the warnings; only resend with acknowledge_overlap=true after the user agrees.",
        inputSchema: logStaySchema,
      },
      async (args) =>
        run(async () => {
          const parsed = parseLogStayInput(args);
          if (!parsed.ok) throw new StayError("invalid", "Check the input.", { errors: parsed.errors });
          return logStay(parsed.value);
        }),
    );

    server.registerTool(
      "update_stay",
      {
        title: "Update a stay",
        description:
          "Edits the event, turnaround days, lifecycle (hold, active, cancelled), hold expiry or notes. Dates, property and revenue are frozen once logged. To cancel a stay set lifecycle to 'cancelled'; it keeps the history and stops blocking dates.",
        inputSchema: z.object({
          id: z.string(),
          event_id: z.string().nullable().optional(),
          turnaround_days: z.number().int().min(0).optional(),
          lifecycle: z.enum(["hold", "active", "cancelled"]).optional(),
          hold_expires_at: date.nullable().optional(),
          notes: z.string().nullable().optional(),
        }),
      },
      async ({ id, ...rest }) =>
        run(() =>
          editStay(id, {
            eventId: rest.event_id,
            turnaroundDays: rest.turnaround_days,
            lifecycle: rest.lifecycle,
            holdExpiresAt: rest.hold_expires_at,
            notes: rest.notes,
          }),
        ),
    );

    server.registerTool(
      "set_stay_status",
      {
        title: "Set contract / invoice status",
        description:
          "Moves the contract track (not_sent, sent, signed, standing) and/or the invoice track (not_sent, sent, deposit_received, paid_in_full). paid_in_full records the outstanding balance as a payment.",
        inputSchema: z.object({
          id: z.string(),
          contract_status: z.enum(["not_sent", "sent", "signed", "standing"]).optional(),
          invoice_status: z.enum(["not_sent", "sent", "deposit_received", "paid_in_full"]).optional(),
        }),
      },
      async ({ id, contract_status, invoice_status }) =>
        run(() => setStayStatus(id, { contractStatus: contract_status, invoiceStatus: invoice_status })),
    );

    server.registerTool(
      "record_payment",
      {
        title: "Record a payment",
        description: "Adds a payment to a stay. received_at defaults to today.",
        inputSchema: z.object({
          id: z.string(),
          amount: z.number().positive(),
          received_at: date.optional(),
          note: z.string().optional(),
        }),
      },
      async ({ id, amount, received_at, note }) =>
        run(() => recordStayPayment(id, { amount, receivedAt: received_at ?? null, note: note ?? null })),
    );

    server.registerTool(
      "find_customers",
      {
        title: "Find customers",
        description: "Search guests by name or phone. Most recent guests first; empty search lists everyone.",
        inputSchema: z.object({ search: z.string().optional() }),
      },
      async ({ search }) => run(() => listCustomers(search)),
    );

    server.registerTool(
      "create_customer",
      {
        title: "Create a customer",
        description:
          "Adds a guest. If a similar guest exists the call fails with code 'conflict' and the matches; use one of their ids or resend with acknowledge_duplicate=true.",
        inputSchema: z.object({
          last_name: z.string(),
          first_name: z.string().optional(),
          phone: z.string().optional(),
          email: z.string().optional(),
          address: z.string().optional(),
          notes: z.string().optional(),
          has_standing_contract: z.boolean().optional(),
          acknowledge_duplicate: z.boolean().optional(),
        }),
      },
      async (args) =>
        run(async () => {
          const input = {
            firstName: args.first_name?.trim() || null,
            lastName: args.last_name.trim(),
            phone: args.phone?.trim() || null,
            email: args.email?.trim() || null,
            address: args.address?.trim() || null,
            notes: args.notes?.trim() || null,
            hasStandingContract: args.has_standing_contract ?? false,
          };
          if (!input.lastName) throw new StayError("invalid", "last_name is required.");
          if (!args.acknowledge_duplicate) {
            const dupes = await findPossibleDuplicates(input);
            if (dupes.length) {
              throw new StayError("conflict", "A similar customer already exists.", { duplicates: dupes });
            }
          }
          const id = await createCustomer(input);
          refreshStayPaths();
          return getCustomer(id);
        }),
    );

    server.registerTool(
      "list_events",
      {
        title: "List events",
        description: "Named weekends with suggested rates. Defaults to upcoming events; pass a year for history.",
        inputSchema: z.object({
          year: z.number().int().optional(),
          month: z.number().int().min(1).max(12).optional(),
        }),
      },
      async ({ year, month }) =>
        run(() => (year || month ? listEvents({ year, month }) : listUpcomingEvents(todayLocal()))),
    );

    server.registerTool(
      "today",
      {
        title: "Today's date",
        description: "The server's current date as YYYY-MM-DD, for resolving words like 'next weekend'.",
        inputSchema: z.object({}),
      },
      async () => text({ today: todayLocal(), valid: isValidDate(todayLocal()) }),
    );
  },
  {
    serverInfo: { name: "suitesouth-booking", version: "1.0.0" },
    instructions:
      "Suite South manages three short-term rental condos. Money is entered as the TOTAL revenue for a stay, never per night. Before log_stay, call preview_stay and show the user the split and any overlap warnings; only pass acknowledge_overlap after they agree. Dates, property and revenue cannot change after a stay is logged; cancel and re-log instead.",
  },
);

/** Plain 401 on a bad key. No OAuth challenge, so clients do not try to start one. */
async function handler(request: Request): Promise<Response> {
  const auth = checkApiKey(request);
  if (!auth.ok) {
    return Response.json({ error: auth.message }, { status: auth.status });
  }
  return mcp(request);
}

export { handler as GET, handler as POST, handler as DELETE };

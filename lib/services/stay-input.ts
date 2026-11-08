/**
 * Pure parsing for machine-submitted stays. No database and no framework, so
 * the REST route, the MCP tool, and the check script all run the same rules.
 *
 * Field names accept both snake_case (what a REST client sends) and camelCase
 * (what the MCP tool schema produces).
 */
import { isValidDate } from "../dates.ts";
import { nightsBetween } from "../calc.ts";

export type NewCustomerInput = {
  firstName: string | null;
  lastName: string;
  phone: string | null;
  email: string | null;
};

export type LogStayInput = {
  /** Property id or name; resolved by the service. */
  property: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  roomRevenue: number;
  fees: number;
  taxAmount: number | null;
  amountReceived: number;
  notes: string | null;
  confirmed: boolean;
  /** Exactly one of these is set after parsing. */
  customerId: string | null;
  newCustomer: NewCustomerInput | null;
  /** Explicit event, or undefined to auto-match the overlapping event. */
  eventId: string | null | undefined;
  /** Save even when the dates collide with another stay. */
  acknowledgeOverlap: boolean;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type Raw = Record<string, unknown>;

function pick(raw: Raw, ...names: string[]): unknown {
  for (const n of names) if (raw[n] !== undefined) return raw[n];
  return undefined;
}

function textOf(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

/** Accepts 1250, "1,250.00" or "$1250". NaN when it is not a non-negative number. */
export function parseAmount(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : NaN;
  const raw = String(v).replace(/[$,\s]/g, "");
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function parseBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = textOf(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function parseLogStayInput(input: unknown): ParseResult<LogStayInput> {
  const errors: string[] = [];
  const raw: Raw = input && typeof input === "object" ? (input as Raw) : {};

  const property = textOf(pick(raw, "property", "property_id", "propertyId", "property_name"));
  if (!property) errors.push("property is required (id or name).");

  const checkIn = textOf(pick(raw, "check_in", "checkIn"));
  const checkOut = textOf(pick(raw, "check_out", "checkOut"));
  if (!isValidDate(checkIn)) errors.push("check_in must be a YYYY-MM-DD date.");
  if (!isValidDate(checkOut)) errors.push("check_out must be a YYYY-MM-DD date.");

  let nights = 0;
  if (isValidDate(checkIn) && isValidDate(checkOut)) {
    const computed = nightsBetween(checkIn, checkOut);
    if (computed <= 0) {
      errors.push("check_out must be after check_in.");
    } else {
      const nightsRaw = pick(raw, "nights");
      nights = nightsRaw === undefined || nightsRaw === null || nightsRaw === "" ? computed : Number(nightsRaw);
      if (!Number.isInteger(nights) || nights <= 0) errors.push("nights must be a whole number above zero.");
    }
  }

  const roomRevenue = parseAmount(pick(raw, "room_revenue", "roomRevenue", "revenue"));
  if (Number.isNaN(roomRevenue)) errors.push("room_revenue must be a non-negative number.");
  if (pick(raw, "room_revenue", "roomRevenue", "revenue") === undefined) {
    errors.push("room_revenue is required (total for the whole stay).");
  }

  const fees = parseAmount(pick(raw, "fees"));
  if (Number.isNaN(fees)) errors.push("fees must be a non-negative number.");

  const taxRaw = pick(raw, "tax_amount", "taxAmount");
  const taxAmount = taxRaw === undefined || taxRaw === null || taxRaw === "" ? null : parseAmount(taxRaw);
  if (taxAmount !== null && Number.isNaN(taxAmount)) errors.push("tax_amount must be a non-negative number.");

  const amountReceived = parseAmount(pick(raw, "amount_received", "amountReceived"));
  if (Number.isNaN(amountReceived)) errors.push("amount_received must be a non-negative number.");

  const customerId = textOf(pick(raw, "customer_id", "customerId")) || null;
  const customerRaw = pick(raw, "customer", "new_customer", "newCustomer");
  let newCustomer: NewCustomerInput | null = null;
  if (!customerId) {
    const c: Raw = customerRaw && typeof customerRaw === "object" ? (customerRaw as Raw) : raw;
    const lastName = textOf(pick(c, "last_name", "lastName", "new_last_name"));
    const firstName = textOf(pick(c, "first_name", "firstName", "new_first_name")) || null;
    if (!lastName) {
      errors.push("Either customer_id or a customer with last_name is required.");
    } else {
      newCustomer = {
        firstName,
        lastName,
        phone: textOf(pick(c, "phone", "new_phone")) || null,
        email: textOf(pick(c, "email")) || null,
      };
    }
  }

  const eventRaw = pick(raw, "event_id", "eventId");
  const eventId = eventRaw === undefined ? undefined : textOf(eventRaw) || null;

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      property,
      checkIn,
      checkOut,
      nights,
      roomRevenue,
      fees,
      taxAmount,
      amountReceived,
      notes: textOf(pick(raw, "notes")) || null,
      confirmed: parseBool(pick(raw, "confirmed")),
      customerId,
      newCustomer,
      eventId,
      acknowledgeOverlap: parseBool(pick(raw, "acknowledge_overlap", "acknowledgeOverlap", "confirm_overlap")),
    },
  };
}

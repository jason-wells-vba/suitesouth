import "server-only";
import { revalidatePath } from "next/cache";
import { calculate, type CalcResult } from "../calc.ts";
import { formatRange, isValidDate, todayLocal } from "../dates.ts";
import {
  CONTRACT_STATUSES,
  INVOICE_STATUSES,
  LIFECYCLES,
  STATE_LABELS,
  deriveState,
  type ContractStatus,
  type DerivedState,
  type InvoiceStatus,
  type Lifecycle,
} from "../booking-state.ts";
import { findConflicts, type Conflict } from "../availability.ts";
import {
  addPayment,
  deletePayment,
  getBooking,
  insertBooking,
  listBookings,
  listPayments,
  setContractStatus,
  setInvoiceStatus,
  updateBooking,
  type BookingFilters,
} from "../db/bookings.ts";
import { createCustomer, getCustomer } from "../db/customers.ts";
import { findEventForStay, getEvent } from "../db/events.ts";
import { listProperties } from "../db/properties.ts";
import { loadSettings } from "../db/settings.ts";
import type { Booking, EventRecord, Payment, Property } from "../types.ts";
import type { LogStayInput } from "./stay-input.ts";

/**
 * One place for the rules that used to live inside the site's form handler, so
 * the website, the REST API and the MCP tools cannot drift apart.
 */

export type StayErrorCode = "invalid" | "not_found" | "conflict";

export class StayError extends Error {
  constructor(
    public readonly code: StayErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "StayError";
  }
}

export type StayView = Booking & { state: DerivedState; stateLabel: string };

export async function withState(bookings: Booking[]): Promise<StayView[]> {
  const settings = await loadSettings();
  return bookings.map((b) => {
    const state = deriveState(b, { requireSignatureForBooked: settings.requireSignatureForBooked });
    return { ...b, state, stateLabel: STATE_LABELS[state] };
  });
}

/** Matches on id first, then case-insensitive name, with or without "The". */
export async function resolveProperty(idOrName: string): Promise<Property> {
  const properties = await listProperties();
  const wanted = idOrName.trim().toLowerCase();
  const strip = (s: string) => s.toLowerCase().replace(/^the\s+/, "").trim();
  const found =
    properties.find((p) => p.id === idOrName) ??
    properties.find((p) => p.name.toLowerCase() === wanted) ??
    properties.find((p) => strip(p.name) === strip(wanted));
  if (!found) {
    throw new StayError("not_found", `Unknown property "${idOrName}".`, {
      properties: properties.map((p) => ({ id: p.id, name: p.name })),
    });
  }
  return found;
}

export function describeConflict(property: Property, c: Conflict): string {
  return `${property.name} overlaps ${c.customerName}, ${formatRange(c.checkIn, c.checkOut)} (${STATE_LABELS[c.state]})`;
}

export type StayPreview = {
  property: Property;
  nights: number;
  calc: CalcResult;
  event: EventRecord | null;
  conflicts: Conflict[];
  warnings: string[];
};

/** Everything a caller wants to see before committing: the split and any overlaps. */
export async function previewStay(input: LogStayInput): Promise<StayPreview> {
  const property = await resolveProperty(input.property);

  const calc = calculate({
    ownerSharePct: property.ownerSharePct,
    commissionPct: property.commissionPct,
    feeTreatment: property.feeTreatment,
    roomRevenue: input.roomRevenue,
    nights: input.nights,
    fees: input.fees,
    taxAmount: input.taxAmount,
  });

  let event: EventRecord | null = null;
  if (input.eventId === undefined) {
    event = await findEventForStay(input.checkIn, input.checkOut);
  } else if (input.eventId) {
    event = await getEvent(input.eventId);
    if (!event) throw new StayError("not_found", `Unknown event "${input.eventId}".`);
  }

  const conflicts = await findConflicts({
    propertyId: property.id,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    turnaroundDays: property.turnaroundDays,
  });

  return {
    property,
    nights: input.nights,
    calc,
    event,
    conflicts,
    warnings: conflicts.map((c) => describeConflict(property, c)),
  };
}

export type LogStayResult = { id: string; stay: StayView; warnings: string[]; customerCreated: boolean };

/**
 * Overlaps warn but never block. Without `acknowledgeOverlap` the save is
 * refused with a `conflict` error carrying the warnings, so a caller has to
 * see them once before saving anyway.
 */
export async function logStay(input: LogStayInput): Promise<LogStayResult> {
  const preview = await previewStay(input);

  if (preview.conflicts.length > 0 && !input.acknowledgeOverlap) {
    throw new StayError("conflict", "These dates overlap another stay.", {
      warnings: preview.warnings,
      conflicts: preview.conflicts,
      hint: "Resend with acknowledge_overlap=true to save anyway.",
    });
  }

  let customerId = input.customerId;
  let customerCreated = false;
  if (customerId) {
    if (!(await getCustomer(customerId))) {
      throw new StayError("not_found", `Unknown customer "${customerId}".`);
    }
  } else if (input.newCustomer) {
    customerId = await createCustomer({
      ...input.newCustomer,
      address: null,
      notes: null,
      // A brand-new guest has no standing agreement; set it on their record later.
      hasStandingContract: false,
    });
    customerCreated = true;
  } else {
    throw new StayError("invalid", "A customer is required.");
  }

  const id = await insertBooking({
    propertyId: preview.property.id,
    customerId,
    eventId: preview.event?.id ?? null,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    roomRevenue: input.roomRevenue,
    nights: input.nights,
    fees: input.fees,
    taxAmount: input.taxAmount,
    amountReceived: input.amountReceived,
    notes: input.notes,
    confirmed: input.confirmed,
  });

  refreshStayPaths(id);
  const stay = await requireStay(id);
  return { id, stay, warnings: preview.warnings, customerCreated };
}

export async function requireStay(id: string): Promise<StayView> {
  const booking = isValidUuid(id) ? await getBooking(id) : null;
  if (!booking) throw new StayError("not_found", `No stay with id "${id}".`);
  const [view] = await withState([booking]);
  return view;
}

export async function getStayWithPayments(id: string): Promise<{ stay: StayView; payments: Payment[] }> {
  const stay = await requireStay(id);
  const payments = await listPayments(id);
  return { stay, payments };
}

export type ListStaysOptions = BookingFilters & { state?: DerivedState; limit?: number };

export async function listStays(opts: ListStaysOptions = {}): Promise<StayView[]> {
  for (const [name, value] of [["from", opts.from], ["to", opts.to]] as const) {
    if (value && !isValidDate(value)) throw new StayError("invalid", `${name} must be a YYYY-MM-DD date.`);
  }
  if (opts.propertyId) opts = { ...opts, propertyId: (await resolveProperty(opts.propertyId)).id };

  let stays = await withState(await listBookings(opts));
  if (opts.state) stays = stays.filter((s) => s.state === opts.state);
  if (opts.limit && opts.limit > 0) stays = stays.slice(0, opts.limit);
  return stays;
}

export type StayPatch = {
  eventId?: string | null;
  turnaroundDays?: number;
  lifecycle?: Lifecycle;
  holdExpiresAt?: string | null;
  notes?: string | null;
};

/**
 * Dates, property and money are frozen once a stay is logged, the same rule the
 * site follows: the split was computed from the terms in force at entry.
 */
export async function editStay(id: string, patch: StayPatch): Promise<StayView> {
  const current = await requireStay(id);

  if (patch.lifecycle !== undefined && !LIFECYCLES.includes(patch.lifecycle)) {
    throw new StayError("invalid", `lifecycle must be one of ${LIFECYCLES.join(", ")}.`);
  }
  if (patch.turnaroundDays !== undefined) {
    if (!Number.isInteger(patch.turnaroundDays) || patch.turnaroundDays < 0) {
      throw new StayError("invalid", "turnaround_days must be a whole number of zero or more.");
    }
  }
  if (patch.holdExpiresAt && !isValidDate(patch.holdExpiresAt)) {
    throw new StayError("invalid", "hold_expires_at must be a YYYY-MM-DD date.");
  }
  if (patch.eventId && !(await getEvent(patch.eventId))) {
    throw new StayError("not_found", `Unknown event "${patch.eventId}".`);
  }

  await updateBooking(id, {
    eventId: patch.eventId === undefined ? current.eventId : patch.eventId,
    turnaroundDays: patch.turnaroundDays ?? current.turnaroundDays,
    lifecycle: patch.lifecycle ?? current.lifecycle,
    holdExpiresAt: patch.holdExpiresAt === undefined ? current.holdExpiresAt : patch.holdExpiresAt,
    notes: patch.notes === undefined ? current.notes : patch.notes,
  });
  refreshStayPaths(id);
  return requireStay(id);
}

export async function setStayStatus(
  id: string,
  status: { contractStatus?: string; invoiceStatus?: string },
): Promise<StayView> {
  await requireStay(id);
  const { contractStatus, invoiceStatus } = status;
  if (contractStatus === undefined && invoiceStatus === undefined) {
    throw new StayError("invalid", "Provide contract_status, invoice_status, or both.");
  }
  if (contractStatus !== undefined && !CONTRACT_STATUSES.includes(contractStatus as ContractStatus)) {
    throw new StayError("invalid", `contract_status must be one of ${CONTRACT_STATUSES.join(", ")}.`);
  }
  if (invoiceStatus !== undefined && !INVOICE_STATUSES.includes(invoiceStatus as InvoiceStatus)) {
    throw new StayError("invalid", `invoice_status must be one of ${INVOICE_STATUSES.join(", ")}.`);
  }
  if (contractStatus !== undefined) await setContractStatus(id, contractStatus as ContractStatus);
  if (invoiceStatus !== undefined) await setInvoiceStatus(id, invoiceStatus as InvoiceStatus);
  refreshStayPaths(id);
  return requireStay(id);
}

export async function recordStayPayment(
  id: string,
  payment: { amount: unknown; receivedAt?: string | null; note?: string | null },
): Promise<{ stay: StayView; payments: Payment[] }> {
  await requireStay(id);
  const amount =
    typeof payment.amount === "number"
      ? payment.amount
      : Number(String(payment.amount ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new StayError("invalid", "amount must be a number above zero.");
  }
  const receivedAt = payment.receivedAt || todayLocal();
  if (!isValidDate(receivedAt)) throw new StayError("invalid", "received_at must be a YYYY-MM-DD date.");

  await addPayment(id, amount, receivedAt, payment.note || null);
  refreshStayPaths(id);
  return getStayWithPayments(id);
}

export async function removeStayPayment(id: string, paymentId: string): Promise<{ stay: StayView; payments: Payment[] }> {
  await requireStay(id);
  const payments = await listPayments(id);
  if (!payments.some((p) => p.id === paymentId)) {
    throw new StayError("not_found", `No payment "${paymentId}" on this stay.`);
  }
  await deletePayment(paymentId);
  refreshStayPaths(id);
  return getStayWithPayments(id);
}

/** The site caches its pages; a change made through the API has to show up there too. */
export function refreshStayPaths(id?: string): void {
  if (id) revalidatePath(`/stays/${id}`);
  for (const p of ["/", "/stays", "/calendar", "/availability", "/customers"]) revalidatePath(p);
}

function isValidUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

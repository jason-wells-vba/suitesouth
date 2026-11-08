import { field, json, optionalText, protectedRoute, readBody } from "@/lib/api/http";
import { editStay, getStayWithPayments, type StayPatch } from "@/lib/services/stays";
import type { Lifecycle } from "@/lib/booking-state";

export const dynamic = "force-dynamic";

type Params = { id: string };

/** GET /api/v1/stays/:id — the stay plus its payments. */
export const GET = protectedRoute<Params>(async (_request, { id }) => {
  return json(await getStayWithPayments(id));
});

/**
 * PATCH /api/v1/stays/:id
 * Editable: event_id, turnaround_days, lifecycle (hold|active|cancelled),
 * hold_expires_at, notes. Dates, property and money are frozen at entry.
 */
export const PATCH = protectedRoute<Params>(async (request, { id }) => {
  const body = await readBody(request);
  const patch: StayPatch = {};

  const eventId = optionalText(field(body, "event_id", "eventId"));
  if (eventId !== undefined) patch.eventId = eventId;

  const turnaround = field(body, "turnaround_days", "turnaroundDays");
  if (turnaround !== undefined) patch.turnaroundDays = Number(turnaround);

  const lifecycle = optionalText(field(body, "lifecycle", "lifecycle"));
  if (lifecycle) patch.lifecycle = lifecycle as Lifecycle;

  const holdExpires = optionalText(field(body, "hold_expires_at", "holdExpiresAt"));
  if (holdExpires !== undefined) patch.holdExpiresAt = holdExpires;

  const notes = optionalText(field(body, "notes", "notes"));
  if (notes !== undefined) patch.notes = notes;

  return json({ stay: await editStay(id, patch) });
});

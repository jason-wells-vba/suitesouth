import { json, protectedRoute, query, readBody } from "@/lib/api/http";
import { parseLogStayInput } from "@/lib/services/stay-input";
import { listStays, logStay, previewStay, StayError } from "@/lib/services/stays";
import type { DerivedState } from "@/lib/booking-state";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/stays?property=&customer_id=&event_id=&from=&to=&state=&limit=
 * `property` takes an id or a name. `state` is the derived state
 * (hold, committed, booked, confirmed, cancelled).
 */
export const GET = protectedRoute(async (request) => {
  const q = query(request);
  const limit = Number(q.get("limit") ?? "");
  const stays = await listStays({
    propertyId: q.get("property") ?? q.get("property_id") ?? undefined,
    customerId: q.get("customer_id") ?? undefined,
    eventId: q.get("event_id") ?? undefined,
    from: q.get("from") ?? undefined,
    to: q.get("to") ?? undefined,
    state: (q.get("state") as DerivedState | null) ?? undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  return json({ stays });
});

/**
 * POST /api/v1/stays
 * Logs a stay. Pass `preview: true` to get the computed split and any overlaps
 * without saving. Overlapping dates answer 409 until `acknowledge_overlap` is true.
 */
export const POST = protectedRoute(async (request) => {
  const body = await readBody(request);
  const parsed = parseLogStayInput(body);
  if (!parsed.ok) throw new StayError("invalid", "Check the request.", { errors: parsed.errors });

  if (body.preview === true) {
    const p = await previewStay(parsed.value);
    return json({
      preview: true,
      property: { id: p.property.id, name: p.property.name },
      nights: p.nights,
      calc: p.calc,
      event: p.event ? { id: p.event.id, name: p.event.name, year: p.event.year } : null,
      warnings: p.warnings,
      conflicts: p.conflicts,
    });
  }

  const result = await logStay(parsed.value);
  return json(result, 201);
});

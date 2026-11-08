import { json, protectedRoute, query } from "@/lib/api/http";
import { checkAvailability } from "@/lib/availability";
import { isValidDate } from "@/lib/dates";
import { nightsBetween } from "@/lib/calc";
import { findEventForStay, getEvent, priorYearPrices } from "@/lib/db/events";
import { StayError } from "@/lib/services/stays";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/availability?check_in=YYYY-MM-DD&check_out=YYYY-MM-DD[&event_id=]
 * Authenticated, so unlike /api/public/availability it says who is in the way,
 * what the matching event suggests as a rate, and what prior years paid.
 */
export const GET = protectedRoute(async (request) => {
  const q = query(request);
  const checkIn = q.get("check_in") ?? q.get("from") ?? "";
  const checkOut = q.get("check_out") ?? q.get("to") ?? "";
  if (!isValidDate(checkIn) || !isValidDate(checkOut)) {
    throw new StayError("invalid", "check_in and check_out must be YYYY-MM-DD dates.");
  }
  if (nightsBetween(checkIn, checkOut) <= 0) {
    throw new StayError("invalid", "check_out must be after check_in.");
  }

  const eventId = q.get("event_id");
  const event = eventId ? await getEvent(eventId) : await findEventForStay(checkIn, checkOut);
  if (eventId && !event) throw new StayError("not_found", `Unknown event "${eventId}".`);

  const priorYears = event ? await priorYearPrices(event.name, event.year) : [];
  const properties = await checkAvailability({ checkIn, checkOut, event, priorYears });

  return json({
    checkIn,
    checkOut,
    nights: nightsBetween(checkIn, checkOut),
    event: event ? { id: event.id, name: event.name, year: event.year, suggestedRate: event.suggestedRate } : null,
    properties: properties.map((p) => ({
      id: p.property.id,
      name: p.property.name,
      turnaroundDays: p.property.turnaroundDays,
      available: p.available,
      conflicts: p.conflicts,
      suggestedRate: p.suggestedRate,
      rateSource: p.rateSource,
      priorYears: p.priorYears,
    })),
  });
});

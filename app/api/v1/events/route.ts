import { json, protectedRoute, query } from "@/lib/api/http";
import { listEvents, listUpcomingEvents } from "@/lib/db/events";
import { todayLocal } from "@/lib/dates";

export const dynamic = "force-dynamic";

/** GET /api/v1/events?year=&month=   or   ?upcoming=true */
export const GET = protectedRoute(async (request) => {
  const q = query(request);
  if (q.get("upcoming") === "true") {
    return json({ events: await listUpcomingEvents(todayLocal()) });
  }
  const year = Number(q.get("year"));
  const month = Number(q.get("month"));
  const events = await listEvents({
    year: Number.isInteger(year) && year > 0 ? year : undefined,
    month: Number.isInteger(month) && month > 0 ? month : undefined,
  });
  return json({ events });
});

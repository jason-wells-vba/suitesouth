import { json, protectedRoute } from "@/lib/api/http";
import { listProperties } from "@/lib/db/properties";

export const dynamic = "force-dynamic";

/** GET /api/v1/properties — the condos, with current rate terms and turnaround. */
export const GET = protectedRoute(async () => {
  return json({ properties: await listProperties() });
});

import { field, json, optionalText, protectedRoute, query, readBody } from "@/lib/api/http";
import { createCustomer, findPossibleDuplicates, getCustomer, listCustomers } from "@/lib/db/customers";
import { refreshStayPaths, StayError } from "@/lib/services/stays";

export const dynamic = "force-dynamic";

/** GET /api/v1/customers?search=  — name or phone, most recent guests first. */
export const GET = protectedRoute(async (request) => {
  const search = query(request).get("search") ?? query(request).get("q") ?? undefined;
  return json({ customers: await listCustomers(search) });
});

/**
 * POST /api/v1/customers
 * { last_name, first_name?, phone?, email?, address?, notes?, has_standing_contract? }
 * Possible duplicates answer 409 until `acknowledge_duplicate` is true.
 */
export const POST = protectedRoute(async (request) => {
  const body = await readBody(request);
  const lastName = optionalText(field(body, "last_name", "lastName"));
  if (!lastName) throw new StayError("invalid", "last_name is required.");

  const input = {
    firstName: optionalText(field(body, "first_name", "firstName")) ?? null,
    lastName,
    phone: optionalText(body.phone) ?? null,
    email: optionalText(body.email) ?? null,
    address: optionalText(body.address) ?? null,
    notes: optionalText(body.notes) ?? null,
    hasStandingContract: field(body, "has_standing_contract", "hasStandingContract") === true,
  };

  if (field(body, "acknowledge_duplicate", "acknowledgeDuplicate") !== true) {
    const dupes = await findPossibleDuplicates(input);
    if (dupes.length > 0) {
      throw new StayError("conflict", "A similar customer already exists.", {
        duplicates: dupes,
        hint: "Use one of these ids as customer_id, or resend with acknowledge_duplicate=true.",
      });
    }
  }

  const id = await createCustomer(input);
  refreshStayPaths();
  return json({ customer: await getCustomer(id) }, 201);
});

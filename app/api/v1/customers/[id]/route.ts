import { field, json, optionalText, protectedRoute, readBody } from "@/lib/api/http";
import { getCustomer, updateCustomer } from "@/lib/db/customers";
import { listStays, refreshStayPaths, StayError } from "@/lib/services/stays";

export const dynamic = "force-dynamic";

type Params = { id: string };

/** GET /api/v1/customers/:id — the customer and their stays. */
export const GET = protectedRoute<Params>(async (_request, { id }) => {
  const customer = await getCustomer(id);
  if (!customer) throw new StayError("not_found", `No customer with id "${id}".`);
  const stays = await listStays({ customerId: id });
  return json({ customer, stays });
});

/** PATCH /api/v1/customers/:id — any subset of the customer fields. */
export const PATCH = protectedRoute<Params>(async (request, { id }) => {
  const current = await getCustomer(id);
  if (!current) throw new StayError("not_found", `No customer with id "${id}".`);
  const body = await readBody(request);

  const pick = (snake: string, camel: string, existing: string | null) => {
    const v = optionalText(field(body, snake, camel));
    return v === undefined ? existing : v;
  };
  const lastName = pick("last_name", "lastName", current.lastName);
  if (!lastName) throw new StayError("invalid", "last_name cannot be empty.");

  const standing = field(body, "has_standing_contract", "hasStandingContract");
  await updateCustomer(id, {
    firstName: pick("first_name", "firstName", current.firstName),
    lastName,
    phone: pick("phone", "phone", current.phone),
    email: pick("email", "email", current.email),
    address: pick("address", "address", current.address),
    notes: pick("notes", "notes", current.notes),
    hasStandingContract: typeof standing === "boolean" ? standing : current.hasStandingContract,
  });
  refreshStayPaths();
  return json({ customer: await getCustomer(id) });
});

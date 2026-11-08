import { field, json, optionalText, protectedRoute, readBody } from "@/lib/api/http";
import { getStayWithPayments, recordStayPayment } from "@/lib/services/stays";

export const dynamic = "force-dynamic";

type Params = { id: string };

/** GET /api/v1/stays/:id/payments */
export const GET = protectedRoute<Params>(async (_request, { id }) => {
  const { payments } = await getStayWithPayments(id);
  return json({ payments });
});

/** POST /api/v1/stays/:id/payments  { amount, received_at?: YYYY-MM-DD, note? } */
export const POST = protectedRoute<Params>(async (request, { id }) => {
  const body = await readBody(request);
  const result = await recordStayPayment(id, {
    amount: body.amount,
    receivedAt: optionalText(field(body, "received_at", "receivedAt")) ?? null,
    note: optionalText(body.note) ?? null,
  });
  return json(result, 201);
});

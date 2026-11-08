import { json, protectedRoute } from "@/lib/api/http";
import { removeStayPayment } from "@/lib/services/stays";

export const dynamic = "force-dynamic";

type Params = { id: string; paymentId: string };

/** DELETE /api/v1/stays/:id/payments/:paymentId */
export const DELETE = protectedRoute<Params>(async (_request, { id, paymentId }) => {
  return json(await removeStayPayment(id, paymentId));
});

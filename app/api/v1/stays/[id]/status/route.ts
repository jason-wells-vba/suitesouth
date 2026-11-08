import { field, json, optionalText, protectedRoute, readBody } from "@/lib/api/http";
import { setStayStatus } from "@/lib/services/stays";

export const dynamic = "force-dynamic";

type Params = { id: string };

/**
 * PUT /api/v1/stays/:id/status
 * { contract_status?: not_sent|sent|signed|standing,
 *   invoice_status?: not_sent|sent|deposit_received|paid_in_full }
 * Marking paid_in_full records the outstanding balance as a payment.
 */
export const PUT = protectedRoute<Params>(async (request, { id }) => {
  const body = await readBody(request);
  const stay = await setStayStatus(id, {
    contractStatus: optionalText(field(body, "contract_status", "contractStatus")) ?? undefined,
    invoiceStatus: optionalText(field(body, "invoice_status", "invoiceStatus")) ?? undefined,
  });
  return json({ stay });
});

export { PUT as PATCH };

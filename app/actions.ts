"use server";

import { redirect } from "next/navigation";
import {
  createSession,
  destroySession,
  isAuthenticated,
  requireAuth,
  verifyPassword,
} from "@/lib/auth";
import { parseLogStayInput } from "@/lib/services/stay-input";
import { logStay, StayError } from "@/lib/services/stays";

export type FormState = {
  ok: boolean;
  error: string | null;
  savedAt: number;
  /** Non-blocking overlap notices. Present means the save was held for a confirm. */
  warnings?: string[];
};

const fail = (error: string): FormState => ({ ok: false, error, savedAt: 0 });

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

export async function login(_prev: FormState, formData: FormData): Promise<FormState> {
  const password = String(formData.get("password") ?? "");

  let ok = false;
  try {
    ok = verifyPassword(password);
  } catch {
    return fail("Server is not configured: APP_PASSWORD is missing.");
  }
  if (!ok) return fail("Incorrect password.");

  await createSession();
  redirect("/");
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect("/login");
}

/** The parser's messages name API fields; the form says it the way the screen does. */
const FORM_MESSAGES: Record<string, string> = {
  "property is required (id or name).": "Pick a property.",
  "check_in must be a YYYY-MM-DD date.": "Both dates are required.",
  "check_out must be a YYYY-MM-DD date.": "Both dates are required.",
  "check_out must be after check_in.": "Check-out must be after check-in.",
  "nights must be a whole number above zero.": "Nights must be a whole number above zero.",
  "room_revenue must be a non-negative number.": "Amounts must be non-negative numbers.",
  "fees must be a non-negative number.": "Amounts must be non-negative numbers.",
  "tax_amount must be a non-negative number.": "Amounts must be non-negative numbers.",
  "amount_received must be a non-negative number.": "Amounts must be non-negative numbers.",
  "Either customer_id or a customer with last_name is required.": "A guest name is required.",
};

export async function createBooking(_prev: FormState, formData: FormData): Promise<FormState> {
  if (!(await isAuthenticated())) return fail("Session expired. Reload the page and sign in again.");

  // The same parser and rules the REST API and MCP tools use; only the field
  // names and the wording of errors are the form's own.
  const parsed = parseLogStayInput({
    property: text(formData, "property_id"),
    check_in: text(formData, "check_in"),
    check_out: text(formData, "check_out"),
    nights: text(formData, "nights") || undefined,
    room_revenue: text(formData, "room_revenue"),
    fees: text(formData, "fees"),
    tax_amount: text(formData, "tax_amount") || undefined,
    amount_received: text(formData, "amount_received"),
    customer_id: text(formData, "customer_id") || undefined,
    customer: {
      last_name: text(formData, "new_last_name"),
      first_name: text(formData, "new_first_name"),
      phone: text(formData, "new_phone"),
    },
    notes: text(formData, "notes"),
    confirmed: text(formData, "confirmed") === "1",
    acknowledge_overlap: Boolean(text(formData, "acknowledge_overlap")),
  });
  if (!parsed.ok) return fail(FORM_MESSAGES[parsed.errors[0]] ?? parsed.errors[0]);

  try {
    await logStay(parsed.value);
  } catch (error) {
    if (error instanceof StayError) {
      // Overlaps warn but never block. The first save is held so she can see the
      // conflict; pressing Save anyway comes back with the acknowledgement set.
      if (error.code === "conflict") {
        return { ok: false, error: null, savedAt: 0, warnings: error.details.warnings as string[] };
      }
      return fail(error.message);
    }
    console.error("createBooking failed", error);
    return fail("Could not save the booking. Check the connection and try again.");
  }

  return { ok: true, error: null, savedAt: Date.now() };
}

export async function requireSession(): Promise<void> {
  await requireAuth();
}

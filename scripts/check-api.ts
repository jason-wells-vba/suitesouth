// Assertions for the machine-facing stay parser shared by the REST API,
// the MCP tools and the website's Log a Stay form.
// Run with: npm run check:api
import { parseLogStayInput } from "../lib/services/stay-input.ts";

let failures = 0;

function eq(label: string, actual: unknown, want: unknown) {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}: got ${a}, want ${w}`);
}

const errorsOf = (input: unknown) => {
  const r = parseLogStayInput(input);
  return r.ok ? [] : r.errors;
};

console.log("\nMinimal REST body");
{
  const r = parseLogStayInput({
    property: "The Kerry",
    check_in: "2026-10-02",
    check_out: "2026-10-05",
    room_revenue: "1,250.00",
    customer: { last_name: "Smith" },
  });
  eq("parses", r.ok, true);
  if (r.ok) {
    eq("nights computed", r.value.nights, 3);
    eq("revenue stripped", r.value.roomRevenue, 1250);
    eq("fees default 0", r.value.fees, 0);
    eq("tax null when absent", r.value.taxAmount, null);
    eq("new customer", r.value.newCustomer, { firstName: null, lastName: "Smith", phone: null, email: null });
    eq("event auto-matches", r.value.eventId, undefined);
    eq("overlap not acknowledged", r.value.acknowledgeOverlap, false);
  }
}

console.log("\ncamelCase and MCP-style values");
{
  const r = parseLogStayInput({
    propertyId: "abc",
    checkIn: "2026-10-02",
    checkOut: "2026-10-03",
    roomRevenue: 500,
    customerId: "cust-1",
    customer: { last_name: "Ignored when customer_id is set" },
    eventId: null,
    confirmed: true,
    acknowledgeOverlap: "true",
    taxAmount: "",
  });
  eq("parses", r.ok, true);
  if (r.ok) {
    eq("customer id wins", [r.value.customerId, r.value.newCustomer], ["cust-1", null]);
    eq("explicit no event", r.value.eventId, null);
    eq("confirmed", r.value.confirmed, true);
    eq("overlap from string", r.value.acknowledgeOverlap, true);
    eq("empty tax is null", r.value.taxAmount, null);
  }
}

console.log("\nForm-shaped input (what app/actions.ts sends)");
{
  const r = parseLogStayInput({
    property: "prop-1",
    check_in: "2026-10-02",
    check_out: "2026-10-04",
    nights: undefined,
    room_revenue: "$2,000",
    fees: "",
    tax_amount: undefined,
    amount_received: "",
    customer_id: undefined,
    customer: { last_name: "Jones", first_name: "", phone: "" },
    notes: "",
    confirmed: false,
    acknowledge_overlap: false,
  });
  eq("parses", r.ok, true);
  if (r.ok) {
    eq("blank first name is null", r.value.newCustomer?.firstName, null);
    eq("blank notes are null", r.value.notes, null);
    eq("nights from dates", r.value.nights, 2);
  }
}

console.log("\nRejections");
{
  eq("missing everything", errorsOf({}).length > 0, true);
  eq("checkout before checkin", errorsOf({ property: "x", check_in: "2026-10-05", check_out: "2026-10-02", room_revenue: 1, customer: { last_name: "A" } }), ["check_out must be after check_in."]);
  eq("bad date", errorsOf({ property: "x", check_in: "10/02/2026", check_out: "2026-10-05", room_revenue: 1, customer: { last_name: "A" } }), ["check_in must be a YYYY-MM-DD date."]);
  eq("negative revenue", errorsOf({ property: "x", check_in: "2026-10-02", check_out: "2026-10-05", room_revenue: -5, customer: { last_name: "A" } }), ["room_revenue must be a non-negative number."]);
  eq("fractional nights", errorsOf({ property: "x", check_in: "2026-10-02", check_out: "2026-10-05", nights: 2.5, room_revenue: 1, customer: { last_name: "A" } }), ["nights must be a whole number above zero."]);
  eq("no customer", errorsOf({ property: "x", check_in: "2026-10-02", check_out: "2026-10-05", room_revenue: 1 }), ["Either customer_id or a customer with last_name is required."]);
  eq("missing revenue", errorsOf({ property: "x", check_in: "2026-10-02", check_out: "2026-10-05", customer: { last_name: "A" } }), ["room_revenue is required (total for the whole stay)."]);
}

console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);

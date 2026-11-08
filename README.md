# suitesouth

Suite South STR Booking. Fast booking entry for three short-term rental condos. Next.js App Router on Vercel, Neon Postgres, one shared password.

## Setup

1. **Database.** In the Vercel project, go to Storage, install **Neon** from the Marketplace, and connect it. That injects `DATABASE_URL` into the project automatically.

2. **Environment variables.** In Vercel, add these two alongside the injected `DATABASE_URL`:

   | Variable | Value |
   | --- | --- |
   | `APP_PASSWORD` | The shared password you both type to sign in |
   | `SESSION_SECRET` | A long random string. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

   For local work, copy `.env.example` to `.env.local` and fill in all three.

3. **Create the tables.** With `.env.local` pointing at the Neon database:

   ```bash
   npm run db:init
   ```

   This applies `db/schema.sql` and seeds the three properties. It is safe to re-run.

## REST API and MCP server

Machine access for scripts and AI assistants. Both use one bearer key, the `API_KEY`
environment variable, which is separate from the site password so either can be
rotated alone. Leave it unset and both endpoints answer 503.

Send the key as `Authorization: Bearer <key>` (or `x-api-key: <key>`). Bodies are JSON;
field names may be `snake_case` or `camelCase`. Dates are `YYYY-MM-DD`.

### REST, under `/api/v1`

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/properties` | The condos with rate terms and turnaround days |
| `GET` | `/availability?check_in=&check_out=[&event_id=]` | Per-condo availability with conflicts, matched event, suggested rate, prior-year prices |
| `GET` | `/stays?property=&customer_id=&event_id=&from=&to=&state=&limit=` | List stays. `property` is an id or a name; `state` is hold, committed, booked, confirmed or cancelled |
| `POST` | `/stays` | Log a stay (below). `"preview": true` returns the split and overlaps without saving |
| `GET` | `/stays/:id` | One stay with its payments |
| `PATCH` | `/stays/:id` | `event_id`, `turnaround_days`, `lifecycle`, `hold_expires_at`, `notes` |
| `PUT` | `/stays/:id/status` | `contract_status` and/or `invoice_status` |
| `GET` `POST` | `/stays/:id/payments` | List or record a payment: `amount`, `received_at?`, `note?` |
| `DELETE` | `/stays/:id/payments/:paymentId` | Remove a payment |
| `GET` `POST` | `/customers` | Search (`?search=`) or create. Possible duplicates answer 409 until `acknowledge_duplicate` is true |
| `GET` `PATCH` | `/customers/:id` | A customer and their stays; edit any field |
| `GET` | `/events?year=&month=` or `?upcoming=true` | Named weekends with suggested rates |

Logging a stay:

```json
POST /api/v1/stays
{
  "property": "The Kerry",
  "check_in": "2027-03-05",
  "check_out": "2027-03-08",
  "room_revenue": 1500,
  "customer": { "last_name": "Smith", "first_name": "Ann", "phone": "555-0100" },
  "confirmed": true
}
```

Pass `customer_id` instead of `customer` for an existing guest. The event is matched
automatically from the dates; send `event_id` to pick one or `null` for none. If the dates
overlap another stay the answer is `409` with the warnings, and nothing is saved until the
same request is resent with `"acknowledge_overlap": true`. That mirrors the website's
confirm step.

As on the site, a stay's dates, property and revenue are frozen once logged, because the
owner split was computed from the rate terms in force at entry. Cancel the stay
(`lifecycle: "cancelled"`) and log it again instead.

Errors come back as `{ "error": "...", ...details }` with `400` (invalid), `401` (key),
`404`, `409` (conflict) or `500`.

### MCP, at `/api/mcp`

A [Model Context Protocol](https://modelcontextprotocol.io) server over Streamable HTTP,
built with `mcp-handler`. Same key, same rules: every tool calls the service layer in
`lib/services/stays.ts` that the website and the REST routes use.

Tools: `list_properties`, `check_availability`, `list_stays`, `get_stay`, `preview_stay`,
`log_stay`, `update_stay`, `set_stay_status`, `record_payment`, `find_customers`,
`create_customer`, `list_events`, `today`. The server instructions tell the assistant to
call `preview_stay` and show the figures before `log_stay`, and `log_stay` refuses
overlapping dates until `acknowledge_overlap` is set. There is no delete tool.

To connect from Grok: grok.com, Connectors, New Connector, Custom, URL
`https://suitesouth.vanburenadvisory.com/api/mcp`, and the API key as a bearer token.
Any client that speaks Streamable HTTP (Claude, Cursor, `mcp-remote`) connects the same way.

The shared parsing has its own assertions: `npm run check:api`.

## Commands

```bash
npm run dev         # local dev server
npm run build       # production build
npm run db:init     # apply schema and seed properties
npm run check:calc  # assertions for the booking math
npm run typecheck   # tsc --noEmit
```

## How the money is calculated

The user enters **total revenue for the whole stay**, not a nightly rate. The nightly figure is derived for display only and is never the basis for any other number, so a rounded per-night value cannot skew a payout.

```
subtotal           = stay revenue as entered   (fees sit outside it by default)
nightly rate       = stay revenue / nights     (display only)
manager commission = subtotal x owner_share_pct x commission_pct
owner pool         = subtotal - manager commission
owner due          = owner pool x owner_share_pct
co-owner due       = owner pool - owner due
amount due         = subtotal + fees + tax
```

Commission comes off the top, then **the entire remainder splits by ownership share**.

**Rate terms are not in this repository.** The seed migration inserts placeholder percentages; the real owner share and commission for a deployment are set directly in the database after seeding. Everything below uses the placeholders.

| Property | owner_share_pct | commission_pct | Effective commission |
| --- | --- | --- | --- |
| The Stacy | 100 | 50 | 50% of subtotal |
| The Kerry | 100 | 50 | 50% of subtotal |
| The Cocktail | 80 | 50 | 40% of subtotal |

Worked example, a split-ownership property on $2,000 of stay revenue:

| | |
| --- | --- |
| Manager commission | $800.00 |
| Left to owners | $1,200.00 |
| Majority owner, 80% | $960.00 |
| Co-owner, 20% | $240.00 |

All arithmetic runs in integer cents and rounds once, and the co-owner share is derived by subtraction, so commission plus the owner pool always equals the subtotal exactly, and owner due plus co-owner due always equals the pool exactly.

### Rates are frozen onto each booking

`owner_share_pct`, `commission_pct`, and `fee_treatment` are copied onto the booking row at insert time, and every stored figure is computed from those copies. Nothing recalculates by joining back to `properties`. Changing a property's rate later affects only bookings entered after the change. Historical rows are immutable.

### Fees

Fees are not in use yet and default to zero. The schema carries a `fee_treatment` column on both tables, snapshotted per booking, so a fee can be introduced later without a migration and without disturbing history:

| `fee_treatment` | Effect |
| --- | --- |
| `manager` (default) | Manager retains it to cover a cost, such as card processing or insurance. Owners are unaffected. |
| `owner` | Passed through to the owners, added to the pool before the ownership split. |
| `commissionable` | Folded into the subtotal, so commission is charged on it. |

The guest pays the fee in all three cases. Only the destination differs.

## Auth

One shared password checked server-side against `APP_PASSWORD`, using a constant-time comparison. On success the server sets an httpOnly, SameSite=Lax session cookie holding an HMAC-signed timestamp, valid for 30 days.

Every page and every server action calls `requireAuth()` or `isAuthenticated()` directly rather than relying on a single middleware chokepoint, so there is no one place to bypass.

## Not built yet

Calendar sync, rate comparison, automatic tax calculation, owner statements, and per-user accounts. `tax_amount` is a nullable manual entry field.

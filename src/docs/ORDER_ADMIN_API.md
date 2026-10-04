# Order Admin API

Module: `src/modules/order/`
Base path: `/orders` (paths are shown as the app serves them — there is no global prefix; Nginx
prepends `/api` in production)
Access: ADMIN (`JwtAuthGuard` + `RolesGuard` + `@Roles(Role.ADMIN)`) for every route in the
table below. The module also exposes user-owned routes (`POST /orders`, `GET /orders/me`,
`GET /orders/me/:id`) and one public, token-protected route — see _Public endpoints_.
Customer-facing responses (`POST /orders`, `GET /orders/me*`) go through a customer
projection that omits `items[].vendor_sku` (the supplier article snapshot is for the admin
invoice and vendor e-mail only); admin routes return the full item. `POST /orders` also
refuses draft/archived variants (`400 VARIANT_UNAVAILABLE`) — they are hidden from every
public read and must not be orderable by id; see _`POST /orders` refusals_ below for the full
list of codes.

---

## Endpoints

| Method  | Path                         | Description                                                               |
| ------- | ---------------------------- | ------------------------------------------------------------------------- |
| `GET`   | `/orders`                    | Paginated orders list with filters by `order_status` and `payment_status` |
| `GET`   | `/orders/:id`                | Full order details                                                        |
| `PATCH` | `/orders/:id`                | Edit order fields (items, customer, delivery, payment method, comment)    |
| `PATCH` | `/orders/:id/status`         | Update fulfillment status — allowed transitions only (TD-0011)            |
| `PATCH` | `/orders/:id/payment-status` | Update payment status and optional transaction id                         |
| `PATCH` | `/orders/:id/ttn`            | Set Nova Post TTN — ships a NOVA_POST/COURIER order not yet shipped       |
| `POST`  | `/orders/:id/invoice`        | One order's invoice as PDF                                                |
| `POST`  | `/orders/report`             | Sales report for a period — see _The sales report_ below                  |

### Public endpoints

| Method  | Path                                                 | Access                    | Description                                                                                                                                                                                                        |
| ------- | ---------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`   | `/orders/lookup/:orderNumber?token=…`                | public, HMAC token        | Payment state of an order (`order_number`, `payment_method`, `payment_status`, `total_price`, `order_status`, `delivery_method`, `can_change_payment_method`) for the checkout success page — see `LIQPAY_FLOW.md` |
| `PATCH` | `/orders/lookup/:orderNumber/payment-method?token=…` | public, HMAC token, 5/min | Switch an unpaid order (payment `PENDING`/`FAILED`, order not yet shipped: `NEW`/`PROCESSING`/`CONFIRMED`) to `COD`/`IBAN`/`CASH`; `409 PAYMENT_METHOD_LOCKED` otherwise — TD-0009, `LIQPAY_FLOW.md`                                             |
| `PATCH` | `/orders/me/:id/payment-method`                      | `JwtAuthGuard`, owner     | The same change for a signed-in buyer's own order; returns the customer order shape                                                                                                                                |

---

## The sales report — `POST /orders/report`

The report goes to the finance department, so it answers «what was sold over this period, when,
and for how much» — not «what does each buyer owe». It used to be the invoice of every order in
the range concatenated into one PDF, which is the same question asked N times and no answer to
this one.

Body: `date_from`, `date_to` (`YYYY-MM-DD`), optional `order_status`, `payment_status`. Returns a
landscape A4 PDF with a running footer and page numbers, in three sections:

1. **Продані товари** — every SKU sold in the period, summed across orders: quantity, the number
   of orders it appeared in, average price and line value, largest first. Line values are
   pre-coupon; the note under the table says so.
2. **Реєстр замовлень** — one row per order: number, sale date, customer, positions/units,
   statuses, payment and delivery method, subtotal, discount (with the coupon code) and payable.
3. **Підсумки за період** — payable against paid and awaited, breakdowns by payment status,
   payment method, order status and delivery method, and sales per day.

Two figures are deliberately called out rather than buried:

- **Non-revenue orders.** `CANCELLED`, `RETURNED` or `REFUNDED` orders inside the selection are
  counted in the totals like any other, so their number and amount are printed under the summary
  with a line saying to subtract them if the report feeds revenue.
- **Subtotal drift.** If the stored `subtotal_price` of the selection disagrees with the line
  values the product table sums from, the gap is printed instead of leaving two totals that
  quietly fail to reconcile.

### Dates are Kyiv days

`date_from` / `date_to` are calendar days in `Europe/Kyiv`, resolved by `report.period.ts`.
`new Date('2026-09-01')` is UTC midnight — 03:00 in Kyiv under EEST — so a naive range drops the
first three hours of the opening day and borrows three hours of the day after the closing one.
The per-day grouping in section 3 uses the same zone.

### Sale date

The report dates a sale by `createdAt`, the moment the order was placed. There is no `paid_at`
in the schema, so for a prepaid order the report's date is not the date the money arrived; the
note under the register says so. Adding `paid_at` (written on the `PAID` transition, backfilled
from `createdAt`) is what would close that gap.

---

## `POST /orders` refusals

Every refusal of order creation is read by the buyer on the checkout page — the storefront
echoes `message` verbatim for anything but a `429` — so all of them are Ukrainian, phrased as an
action, and carry a machine-readable `code`. Line-level ones also carry `variant_id`, which is
what the storefront pins the message to (Plan-0005, screen «Чекаут: помилки»).

| Status | `code`                         | Extra fields                                      | When                                                       |
| ------ | ------------------------------ | ------------------------------------------------- | ---------------------------------------------------------- |
| `404`  | `VARIANT_NOT_FOUND`            | `variant_id`                                      | the id in the cart matches no variant at all               |
| `400`  | `VARIANT_UNAVAILABLE`          | `variant_id`, `sku`                               | the variant is `draft`/`archived` (archived while in cart) |
| `409`  | `OUT_OF_STOCK`                 | `variant_id`, `sku`, `available` (0), `requested` | `stock === 0` — the line has to be removed                 |
| `409`  | `INSUFFICIENT_STOCK`           | `variant_id`, `sku`, `available`, `requested`     | `0 < stock < requested` — the quantity can be reduced      |
| `400`  | `DELIVERY_ADDRESS_REQUIRED`    | —                                                 | non-`PICKUP` delivery with no `delivery_address`           |
| `400`  | `NOVA_POST_WAREHOUSE_REQUIRED` | —                                                 | `NOVA_POST` without `warehouse_description` / `_number`    |
| `400`  | `COURIER_ADDRESS_REQUIRED`     | —                                                 | `COURIER` without `street` / `building`                    |
| `400`  | `COUPON_INVALID`               | —                                                 | no active coupon with that code                            |
| `400`  | `COUPON_EXPIRED`               | —                                                 | the coupon's `valid_until` has passed                      |
| `400`  | `COUPON_NOT_APPLICABLE`        | —                                                 | every line is on promotion, so the coupon would buy nothing (TD-0012) |

`OUT_OF_STOCK` and `INSUFFICIENT_STOCK` are split because the advice differs: at zero there is
nothing left to reduce, so the text asks for the line to be removed rather than for a smaller
quantity. Both keep `available`, so a client may also branch on `available === 0`.

The payment/delivery combination refusal (`COD` needs a carrier, `CASH` needs pickup) is a
`400` with a Ukrainian sentence and no `code` — it is not tied to one cart line.
`validateDeliveryData` is shared with the admin `PATCH /orders/:id`, so an admin edit missing
the same fields answers with the same codes.

---

## Admin `PATCH /orders/:id` rules

Editable fields:

- `items`
- `customer`
- `payment_method`
- `delivery_method`
- `delivery_address`
- `comment`
- `manual_discount` — `{ amount, reason }` or `null` to remove it (see below)

Calculation rules:

- if `items` are provided, the backend reloads variants from the current catalog and rebuilds order item snapshots
- each line total is calculated as `price * quantity`
- `subtotal_price` is recalculated from all line totals
- if `applied_discount` exists, its `discount_percent` is preserved and `discount_amount` is recalculated from the new `subtotal_price`
- `total_price` is recalculated as `subtotal_price - discount_amount - manual_discount.amount` (each term 0 when absent)

Manual discount (`manual_discount`) — a fixed amount in UAH the admin grants after checkout,
e.g. the buyer asked for 50 ₴ off by phone:

- `amount` > 0 (2 decimals max), `reason` 1..300 chars (trimmed; blank → 400); stored with `applied_at`
- stacks on top of the coupon; `amount` greater than `subtotal_price - discount_amount` → `400 MANUAL_DISCOUNT_TOO_LARGE`. An `items` edit keeps it and re-checks the same limit
- `payment_status` `PAID` / `REFUNDED` → `409 MANUAL_DISCOUNT_ORDER_PAID`: once the money moved it is a refund, handled outside the system
- an open LiqPay session (`liqpay_retry_after_seconds > 0`) → `409 LIQPAY_SESSION_ACTIVE` with `retry_after_seconds`: that session was built with the old amount, and the callback is checked against `total_price` (±0.01), so the admin waits the cooldown out rather than invite a second charge
- the buyer projection (`GET /orders/me*`) carries `{ amount }` only — `reason` and `applied_at` are admin-only
- the invoice prints «Знижка магазину» (reason on the internal copy only); the sales report adds it to the order's discount, spreads it over the lines like the coupon and marks it «ручна»
- the Nova Post COD amount is set by the admin in the NP cabinet — use the new `total_price` there

Delivery validation:

- `PICKUP` -> `delivery_address` must be `null`
- `NOVA_POST` -> `delivery_address.warehouse_description` and `delivery_address.warehouse_number` are required
- `COURIER` -> `delivery_address.street` and `delivery_address.building` are required

Payment / delivery combination:

- `COD` (накладний платіж) is only valid with `NOVA_POST` or `COURIER` delivery —
  the parcel has to travel with Nova Post for the carrier to collect the money.
  The check runs on the **effective** pair, so it rejects both
  `{ payment_method: COD }` on a `PICKUP` order and
  `{ delivery_method: PICKUP }` on a `COD` order
  (`OrderService.validatePaymentDeliveryCombination`).
- `CASH` (готівка) is only valid with `PICKUP` — cash changes hands at the counter. The
  checkout form always enforced this; the server does too since the customer-facing
  payment-method change (TD-0009) became the first path that needed it. An admin `PATCH`
  putting `CASH` on a parcel is now a `400` as well.
- `IBAN` and `LIQPAY` are unrestricted at the API level.

COD payment is confirmed by the parcel being received: the buyer pays at the counter to get it,
so when the Nova Post tracker sees a «received» code on a COD order whose payment is `PENDING`,
the same write sets `payment_status = PAID` and the order lands on `COMPLETED` (TD-0011,
`decideTracking` → `markPaid`). The admin can still set `PAID` by hand first — the tracker then
leaves the payment alone. For every other payment method the tracker never touches the payment.
Setting the TTN does not change the payment status (it does ship the order — below).

---

## Order lifecycle (TD-0011)

Facts move the status; the admin only decides. One module owns the rules —
`src/modules/order/helpers/order-status.rules.ts` — and every write of either status
(admin endpoints, TTN, the Nova Post tracker, the LiqPay callback, the buyer's payment-method
change) goes through its `planStatusChange`, which applies the payment rule below, settles
`COMPLETED` and builds the `status_history` entries in one place.

```
NEW ─► PROCESSING ─► CONFIRMED ─ TTN ─► SHIPPED ─ НП «отримано» ─► DELIVERED ─ PAID ─► COMPLETED
 │  (buyer contacted,   │                   │                            ▲
 │   confirmation awaited; the three        └ НП відмова ─► RETURNING ───┴─► RETURNED
 │   move freely; TTN ships any of them; pickup: «Видано» → DELIVERED)
 └─► CANCELLED ─ «Відновити» ─► NEW
```

| From | Admin may set (`allowed_status_transitions`) | Automatic |
|---|---|---|
| `NEW` / `PROCESSING` / `CONFIRMED` | the other two, `CANCELLED`, `DELIVERED` (pickup only) | TTN → `SHIPPED` |
| `SHIPPED` | `DELIVERED` (fallback when the tracker cannot see the parcel), `RETURNING` | tracker: received → `DELIVERED`, refusal → `RETURNING` |
| `DELIVERED` / `COMPLETED` | `RETURNING` | `DELIVERED` ⇄ `COMPLETED` by `PAID` |
| `RETURNING` | `RETURNED`, `DELIVERED` (the buyer collected after all) | — |
| `CANCELLED` | `NEW` | — |
| `RETURNED` | — (terminal) | — |

- **`COMPLETED` is never set by hand.** It is «delivered and paid»: whichever of the two arrives
  second settles it in the same write, and losing `PAID` takes it back to `DELIVERED`.
- **A shipped order cannot be cancelled** — it is returned (`RETURNING → RETURNED`).
- **`PROCESSING` means «Очікує підтвердження»** — the admin has written to the buyer and waits
  for the confirmation; it sits before `CONFIRMED`, not after it as the old «В обробці» (packing)
  did. A one-off migration (run by the owner at release, not kept in the repo) moved legacy rows
  set under the old meaning to `CONFIRMED` — or `SHIPPED` when they carried a TTN — telling them
  apart by the absence of a `status_history` entry, and closed `DELIVERED` + `PAID` as `COMPLETED`. The buyer may still change the payment method in it — the lock is the TTN.
- **Errors:** a move not in the list → `409 { code: 'INVALID_STATUS_TRANSITION', from, to,
  allowed }`; a status no row targets (`SHIPPED`, `COMPLETED`) → `400` from the DTO
  (`ADMIN_SETTABLE_ORDER_STATUSES` is derived from the table, so the Swagger enum is the truth);
  a write whose pinned statuses moved meanwhile (tracker, callback, another tab) →
  `409 { code: 'ORDER_STATUS_CHANGED' }`. Sending the current status again is a `200` no-op —
  except that re-applying `CANCELLED` still voids a legacy order that reads `PENDING` (TD-0003).
- **`status_history[]`** — `{ field, from, to, at, actor, admin_id?, note? }`, `actor ∈ admin |
  customer | tracker | gateway | system`. Written with `$push` in the same update as the
  status; the LiqPay retry claim (`FAILED → PENDING` on `POST /liqpay/checkout`) records its move
  through a pipeline update (`REPOSITORY_PATTERN.md` §7). Admin **detail** only — the admin list
  drops it, and `/orders/me*` and the public lookup never carry it.
- **Gateway writes are pinned on the whole state read** (method, order status, payment status):
  the planned write carries a derived order status, so a callback racing the tracker must miss
  rather than stamp `COMPLETED` over `RETURNING`. A miss re-reads once and starts over from the
  fresh state; a second miss is logged and left to the next callback.
- **`GET /orders/:id`** also answers `ships_on_ttn` — whether `PATCH /orders/:id/ttn` will set
  `SHIPPED` — so the admin UI's hint comes from the same rule as the write.

## Payment side effect of an order status change

`order_status` and `payment_status` are otherwise independent, but cancelling or receiving back
an order also recalculates the payment status
(`resolvePaymentStatusOnOrderStatusChange` in
`src/modules/order/helpers/payment-status.helpers.ts`):

| Requested `order_status` | Current `payment_status` | New `payment_status` | Why                                                                                    |
| ------------------------ | ------------------------ | -------------------- | -------------------------------------------------------------------------------------- |
| `CANCELLED` / `RETURNED` | `PENDING` / `FAILED`     | `VOIDED`             | No money arrived — payment is no longer expected                                       |
| `CANCELLED` / `RETURNED` | `PAID`                   | unchanged            | Money really arrived; admin refunds manually and sets `REFUNDED` (logged as a warning) |
| `CANCELLED` / `RETURNED` | `REFUNDED` / `VOIDED`    | unchanged            | Already terminal                                                                       |
| `NEW` (from `CANCELLED`) | `VOIDED`                 | `PENDING`            | Order reopened — payment is expected again                                             |
| anything else            | other                    | unchanged            | —                                                                                      |

Without this, a cancelled unpaid order kept reading «Очікує оплату» in the
customer account, the admin panel, reports and the PDF invoice.

## A claimed card retry sets the payment back to `PENDING`

`POST /liqpay/checkout` claims one live session per order. When it grants that claim it also
writes `payment_status = PENDING`, which matters for the admin view: an order whose card payment
was declined reads `FAILED` only until the buyer opens a retry, after which it reads `PENDING`
again with a fresh `liqpay_checkout_started_at`. The next callback decides it (`PAID` or
`FAILED` again). This is what stops two tabs of a `FAILED` order from opening two live gateway
sessions; the retry itself is still allowed immediately. See `LIQPAY_FLOW.md` → _One live
session, retries included_.

## Gateway callback on a cancelled order

`applyGatewayPaymentResult` (used by `POST /liqpay/callback`) checks
`order_status` before writing:

- **paid** → `payment_status` becomes `PAID` and `payment_transaction_id` is
  stored, because the money genuinely arrived. The customer does **not** get the
  "order paid" email; a service email goes to `SERVICE_EMAIL` instead
  (`EmailService.sendCancelledOrderPaidNotification`) so an admin can refund it.
- **failed** → nothing is written; `VOIDED` is preserved rather than being
  overwritten with `FAILED`.

The complete LiqPay sequence — checkout payload, callback verification, why
`result_url` carries no status, and the public token-protected
`GET /orders/lookup/:orderNumber?token=…` payment-status endpoint used by
the checkout success page — is documented in `src/docs/LIQPAY_FLOW.md`.

See `docs/architecture/state-machines.md` and TD-0003 in the `fillando-meta`
repository.

## Promotions on order lines (TD-0012)

`OrderService.buildOrderItems` prices every line at the moment of the write: `items[].price` is what
the buyer pays — the variant's sale price while its promotion is on (`activePromo`) — and
`items[].list_price` the regular price, with `items[].promo_percent` saying which sale it was. Orders
written before TD-0012 have no `list_price`; `mapOrderResponse` reads it back as `price`.

**A coupon acts on the lines that are not on promotion.** `discount_amount = round2(percent/100 ×
Σ line totals with promo_percent = null)`; the storefront previews the same figure from the cart.
When every line is on promotion the order is refused with `400 COUPON_NOT_APPLICABLE` rather than
recorded with a 0 discount, so a single-use code is not burned for nothing. The admin `PATCH
/orders/:id` with `items` recomputes the coupon over the same eligible subtotal (no refusal there —
the admin is editing; if every remaining line is on promotion the coupon simply contributes 0).
Note that `items` edits have always re-priced every line from the current catalogue — a promotion
that ended between checkout and the edit therefore raises the unit price the same way a Prom price
change always has; the admin sees the new total before confirming. LiqPay charges `total_price` as it was at creation: a promotion that starts
or ends between the cart and `POST /orders` simply prices at creation time.

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
| `PATCH` | `/orders/:id/status`         | Update fulfillment status                                                 |
| `PATCH` | `/orders/:id/payment-status` | Update payment status and optional transaction id                         |
| `PATCH` | `/orders/:id/ttn`            | Set Nova Post TTN                                                         |

### Public endpoints

| Method  | Path                                                 | Access                    | Description                                                                                                                                                                                                        |
| ------- | ---------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`   | `/orders/lookup/:orderNumber?token=…`                | public, HMAC token        | Payment state of an order (`order_number`, `payment_method`, `payment_status`, `total_price`, `order_status`, `delivery_method`, `can_change_payment_method`) for the checkout success page — see `LIQPAY_FLOW.md` |
| `PATCH` | `/orders/lookup/:orderNumber/payment-method?token=…` | public, HMAC token, 5/min | Switch an unpaid order (payment `PENDING`/`FAILED`, order `NEW`/`CONFIRMED`) to `COD`/`IBAN`/`CASH`; `409 PAYMENT_METHOD_LOCKED` otherwise — TD-0009, `LIQPAY_FLOW.md`                                             |
| `PATCH` | `/orders/me/:id/payment-method`                      | `JwtAuthGuard`, owner     | The same change for a signed-in buyer's own order; returns the customer order shape                                                                                                                                |

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

Calculation rules:

- if `items` are provided, the backend reloads variants from the current catalog and rebuilds order item snapshots
- each line total is calculated as `price * quantity`
- `subtotal_price` is recalculated from all line totals
- if `applied_discount` exists, its `discount_percent` is preserved and `discount_amount` is recalculated from the new `subtotal_price`
- `total_price` is recalculated as `subtotal_price - discount_amount` (or equal to `subtotal_price` when no discount is applied)

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

COD payment status is never automated: it stays `PENDING` until an admin sets
`PAID` via `PATCH /orders/:id/payment-status` once Nova Post remits the money.
Setting the TTN does not change it.

---

## `PATCH /orders/:id/status` — payment side effect

`order_status` and `payment_status` are otherwise independent, but cancelling an
order also recalculates the payment status
(`resolvePaymentStatusOnOrderStatusChange` in
`src/modules/order/helpers/payment-status.helpers.ts`):

| Requested `order_status` | Current `payment_status` | New `payment_status` | Why                                                                                    |
| ------------------------ | ------------------------ | -------------------- | -------------------------------------------------------------------------------------- |
| `CANCELLED`              | `PENDING` / `FAILED`     | `VOIDED`             | No money arrived — payment is no longer expected                                       |
| `CANCELLED`              | `PAID`                   | unchanged            | Money really arrived; admin refunds manually and sets `REFUNDED` (logged as a warning) |
| `CANCELLED`              | `REFUNDED` / `VOIDED`    | unchanged            | Already terminal                                                                       |
| anything else            | `VOIDED`                 | `PENDING`            | Order reopened — payment is expected again                                             |
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

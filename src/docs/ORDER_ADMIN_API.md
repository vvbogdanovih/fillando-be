# Order Admin API

Module: `src/modules/order/`
Base path: `/orders` (paths are shown as the app serves them — there is no global prefix; Nginx
prepends `/api` in production)
Access: ADMIN (`JwtAuthGuard` + `RolesGuard` + `@Roles(Role.ADMIN)`) for every route in the
table below. The module also exposes user-owned routes (`POST /orders`, `GET /orders/me`,
`GET /orders/me/:id`) and one public, token-protected route — see *Public endpoints*.

---

## Endpoints

| Method  | Path                             | Description                                                               |
| ------- | -------------------------------- | ------------------------------------------------------------------------- |
| `GET`   | `/orders`                    | Paginated orders list with filters by `order_status` and `payment_status` |
| `GET`   | `/orders/:id`                | Full order details                                                        |
| `PATCH` | `/orders/:id`                | Edit order fields (items, customer, delivery, payment method, comment)    |
| `PATCH` | `/orders/:id/status`         | Update fulfillment status                                                 |
| `PATCH` | `/orders/:id/payment-status` | Update payment status and optional transaction id                         |
| `PATCH` | `/orders/:id/ttn`            | Set Nova Post TTN                                                         |

### Public endpoints

| Method | Path                                  | Access                | Description                                                              |
| ------ | ------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `GET`  | `/orders/lookup/:orderNumber?token=…` | public, HMAC token    | Payment status of an order (`order_number`, `payment_method`, `payment_status`, `total_price`) for the checkout success page — see `LIQPAY_FLOW.md` |

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
- Other payment methods are unrestricted at the API level.

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

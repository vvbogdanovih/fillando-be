# Order Admin API

Module: `src/modules/order/`
Base path: `/api/orders`
Access: ADMIN (`JwtAuthGuard` + `RolesGuard` + `@Roles(Role.ADMIN)`)

---

## Endpoints

| Method  | Path                             | Description                                                               |
| ------- | -------------------------------- | ------------------------------------------------------------------------- |
| `GET`   | `/api/orders`                    | Paginated orders list with filters by `order_status` and `payment_status` |
| `GET`   | `/api/orders/:id`                | Full order details                                                        |
| `PATCH` | `/api/orders/:id`                | Edit order fields (items, customer, delivery, payment method, comment)    |
| `PATCH` | `/api/orders/:id/status`         | Update fulfillment status                                                 |
| `PATCH` | `/api/orders/:id/payment-status` | Update payment status and optional transaction id                         |
| `PATCH` | `/api/orders/:id/ttn`            | Set Nova Post TTN                                                         |

---

## Admin `PATCH /api/orders/:id` rules

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

---

## `PATCH /api/orders/:id/status` — payment side effect

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

See `docs/architecture/state-machines.md` and TD-0003 in the `fillando-meta`
repository.

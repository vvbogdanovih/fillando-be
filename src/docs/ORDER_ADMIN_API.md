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

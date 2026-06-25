# Data Models

All collections live in MongoDB. Schemas are defined in `src/database/mongoose/schemas/`.

---

## Collections

### `users`

Schema: `src/database/mongoose/schemas/user.schema.ts`

| Field                     | Type              | Notes                                     |
| ------------------------- | ----------------- | ----------------------------------------- |
| `email`                   | string            | required, unique                          |
| `password`                | string            | optional — absent for OAuth-only accounts |
| `name`                    | string            | required                                  |
| `role`                    | `Role` enum       | default: `USER`                           |
| `phone`                   | string            | optional, unique, sparse                  |
| `picture`                 | string            | optional — profile photo URL              |
| `authMethod`              | `AuthMethod` enum | default: `EMAIL`                          |
| `createdAt` / `updatedAt` | Date              | auto-managed (timestamps)                 |

---

### `refresh_tokens`

Schema: `src/database/mongoose/schemas/refresh-token.schema.ts`

| Field                     | Type               | Notes                                               |
| ------------------------- | ------------------ | --------------------------------------------------- |
| `token`                   | string             | required, unique — **SHA256 hash** of the raw token |
| `userId`                  | ObjectId → `users` | required                                            |
| `expiresAt`               | Date               | required                                            |
| `ipAddress`               | string             | optional — client IP at time of issue               |
| `userAgent`               | string             | optional — parsed browser/OS string                 |
| `createdAt` / `updatedAt` | Date               | auto-managed (timestamps)                           |

Tokens are single-use and deleted on consumption. See `src/docs/AUTH_FLOW.md`.

---

### `carts`

Schema: `src/database/mongoose/schemas/cart.schema.ts`

| Field                     | Type               | Notes                                      |
| ------------------------- | ------------------ | ------------------------------------------ |
| `user_id`                 | ObjectId → `users` | required; unique index — one cart per user |
| `items`                   | `CartItem[]`       | **embedded**, default: `[]`                |
| `createdAt` / `updatedAt` | Date               | auto-managed (timestamps)                  |

#### Embedded: `CartItem` (`_id: false`)

| Field        | Type                          | Notes            |
| ------------ | ----------------------------- | ---------------- |
| `variant_id` | ObjectId → `product_variants` | required         |
| `quantity`   | number                        | required, min: 1 |
| `added_at`   | Date                          | default: `now`   |

Cart documents are created lazily on first write (no document is created at registration). See `src/docs/CART_FLOW.md`.

---

### `orders`

Schema: `src/database/mongoose/schemas/order.schema.ts`

| Field                     | Type                       | Notes                                                         |
| ------------------------- | -------------------------- | ------------------------------------------------------------- |
| `order_number`            | string                     | required, unique                                              |
| `user_id`                 | ObjectId → `users` \| null | optional — null for guest checkout                            |
| `customer`                | `CustomerSnapshot`         | required — snapshot of customer contact data (admin-editable) |
| `items`                   | `OrderItem[]`              | required — snapshot of ordered variants (admin-editable)      |
| `subtotal_price`          | number                     | required — sum before any discount                            |
| `total_price`             | number                     | required                                                      |
| `applied_discount`        | `AppliedDiscount` \| null  | nullable — coupon snapshot captured at checkout               |
| `payment_method`          | `PaymentMethod` enum       | required                                                      |
| `payment_status`          | `PaymentStatus` enum       | default: `PENDING`                                            |
| `delivery_method`         | `DeliveryMethod` enum      | required                                                      |
| `delivery_address`        | `DeliveryAddress` \| null  | nullable — depends on delivery method                         |
| `comment`                 | string \| null             | optional                                                      |
| `createdAt` / `updatedAt` | Date                       | auto-managed (timestamps)                                     |

#### Embedded: `OrderItem` (`_id: false`)

| Field        | Type                          | Notes                                                          |
| ------------ | ----------------------------- | -------------------------------------------------------------- |
| `variant_id` | ObjectId → `product_variants` | required                                                       |
| `product_id` | ObjectId → `products`         | required                                                       |
| `name`       | string                        | required — variant name snapshot                               |
| `sku`        | string                        | required — internal Fillando SKU                               |
| `vendor_sku` | string \| null                | nullable — external vendor SKU (`vendor_product_sku` snapshot) |
| `price`      | number                        | required — price at checkout time                              |
| `quantity`   | number                        | required, min: 1                                               |
| `image`      | string \| null                | nullable                                                       |

#### Embedded: `AppliedDiscount` (`_id: false`)

| Field              | Type                          | Notes                                         |
| ------------------ | ----------------------------- | --------------------------------------------- |
| `coupon_id`        | ObjectId → `discount_coupons` | required                                      |
| `code`             | string                        | required — stored as 10-char uppercase alnum  |
| `discount_percent` | number                        | required — `0..100`                           |
| `discount_amount`  | number                        | required — absolute amount at checkout moment |

Admin update behavior (`PATCH /api/orders/:id`, ADMIN only):

- `items` are rebuilt from the current product-variant catalog (`name`, `sku`, `vendor_sku`, `price`, first `image`)
- `subtotal_price` is recalculated as the sum of line totals (`price * quantity`)
- if `applied_discount` exists, `discount_percent` stays unchanged and `discount_amount` is recalculated from the new subtotal
- `total_price` is recalculated accordingly

---

### `discount_coupons`

Schema: `src/database/mongoose/schemas/discount-coupon.schema.ts`

| Field                     | Type    | Notes                                                                     |
| ------------------------- | ------- | ------------------------------------------------------------------------- |
| `number`                  | string  | required, unique — internal incremental id in format `DIS-0000123`        |
| `code`                    | string  | required, unique, uppercase, format: `XXXXXXXXXX` (10 random alnum chars) |
| `discount_percent`        | number  | required, `0..100`                                                        |
| `valid_until`             | Date    | required — coupon expiration moment                                       |
| `is_active`               | boolean | default: `true`                                                           |
| `createdAt` / `updatedAt` | Date    | auto-managed (timestamps)                                                 |

---

### `vendors`

Schema: `src/database/mongoose/schemas/vendor.schema.ts`

| Field                     | Type   | Notes                                      |
| ------------------------- | ------ | ------------------------------------------ |
| `name`                    | string | required, unique                           |
| `slug`                    | string | required, unique — programmatic identifier |
| `createdAt` / `updatedAt` | Date   | auto-managed (timestamps)                  |

The `slug` value drives product stock behaviour. See `src/docs/PRODUCT_ENRICHMENT.md`.

---

### `categories`

Schema: `src/database/mongoose/schemas/category.schema.ts`

| Field                     | Type            | Notes                                                           |
| ------------------------- | --------------- | --------------------------------------------------------------- |
| `name`                    | string          | required, unique                                                |
| `slug`                    | string          | required, unique                                                |
| `image`                   | string \| null  | optional — public URL of the category image; `null` when absent |
| `order`                   | number          | UI display order — lower values appear first; default: `0`      |
| `subcategories`           | `Subcategory[]` | **embedded**, default: `[]`                                     |
| `createdAt` / `updatedAt` | Date            | auto-managed (timestamps)                                       |

#### Embedded: `Subcategory` (`_id: true`)

| Field                 | Type                  | Notes                                                 |
| --------------------- | --------------------- | ----------------------------------------------------- |
| `_id`                 | ObjectId              | auto-generated — used as `subcategory_id` on products |
| `name`                | string                | required                                              |
| `slug`                | string                | required                                              |
| `required_attributes` | `RequiredAttribute[]` | **embedded**, default: `[]`                           |

#### Embedded: `RequiredAttribute` (`_id: false`)

| Field         | Type                        | Notes                                                                            |
| ------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `key`         | string                      | required — auto-generated from `label` via `generateAttrKey` (e.g. `'vyrobnyk'`) |
| `label`       | string                      | required — display label (e.g. `'Виробник'`)                                     |
| `filter_type` | `'multi-select' \| 'range'` | required — controls filter UI type                                               |
| `unit`        | string \| null              | nullable — e.g. `'мм'`, `'кг'`; `null` when not applicable                       |

`RequiredAttribute` has `_id: false` because it has no identity of its own; it only describes
what attributes a product in this subcategory must have. `key` is never supplied by the
client — it is derived from `label` in the service layer using `generateAttrKey`.

---

### `products`

Schema: `src/database/mongoose/schemas/product.schema.ts`

| Field                     | Type                    | Notes                                                            |
| ------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `name`                    | string                  | required                                                         |
| `slug`                    | string                  | required, unique                                                 |
| `category_id`             | ObjectId → `categories` | required                                                         |
| `subcategory_id`          | string                  | required — stringified `_id` of the embedded `Subcategory`       |
| `images`                  | string[]                | product-level images                                             |
| `price`                   | number                  | required — base price                                            |
| `attributes`              | `Attribute[]`           | **embedded**, default: `[]`                                      |
| `vendor_id`               | ObjectId → `vendors`    | required                                                         |
| `variant_type`            | string                  | optional — label for the variant axis (e.g. `'color'`, `'size'`) |
| `variants`                | `ProductVariant[]`      | **embedded**, default: `[]`                                      |
| `status`                  | `ProductStatus` enum    | default: `DRAFT`                                                 |
| `createdAt` / `updatedAt` | Date                    | auto-managed (timestamps)                                        |

#### Embedded: `ProductVariant` (`_id: true`)

| Field                | Type     | Notes                                                                       |
| -------------------- | -------- | --------------------------------------------------------------------------- |
| `_id`                | ObjectId | auto-generated                                                              |
| `sku`                | string   | required                                                                    |
| `v_value`            | string   | required — variant value (e.g. `'Red'`, `'XL'`)                             |
| `price`              | number   | optional — overrides product base price                                     |
| `stock`              | number   | optional — used for Fillando vendor; overwritten at read time for NicePrice |
| `vendor_product_sku` | string   | optional — external SKU used to fetch stock from NicePrice                  |
| `prom_id`            | string   | optional — NicePrice (Prom) product id from the product URL (`/p<id>-…`)    |
| `images`             | string[] | variant-level images                                                        |

#### Embedded: `Attribute` (`_id: false`)

| Field | Type                        | Notes                                                                      |
| ----- | --------------------------- | -------------------------------------------------------------------------- |
| `k`   | string                      | required — auto-generated key via `generateAttrKey(l)` (e.g. `'vyrobnyk'`) |
| `l`   | string                      | required — human-readable label (e.g. `'Виробник'`)                        |
| `v`   | string \| number \| boolean | required — attribute value (e.g. `'Sony'`, `1.75`)                         |

A compound index on `{ 'attributes.k': 1, 'attributes.v': 1 }` supports efficient filter queries.
`k` is never supplied by the client — it is derived from `l` in the service layer using `generateAttrKey`.

---

### `nova_post_cities`

Schema: `src/database/mongoose/schemas/nova-post-city.schema.ts`

| Field            | Type   | Notes                                |
| ---------------- | ------ | ------------------------------------ |
| `ref`            | string | required, unique — Nova Post API ref |
| `name`           | string | required                             |
| `settlementType` | string | required                             |
| `area`           | string | required                             |

No timestamps. See `src/docs/NOVA_POST.md`.

---

### `nova_post_warehouses`

Schema: `src/database/mongoose/schemas/nova-post-warehouse.schema.ts`

| Field              | Type   | Notes                                      |
| ------------------ | ------ | ------------------------------------------ |
| `ref`              | string | required, unique — Nova Post API ref       |
| `description`      | string | required — full address description        |
| `shortAddress`     | string | required                                   |
| `number`           | number | required — branch number                   |
| `cityRef`          | string | required — links to `nova_post_cities.ref` |
| `cityName`         | string | required                                   |
| `maxWeightAllowed` | number | required — kg                              |

No timestamps. See `src/docs/NOVA_POST.md`.

---

## Relationship Diagram

```
users
  └── refresh_tokens (userId → users._id)
  └── carts (user_id → users._id)

vendors
  └── products (vendor_id → vendors._id)

categories
  └── subcategories[]          ← embedded, _id: true
        └── required_attributes[]  ← embedded, _id: false
  └── products (category_id → categories._id)
              (subcategory_id = subcategories[]._id as string)

products
  └── attributes[]      ← embedded, _id: false
  └── variants[]        ← embedded, _id: true

nova_post_cities
  └── nova_post_warehouses (cityRef = nova_post_cities.ref)
```

---

## Embedding vs. Referencing Decisions

| Case                              | Decision       | Reason                                                                              |
| --------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `Subcategory` in `Category`       | **Embedded**   | Always read together; subcategories have no independent lifecycle                   |
| `ProductVariant` in `Product`     | **Embedded**   | Variants are meaningless without their parent product                               |
| `Attribute` / `RequiredAttribute` | **Embedded**   | Pure value objects; no independent identity needed                                  |
| `Vendor` on `Product`             | **Referenced** | Vendors are shared across products; queried independently                           |
| `Category` on `Product`           | **Referenced** | Categories are queried independently and managed separately                         |
| `User` on `RefreshToken`          | **Referenced** | Users are the primary entity; tokens are secondary                                  |
| `ProductVariant` in `Cart.items`  | **Referenced** | Variants change (price, stock) — always read live data, never denormalize into cart |

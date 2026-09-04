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
| `payment_method`          | `PaymentMethod` enum       | required — `COD` only with `NOVA_POST` / `COURIER` delivery   |
| `payment_status`          | `PaymentStatus` enum       | default: `PENDING`                                            |
| `payment_transaction_id`  | string \| null             | nullable — gateway transaction id (LiqPay `transaction_id` / `payment_id`), or set by admin via `PATCH /orders/:id/payment-status` |
| `delivery_method`         | `DeliveryMethod` enum      | required                                                      |
| `delivery_address`        | `DeliveryAddress` \| null  | nullable — depends on delivery method                         |
| `nova_post_ttn`           | string \| null             | nullable — Nova Post tracking number, set via `PATCH /orders/:id/ttn` |
| `order_status`            | `OrderStatus` enum         | default: `NEW` — fulfillment status, independent of `payment_status` (see `ORDER_ADMIN_API.md`) |
| `comment`                 | string \| null             | optional                                                      |
| `createdAt` / `updatedAt` | Date                       | auto-managed (timestamps)                                     |

Indexes: `user_id`, `order_status`, `payment_status` (plus the unique `order_number`).

There is **no** stored token for the public payment-status lookup
(`GET /orders/lookup/:orderNumber?token=…`). The token is derived on every request as
`HMAC-SHA256(PAYMENT_ENCRYPTION_KEY, 'order-lookup:' + order_number)` (hex, first 32 chars),
so nothing about it lives in this collection. See `src/docs/LIQPAY_FLOW.md`.

#### Embedded: `OrderItem` (`_id: false`)

| Field        | Type                          | Notes                                                                                                            |
| ------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `variant_id` | ObjectId → `product_variants` | required                                                                                                         |
| `product_id` | ObjectId → `products`         | required                                                                                                         |
| `name`       | string                        | required — variant name snapshot                                                                                 |
| `sku`        | string                        | required — internal Fillando SKU                                                                                 |
| `vendor_sku` | string \| null                | nullable — supplier article snapshot (`vendor_product_sku`) for the admin invoice / vendor e-mail; must not appear in customer-facing responses (`POST /orders`, `GET /orders/me*`) — stripped by the order module's customer projection |
| `price`      | number                        | required — price at checkout time                                                                                |
| `quantity`   | number                        | required, min: 1                                                                                                 |
| `image`      | string \| null                | nullable                                                                                                         |

#### Embedded: `AppliedDiscount` (`_id: false`)

| Field              | Type                          | Notes                                         |
| ------------------ | ----------------------------- | --------------------------------------------- |
| `coupon_id`        | ObjectId → `discount_coupons` | required                                      |
| `code`             | string                        | required — stored as 10-char uppercase alnum  |
| `discount_percent` | number                        | required — `0..100`                           |
| `discount_amount`  | number                        | required — absolute amount at checkout moment |

Admin update behavior (`PATCH /orders/:id`, ADMIN only):

- `items` are rebuilt from the current product-variant catalog (`name`, `sku`, `vendor_sku`, `price`, first `image`)
- `subtotal_price` is recalculated as the sum of line totals (`price * quantity`)
- if `applied_discount` exists, `discount_percent` stays unchanged and `discount_amount` is recalculated from the new subtotal
- `total_price` is recalculated accordingly

---

### `discount_coupons`

Schema: `src/database/mongoose/schemas/discount-coupon.schema.ts`

| Field                     | Type    | Notes                                                                                                                                                |
| ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `number`                  | string  | required, unique — internal incremental id in format `DIS-0000123`                                                                                   |
| `code`                    | string  | required, unique, uppercase, format: `XXXXXXXXXX` (10 random alnum chars)                                                                            |
| `discount_percent`        | number  | required, `0..100`                                                                                                                                   |
| `valid_until`             | Date    | required — coupon expiration moment                                                                                                                  |
| `is_active`               | boolean | default: `true`                                                                                                                                      |
| `is_reusable`             | boolean | default: `false` — single-use coupons are deactivated after the first order; reusable coupons stay active until `valid_until` or manual deactivation |
| `used_count`              | number  | default: `0` — incremented on every order that applies the coupon                                                                                    |
| `createdAt` / `updatedAt` | Date    | auto-managed (timestamps)                                                                                                                            |

---

### `wholesale_inquiries`

Schema: `src/database/mongoose/schemas/wholesale-inquiry.schema.ts`

| Field                     | Type           | Notes                                               |
| ------------------------- | -------------- | --------------------------------------------------- |
| `name`                    | string         | required — contact person full name                 |
| `phone`                   | string         | required, `+380XXXXXXXXX`                           |
| `email`                   | string         | required                                            |
| `quantity`                | string         | required — desired plastic quantity, free-form text |
| `comment`                 | string \| null | optional, default: `null`                           |
| `status`                  | enum           | `NEW` (default) \| `PROCESSED`                      |
| `createdAt` / `updatedAt` | Date           | auto-managed (timestamps)                           |

B2B wholesale inquiry submitted from the public form on the home page. See `src/docs/WHOLESALE_INQUIRY.md`.

---

### `vendors`

Schema: `src/database/mongoose/schemas/vendor.schema.ts`

| Field                     | Type   | Notes                                      |
| ------------------------- | ------ | ------------------------------------------ |
| `name`                    | string | required, unique                           |
| `slug`                    | string | required, unique — programmatic identifier |
| `createdAt` / `updatedAt` | Date   | auto-managed (timestamps)                  |

`NicePriceService` (`src/common/services/niceprice.service.ts`) exists as a stub for a
per-vendor live stock lookup by `slug`, but it is never injected or called anywhere —
`slug` does not currently drive any stock behaviour. Live availability/pricing is
handled separately by Prom sync, see `src/docs/PROM_AVAILABILITY_SYNC.md`.

---

### `categories`

Schema: `src/database/mongoose/schemas/category.schema.ts`

| Field                     | Type                  | Notes                                                           |
| ------------------------- | --------------------- | --------------------------------------------------------------- |
| `name`                    | string                | required, unique                                                |
| `slug`                    | string                | required, unique                                                |
| `image`                   | string \| null        | optional — public URL of the category image; `null` when absent |
| `order`                   | number                | UI display order — lower values appear first; default: `0`      |
| `required_attributes`     | `RequiredAttribute[]` | **embedded**, default: `[]`                                     |
| `createdAt` / `updatedAt` | Date                  | auto-managed (timestamps)                                       |

Categories are a single flat level. The former two-level structure (category → embedded
subcategories) was flattened by `scripts/migrations/flatten-categories.js`: each subcategory
was promoted to a top-level category keeping its `_id`, so existing product references
survived the migration.

#### Embedded: `RequiredAttribute` (`_id: false`)

| Field         | Type                        | Notes                                                                                                                                                       |
| ------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`         | string                      | required — auto-generated from `label` via `generateAttrKey` — `ATTR_KEY_OVERRIDES` lookup first, transliteration otherwise (e.g. `'vyrobnyk'`, `'series'`) |
| `label`       | string                      | required — display label (e.g. `'Виробник'`)                                                                                                                |
| `filter_type` | `'multi-select' \| 'range'` | required — controls filter UI type                                                                                                                          |
| `unit`        | string \| null              | nullable — e.g. `'мм'`, `'кг'`; `null` when not applicable                                                                                                  |

`RequiredAttribute` has `_id: false` because it has no identity of its own; it only describes
what attributes a product in this category must have. `key` is never supplied by the
client — it is derived from `label` in the service layer using `generateAttrKey`, which consults
the `ATTR_KEY_OVERRIDES` table first (`'Серія'` → `'series'`) and transliterates otherwise
(`'Виробник'` → `'vyrobnyk'`).

---

### `products`

Schema: `src/database/mongoose/schemas/product.schema.ts`

| Field                     | Type                    | Notes                                                        |
| ------------------------- | ----------------------- | ------------------------------------------------------------ |
| `name`                    | string                  | required                                                     |
| `category_id`             | ObjectId → `categories` | required — denormalized onto each variant as well            |
| `vendor_id`               | ObjectId → `vendors`    | required                                                     |
| `description`             | `ProductDescription`    | optional — **embedded** rich text (`json` + rendered `html`) |
| `variant_type`            | `VariantType`           | optional — **embedded** label of the variant axis            |
| `attributes`              | `Attribute[]`           | **embedded**, default: `[]`                                  |
| `createdAt` / `updatedAt` | Date                    | auto-managed (timestamps)                                    |

A product is the shared "header" of its variants. Slug, SKU, price, stock, images and status live on
`product_variants` (own collection, below) — not on the product.

#### Embedded: `ProductDescription` (`_id: false`)

| Field  | Type   | Notes                                            |
| ------ | ------ | ------------------------------------------------ |
| `json` | object | required — editor document (`Mixed`)             |
| `html` | string | required — rendered HTML; part of the text index |

#### Embedded: `VariantType` (`_id: false`)

| Field   | Type   | Notes                                                                               |
| ------- | ------ | ----------------------------------------------------------------------------------- |
| `key`   | string | required — e.g. `'color'`; **sent by the client and stored verbatim**, unlike `attributes[].k` |
| `label` | string | required — display label (e.g. `'Колір'`); drives the price-sheet colour derivation |

#### Embedded: `Attribute` (`_id: false`)

| Field | Type                        | Notes                                                                                                                                             |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `k`   | string                      | required — auto-generated via `generateAttrKey(l)` — `ATTR_KEY_OVERRIDES` lookup first, transliteration otherwise (e.g. `'vyrobnyk'`, `'series'`) |
| `l`   | string                      | required — human-readable label (e.g. `'Виробник'`)                                                                                               |
| `v`   | string \| number \| boolean | required — attribute value (e.g. `'Sony'`, `1.75`)                                                                                                |

Indexes: compound `{ 'attributes.k': 1, 'attributes.v': 1 }` for filter queries; text index
`product_text_search` over `name` (10), `attributes.v` (5), `attributes.l` (3), `description.html`
(1) with `default_language: 'none'` — used by `GET /products/search`.
`k` is never supplied by the client — it is derived from `l` in the service layer using
`generateAttrKey`, which consults the `ATTR_KEY_OVERRIDES` table first (`'Серія'` → `'series'`)
and transliterates otherwise (`'Виробник'` → `'vyrobnyk'`). When the override table changes,
`scripts/migrations/normalize-attr-keys.js` renames keys already stored in `attributes[].k`,
`categories.required_attributes[].key` and `variant_type.key` — run it after deploying the new
table (TD-0002 §5.2.1). `variant_type.key` matters most there: it is the one key the service does
not recompute on save, so nothing else repairs it, and the product page joins it against
`attributes[].k`.

---

### `product_variants`

Schema: `src/database/mongoose/schemas/product-variant.schema.ts`

| Field                     | Type                    | Notes                                                                                                                                                                     |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_id`              | ObjectId → `products`   | required                                                                                                                                                                  |
| `category_id`             | ObjectId → `categories` | required — denormalized from the product for flat catalog queries                                                                                                         |
| `name`                    | string                  | required — full variant name                                                                                                                                              |
| `slug`                    | string                  | required, unique — public URL (`/products/{slug}`)                                                                                                                        |
| `sku`                     | string                  | required, unique — internal Fillando article `FL-000123` (from the `numbers` counter)                                                                                     |
| `price`                   | number                  | required — selling price, UAH                                                                                                                                             |
| `stock`                   | number                  | default: `0` — available quantity                                                                                                                                         |
| `images`                  | string[]                | variant-level images                                                                                                                                                      |
| `v_value`                 | string \| null          | default: `null` — value on the variant axis (e.g. `'Червоний'`)                                                                                                           |
| `vendor_product_sku`      | string                  | optional — supplier's article. **Internal — never exposed by public endpoints; only via admin-only variant endpoints**                                                    |
| `prom_id`                 | string                  | optional — supplier's Prom product id (digits in `/p<id>-…`), key for Prom sync. **Internal — never exposed by public endpoints; only via admin-only variant endpoints**  |
| `prom_base_price`         | number \| null          | default: `null` — last pre-discount price seen on Prom (audit trail for `price`). **Internal — never exposed by public endpoints; only via admin-only variant endpoints** |
| `prom_discount_ratio`     | number \| null          | default: `null` — last Prom discount as a fraction `0..1`. **Internal — never exposed by public endpoints; only via admin-only variant endpoints**                        |
| `prom_discount_seen_at`   | Date \| null            | default: `null` — when `prom_discount_ratio` was last refreshed. **Internal — never exposed by public endpoints; only via admin-only variant endpoints**                  |
| `price_updated_at`        | Date \| null            | default: `null` — last successful price resolution (Prom sync)                                                                                                            |
| `stock_updated_at`        | Date \| null            | default: `null` — last successful stock sync; shown as `synced_at` on the price sheet                                                                                     |
| `status`                  | `ProductStatus` enum    | default: `ACTIVE` — `draft` \| `active` \| `archived`                                                                                                                     |
| `color_id`                | ObjectId → `colors` \| null | default: `null` — dictionary colour; `null` for categories with no colour axis                                                                                        |
| `color_family`            | `ColorFamily` \| null   | default: `null` — denormalized copy of `Color.family`; what the catalogue swatch filter matches on                                                                         |
| `createdAt` / `updatedAt` | Date                    | auto-managed (timestamps)                                                                                                                                                 |

Indexes: `{ product_id: 1 }`, `{ category_id: 1, status: 1 }`,
`{ category_id: 1, status: 1, color_family: 1 }` (the catalogue colour filter), unique
`{ slug: 1 }`, unique `{ sku: 1 }`. How the `prom_*` fields are written:
`src/docs/PROM_AVAILABILITY_SYNC.md`.

`color_family` is denormalized on purpose (TD-0002 §5.2.2): the catalogue aggregation already
joins `products` on every request, and a second join into `colors` just to filter would cost more
than keeping a copy that only changes when the dictionary is edited. `ColorService.update`
rewrites it across the colour's variants right after it writes the dictionary.

#### Public exposure

A public endpoint never returns a raw variant document. Responses go through the allowlist in
`src/modules/product/product-public.mappers.ts`:

- `toPublicVariant` — `id`, `name`, `slug`, `sku`, `price`, `price_updated_at`, `stock`, `images`,
  `v_value`, `status`, `color`. Used by `GET /products/by-slug/:slug` (the variant and its
  siblings). `color` is the resolved dictionary entry (`name_uk`, `name_en`, `family`,
  `hex_stops`) or `null`; the raw `color_id` and `color_family` stay internal.
- `PRICE_SHEET_PUBLIC_PROJECTION` — the `$project` stage of `GET /products/price-sheet`
  (see `src/docs/PRICE_SHEET.md`).

`vendor_product_sku`, `prom_id`, `prom_base_price`, `prom_discount_ratio` and
`prom_discount_seen_at` are absent from both. The only endpoints that return full variant documents
including them are **admin-only**: `GET /products/:id/variants` and
`GET /products/:id/variants/:variantId` (the admin UI needs the supplier identifiers to edit a
variant). `GET /products` (unpaginated dump) is admin-only as well. Guard details: `src/docs/RBAC.md`.

Only `status = active` variants are visible publicly: `GET /products/by-slug/:slug` returns 404 for
a `draft`/`archived` slug, and such variants are excluded from `catalog`, `search`, `price-sheet`,
`variants/slugs` (the sitemap source) and `variants/count` (its cache key). Draft and archived
variants are reachable only through the admin-only endpoints above.

---

### `colors`

Schema: `src/database/mongoose/schemas/color.schema.ts`

| Field                     | Type              | Notes                                                                              |
| ------------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `name_en`                 | string            | required, unique — canonical manufacturer name (`'Bambu Green'`)                    |
| `name_uk`                 | string            | required — Ukrainian name shown to shoppers (`'Зелений Bambu'`)                     |
| `slug`                    | string            | required, unique — derived from `name_en` when the client omits it                  |
| `family`                  | `ColorFamily`     | required — one of 15 swatch buckets; the value the catalogue filter groups by       |
| `hex_stops`               | string[]          | required — 1..6 ordered `#RRGGBB` stops; `hex_stops[0]` is the primary colour       |
| `order`                   | number            | default: `0` — display order in the swatch filter                                   |
| `createdAt` / `updatedAt` | Date              | auto-managed (timestamps)                                                          |

Index: `{ order: 1, name_en: 1 }`.

The stop count, not a separate flag, decides how a swatch is painted: one stop is a solid colour,
two or more a linear gradient, and `family: multicolor` a conic one, so a rainbow reads as a ring
rather than a stripe. The cap of six keeps a 22–30px swatch distinguishable.

`GET /colors` and `GET /colors/:id` are public — the dictionary is storefront data with nothing to
protect. Writes are ADMIN-only. A colour cannot be deleted while variants still reference it: the
request answers 409 instead of stranding `color_id` and freezing `color_family` at a value no
dictionary row explains.

---

### `landings`

Schema: `src/database/mongoose/schemas/landing.schema.ts`

| Field                     | Type                       | Notes                                                                                            |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `category_id`             | ObjectId → `categories`    | required — the category this page narrows                                                         |
| `slug`                    | string                     | required, unique **within the category** — public URL `/{categorySlug}/{slug}`                    |
| `h1`                      | string                     | required — page heading                                                                           |
| `title`                   | string                     | required — `<title>`                                                                              |
| `meta_description`        | string                     | required                                                                                          |
| `intro_html`              | string                     | default: `''` — rich text above the grid; **sanitized on write**                                  |
| `bottom_html`             | string                     | default: `''` — the main SEO copy below the grid; **sanitized on write**                          |
| `faq`                     | `{ q, a }[]`               | default: `[]` — markup stripped on write                                                          |
| `filters`                 | `Record<string, string[]>` | default: `{}` — pinned catalogue filters, attribute key to values                                 |
| `price_min` / `price_max` | number \| null             | default: `null` — optional pinned price window                                                    |
| `image`                   | string \| null             | default: `null`                                                                                   |
| `order`                   | number                     | default: `0`                                                                                      |
| `status`                  | `LandingStatus` enum       | default: `DRAFT` — `draft` \| `active`                                                            |
| `createdAt` / `updatedAt` | Date                       | auto-managed (timestamps)                                                                         |

Indexes: unique `{ category_id: 1, slug: 1 }`, `{ category_id: 1, status: 1, order: 1 }`.

Categories stay flat: a landing is a separate entity with pinned filters, not a nested category
(TD-0002 §5.2.3). `filters` keys are the ones `generateAttrKey` produces, so they move with
`ATTR_KEY_OVERRIDES`; a value may not contain a comma, because `ProductService.getCatalog` splits
query values on it — the DTO rejects one outright.

#### Public exposure

`draft` is unpublished copy and never leaves the backend through a public route:

- `GET /landings`, `GET /landings/slugs` and `GET /landings/slug/:categorySlug/:landingSlug` filter
  `status: 'active'`. An unknown category, an unknown slug and a draft are the same 404, so the
  storefront renders `notFound()` and no one learns that an unpublished page exists at that address.
- `GET /landings/admin` and `GET /landings/:id` return drafts and are therefore **ADMIN-only** —
  they are what the editor lists and loads.

`intro_html`, `bottom_html` and the FAQ entries are sanitized on write by
`src/common/utils/html.utils.ts`, the same helper product descriptions go through. Sanitizing on
write rather than on read means the stored value is the reviewed one, and every later consumer
(sitemap, Merchant feed) reuses it as-is.

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
  └── required_attributes[]  ← embedded, _id: false
  └── products (category_id → categories._id)
  └── product_variants (category_id → categories._id, denormalized from product)

products
  └── attributes[]      ← embedded, _id: false
  └── description       ← embedded, _id: false
  └── variant_type      ← embedded, _id: false
  └── product_variants (product_id → products._id)
        └── carts.items[].variant_id / orders.items[].variant_id → product_variants._id

nova_post_cities
  └── nova_post_warehouses (cityRef = nova_post_cities.ref)
```

---

## Embedding vs. Referencing Decisions

| Case                                                                     | Decision       | Reason                                                                                                                                                                        |
| ------------------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProductVariant` on `Product`                                            | **Referenced** | Own collection `product_variants`: variants are queried flat (catalog, search, price sheet, cart, Prom sync), carry their own `status` and need unique `slug` / `sku` indexes |
| `Attribute` / `RequiredAttribute` / `ProductDescription` / `VariantType` | **Embedded**   | Pure value objects; no independent identity needed                                                                                                                            |
| `Vendor` on `Product`                                                    | **Referenced** | Vendors are shared across products; queried independently                                                                                                                     |
| `Category` on `Product`                                                  | **Referenced** | Categories are queried independently and managed separately                                                                                                                   |
| `User` on `RefreshToken`                                                 | **Referenced** | Users are the primary entity; tokens are secondary                                                                                                                            |
| `ProductVariant` in `Cart.items`                                         | **Referenced** | Variants change (price, stock) — always read live data, never denormalize into cart                                                                                           |

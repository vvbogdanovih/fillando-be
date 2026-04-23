# Product Enrichment Flow

## Overview

When a product is returned from the API (`GET /api/products` or `GET /api/products/:id`),
its variant stock values may be **live data from an external API** rather than values stored in
MongoDB. Which source is used depends on the vendor attached to the product.

---

## Vendor Slug Convention

The `vendors` collection uses a `slug` field as a programmatic identifier.
Two slugs drive product behaviour:

| Slug        | Meaning                    | Stock source                           |
| ----------- | -------------------------- | -------------------------------------- |
| `fillando`   | Internal Fillando inventory | `variant.stock` stored in MongoDB      |
| `niceprice` | External NicePrice partner | Live call to NicePrice API per variant |

Any vendor whose slug is **not** `niceprice` uses stored stock. The slug `niceprice` is the only
value that triggers external API calls. It is defined as a constant in `product.service.ts`:

```ts
const NICEPRICE_SLUG = 'niceprice'
```

---

## Enrichment Logic (`ProductService.enrichProduct`)

Called for every product before it is returned to the client.

```
1. Fetch vendor document by product.vendor_id
2. If vendor not found OR vendor.slug !== 'niceprice':
     → return product unchanged (stored variant.stock values are used)
3. If vendor.slug === 'niceprice':
     → for each variant in product.variants:
         a. If variant has no vendor_product_sku → return variant unchanged
         b. Call NicePriceService.getStock(variant.vendor_product_sku)
         c. Overwrite variant.stock with the live value
     → return product with enriched variants
```

The enrichment runs in parallel across all variants (`Promise.all`).

---

## NicePriceService (`src/common/services/niceprice.service.ts`)

Current state: **stub**. `getStock()` logs the SKU and returns `0`.

```ts
async getStock(vendorProductSku: string): Promise<number>
```

**TODO**: Replace the stub body with a real HTTP call to the NicePrice API.
The following must be defined when integrating:

- API base URL and authentication method (API key / OAuth)
- Endpoint path and request shape for a single SKU stock lookup
- Response shape (which field holds the stock integer)
- Error handling strategy — current fallback is `0`; decide whether to surface errors to the client
  or silently fall back
- Rate limits and whether batch lookups are available (avoids N calls per product list)

---

## Data Model Relation

```
Product
  └─ vendor_id  ──►  Vendor (slug determines stock source)
  └─ variants[]
       └─ vendor_product_sku  ──►  NicePrice API key (only for niceprice vendor)
       └─ stock               ──►  Used directly for all other vendors
```

`subcategory_id` on `Product` is a string matching the `_id` of an embedded `Subcategory`
document inside the referenced `Category`. It is **not** a top-level collection reference.

---

## Response Shape Difference

A product from a **Fillando** vendor is returned as stored.
A product from a **NicePrice** vendor has its variant objects shallow-spread with the live `stock`:

```ts
// enriched variant shape
{ ...storedVariant, stock: <live value from NicePrice API> }
```

The rest of the product document is unchanged.

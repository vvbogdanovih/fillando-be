# Vendor API — UI Implementation Guide

## Overview

Vendors represent product suppliers. Each product is linked to exactly one vendor.
The vendor's `slug` drives stock-fetching behaviour at read time (see `PRODUCT_ENRICHMENT.md`).

---

## Data Model

| Field       | Type              | Notes                                            |
| ----------- | ----------------- | ------------------------------------------------ |
| `_id`       | string (ObjectId) | MongoDB-generated ID                             |
| `name`      | string            | Display name, unique                             |
| `slug`      | string            | Programmatic identifier, unique, lowercase-kebab |
| `createdAt` | ISO date string   | Auto-managed                                     |
| `updatedAt` | ISO date string   | Auto-managed                                     |

### Reserved slugs

| Slug        | Effect                                                   |
| ----------- | -------------------------------------------------------- |
| `fillando`   | Uses stored `variant.stock` from MongoDB                 |
| `niceprice` | Triggers live stock fetch from NicePrice API per variant |

Do **not** rename or delete these two vendors — doing so breaks product stock resolution.

---

## Endpoints

Base path: `/api/vendors`

### `GET /api/vendors/`

Returns all vendors. No auth required.

```json
[{ "_id": "...", "name": "Fillando", "slug": "fillando", "createdAt": "...", "updatedAt": "..." }]
```

### `GET /api/vendors/:id`

Returns one vendor by `_id`. No auth required. 404 if not found.

### `POST /api/vendors/`

Creates a vendor. **JWT required.**

```json
{ "name": "My Vendor", "slug": "my-vendor" }
```

Both fields required and must be unique.

### `PATCH /api/vendors/:id`

Partial update. **JWT required.** Body: any subset of `{ name, slug }`.

### `DELETE /api/vendors/:id`

Deletes a vendor. **JWT required.** 404 if not found.

> **Upcoming RBAC**: `POST`, `PATCH`, `DELETE` will be restricted to `ADMIN` role.
> See `RBAC.md`.

---

## Error Handling

| Status | Cause                          | Suggested UI message                          |
| ------ | ------------------------------ | --------------------------------------------- |
| `400`  | Validation error               | Show field errors from `message[]`            |
| `401`  | Missing / expired JWT          | Redirect to login                             |
| `404`  | Vendor not found               | "Vendor not found"                            |
| `409`  | `name` or `slug` already taken | "A vendor with this name/slug already exists" |

---

## UI Tasks — Please Implement

### 1. Vendor list page (admin area)

- Fetch `GET /api/vendors/` on mount
- Show `name` as the primary label, `slug` as secondary detail
- "Add vendor" button → opens create form
- Edit / Delete actions per row

### 2. Create / edit form

- `name` — text input, required
- `slug` — text input, required; **auto-generate from `name`** but allow manual override:
    ```ts
    const toSlug = (name: string) =>
    	name
    		.trim()
    		.toLowerCase()
    		.replace(/\s+/g, '-')
    		.replace(/[^a-z0-9-]/g, '')
    ```
- On create, warn if slug is a reserved value (`fillando`, `niceprice`)
- On success, refresh the vendor list

### 3. Vendor selector in product form

- Load vendor list via `GET /api/vendors/`
- Render as searchable `<select>` or combobox
- Submit selected vendor's `_id` as `vendor_id` in the product payload
- Show a hint when `niceprice` is selected: _"Stock will be fetched live from NicePrice"_

### 4. Relation note

`vendor_id` is required when creating a product. To change a product's vendor after creation,
send a `PATCH /api/products/:id` with `{ vendor_id: "<new id>" }`.

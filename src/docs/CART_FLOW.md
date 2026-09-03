# Cart Flow

Module: `src/modules/cart/`
Schema: `src/database/mongoose/schemas/cart.schema.ts`

---

## Design Decisions

- **One cart per user** — enforced via a unique index on `user_id`.
- **Lazy creation** — no cart document is created at registration. The document is created on the first write (add item or merge) via MongoDB upsert.
- **No guest cart** — unauthenticated users manage the cart client-side (localStorage). All endpoints require a valid JWT.
- **References only** — only `variant_id` + `quantity` are stored. Variant data (name, price, stock) is always fetched live when returning the cart. This prevents stale price/stock data.
- **No TTL** — cart documents live indefinitely.

---

## Endpoints

All routes are under `/cart` and require `JwtAuthGuard`. The user identity comes from the JWT payload — never from the request body.

| Method   | Path                     | Description                                                        |
| -------- | ------------------------ | ------------------------------------------------------------------ |
| `GET`    | `/cart`                  | Get cart with populated variants. Auto-removes out-of-stock items. |
| `POST`   | `/cart/merge`            | Post-login cart sync (see Merge Logic below).                      |
| `POST`   | `/cart/items`            | Add item or increment quantity.                                    |
| `PATCH`  | `/cart/items/:variantId` | Set absolute quantity for an item.                                 |
| `DELETE` | `/cart/items/:variantId` | Remove a specific item.                                            |
| `DELETE` | `/cart`                  | Clear all items.                                                   |

---

## Response Shape

All endpoints return the same envelope:

```json
{
	"items": [
		{
			"variant_id": "...",
			"quantity": 2,
			"added_at": "2024-01-01T00:00:00.000Z",
			"variant": {
				"name": "Футболка базова — Чорна",
				"slug": "futbolka-bazova-chorna",
				"price": 440,
				"stock": 10,
				"thumbnail": "https://cdn.example.com/...",
				"v_value": "Чорна"
			}
		}
	],
	"removed_items": []
}
```

`removed_items` is a list of `variant_id` strings that were silently removed because their stock dropped to 0. The frontend should display a notification when this array is non-empty.

---

## Stock Validation

**On add (`POST /cart/items`):**

- If `variant.stock === 0` → `409 Conflict`
- If `existing_quantity + dto.quantity > variant.stock` → `409 Conflict` with available count

**On update (`PATCH /cart/items/:variantId`):**

- If `variant.stock === 0` → `409 Conflict`
- If `dto.quantity > variant.stock` → `409 Conflict` with available count

**On `GET /cart` (auto-clean):**

- All items are checked against live stock. Items where `stock === 0` are silently removed from the cart document and returned in `removed_items`.

---

## Merge Logic (`POST /cart/merge`)

Called by the client immediately after a successful login to sync the localStorage cart with the server.

```
if server cart has items:
  → ignore client items, return server cart (client discards localStorage cart)

if server cart is empty (or doesn't exist):
  → validate each client item against stock
  → skip items where variant not found or stock === 0  (added to removed_items)
  → cap quantity at available stock (Math.min)
  → set these as the cart items (upsert)
  → return populated cart + removed_items
```

---

## Module Dependencies

`CartModule` imports `ProductModule` to access `ProductVariantRepository` for stock validation and response population. There is no circular dependency — `ProductModule` does not import `CartModule`.

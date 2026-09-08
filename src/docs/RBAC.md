# Role-Based Access Control (RBAC)

## Current State

`RolesGuard` + `@Roles(Role.ADMIN)` is enforced on **every write endpoint** of `ProductModule`,
`VendorModule` and `UploadModule`, and on all modules that were already role-guarded before
(`CategoryModule`, `PaymentDetailsModule`, `PaymentProvidersModule`, the admin part of
`OrderModule`, `UsersModule` list, `DiscountCouponModule`, `WholesaleInquiryModule`,
`NovaPostModule` / `PromModule` sync). Reads that would expose a supplier are admin-only as well —
`GET /products` (unpaginated full dump), `GET /products/:id/variants` and
`GET /products/:id/variants/:variantId` (full variant documents including supplier identifiers),
`GET /products/:id` (the product document carries `vendor_id`) and every read of `VendorModule`
(`GET /vendors`, `GET /vendors/check-availability`, `GET /vendors/:id` — a `Vendor` *is* a
supplier) — see [Admin-only reads](#admin-only-reads). `VendorModule` therefore has no public route
at all. The complete list is in
[Enforced Admin-Only Endpoints](#enforced-admin-only-endpoints).

Two behaviour changes landed together with that work (closes `todo/AUDIT_CRITICAL.md` #3):

1. **`@Roles(...)` is typed.** The decorator signature is `(...roles: Role[])`, so string
   literals such as `@Roles('ADMIN')` no longer compile — use `Role.ADMIN`. Previously a typo
   (`@Roles('ADMN')`) compiled fine and silently locked the endpoint for everyone.
2. **`RolesGuard` is default-deny.** A handler guarded by `RolesGuard` that has no `@Roles(...)`
   metadata (on the handler or its class) is rejected with 403 — it is treated as a
   misconfiguration, not as a public route. A request with no `req.user` or no `user.role` is
   also rejected with 403. Before this change the guard let the request through when no roles
   were set. Because it reads `req.user`, `RolesGuard` must always follow `JwtAuthGuard`.

Available roles (`src/common/types/enums.ts`):

```ts
enum Role {
	USER = 'USER',
	ADMIN = 'ADMIN'
}
```

Registration and login default to `Role.USER`. The `ADMIN` role must be assigned directly in
the database for now (no promotion endpoint exists yet).

---

## Available Pieces

### `@Roles(...roles: Role[])` decorator

`src/common/decorators/roles.decorator.ts`

Sets `ROLES_KEY` (`'roles'`) metadata on a route handler or a controller class. Accepts only
`Role` enum members.

```ts
import { Roles } from 'src/common/decorators/roles.decorator'
import { Role } from 'src/common/types/enums'

@Roles(Role.ADMIN)
@Post(ENDPOINTS.VENDORS.CREATE)
create(@Body() dto: CreateVendorDto) { ... }
```

### `RolesGuard`

`src/common/guards/roles.guard.ts`

Reads the required roles from handler metadata, falling back to class metadata
(`reflector.getAllAndOverride`), and returns `requiredRoles.includes(req.user.role)`.

Denies (`false` → 403 Forbidden) when:

- no `@Roles(...)` metadata exists on the handler or the class;
- `req.user` is missing, or `req.user.role` is missing;
- the user's role is not in the required list.

**Must run after `JwtAuthGuard`** — always `@UseGuards(JwtAuthGuard, RolesGuard)`, in that
order. Guards listed in one `@UseGuards(...)` run left to right: `JwtAuthGuard` validates the
token and populates `req.user`, so an unauthenticated request fails there with 401 before
`RolesGuard` is reached. `RolesGuard` on its own (without `JwtAuthGuard`) sees no `req.user`
and rejects everyone.

```ts
import { UseGuards } from '@nestjs/common'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'

@Post(ENDPOINTS.VENDORS.CREATE)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
create(@Body() dto: CreateVendorDto) { ... }
```

Class-level usage — every handler in the controller becomes admin-only (this is how
`UploadController` is guarded):

```ts
@Controller(ENDPOINTS.UPLOAD.BASE)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class UploadController { ... }
```

---

## Enforced Admin-Only Endpoints

Every endpoint below requires `JwtAuthGuard` + `RolesGuard` + `@Roles(Role.ADMIN)`. Paths are
shown as the app serves them — the app has **no global prefix**; nginx prepends `/api` in
production only.

| Module                   | Admin-only endpoints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Public / user-owned in the same module                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProductModule`          | Writes: `POST /products` (create), `POST /products/validate`, `PATCH /products/:id`, `DELETE /products/:id`, `POST /products/:id/variants` (add variant), `PATCH /products/:id/variants/:variantId`, `DELETE /products/:id/variants/:variantId`, `PATCH /products/:id/variants/:variantId/images`, `POST /products/price-list/pdf`. Reads: `GET /products` (unpaginated dump), `GET /products/:id` (raw document incl. `vendor_id`), `GET /products/:id/variants`, `GET /products/:id/variants/:variantId` (full documents incl. `vendor_product_sku` / `prom_id` / `prom_*`) | Public GETs (projected, `status = active` only): `/products/catalog` (throttled, 120/min), `/products/search`, `/products/variants/slugs`, `/products/variants/count`, `/products/price-sheet`, `/products/by-slug/:slug` |
| `VendorModule`           | All: `GET /vendors`, `GET /vendors/check-availability`, `GET /vendors/:id`, `POST /vendors`, `PATCH /vendors/:id`, `DELETE /vendors/:id`                                                                                                                                                                                                                                                                                                                                                                                 | — (a vendor is a supplier; nothing here is public)                                                                                                                                                                                                                   |
| `UploadModule`           | All (class-level): `POST /upload/presign`, `POST /upload/confirm`, `DELETE /upload`                                                                                                                                                                                                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                                    |
| `CategoryModule`         | `POST /categories`, `PATCH /categories/:id`, `PUT /categories/:id`, `DELETE /categories/:id`                                                                                                                                                                                                                                                                                                                                                                                                                            | Public GETs: `/categories`, `/categories/slug/:slug`, `/categories/:id`                                                                                                                                                                                              |
| `PaymentDetailsModule`   | All: `GET /payment-details`, `GET /payment-details/active`, `GET /payment-details/:id`, `POST /payment-details`, `PATCH /payment-details/:id`, `DELETE /payment-details/:id`, `PATCH /payment-details/:id/activate`                                                                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                                    |
| `PaymentProvidersModule` | `GET /payment-providers`, `GET /payment-providers/:id`, `POST /payment-providers`, `PATCH /payment-providers/:id`, `DELETE /payment-providers/:id`, `PATCH /payment-providers/:id/activate`                                                                                                                                                                                                                                                                                                                             | Public: `GET /payment-providers/active/:provider`                                                                                                                                                                                                                    |
| `OrderModule`            | `GET /orders`, `GET /orders/:id`, `PATCH /orders/:id`, `PATCH /orders/:id/status`, `PATCH /orders/:id/payment-status`, `PATCH /orders/:id/ttn`, `POST /orders/:id/invoice`, `POST /orders/:id/vendor-email`, `POST /orders/report`                                                                                                                                                                                                                                                                                      | `POST /orders` (`OptionalJwtAuthGuard`, guest checkout); user-owned with `JwtAuthGuard` only: `GET /orders/me`, `GET /orders/me/:id`                                                                                                                                 |
| `UsersModule`            | `GET /users`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | User-owned with `JwtAuthGuard` only: `GET /users/me`, `PATCH /users/me`                                                                                                                                                                                              |
| `DiscountCouponModule`   | `GET /discount-coupons`, `GET /discount-coupons/:id`, `POST /discount-coupons`, `PATCH /discount-coupons/:id`, `DELETE /discount-coupons/:id`                                                                                                                                                                                                                                                                                                                                                                           | Public: `POST /discount-coupons/validate`                                                                                                                                                                                                                            |
| `WholesaleInquiryModule` | `GET /wholesale-inquiries`, `PATCH /wholesale-inquiries/:id/status`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Public: `POST /wholesale-inquiries`                                                                                                                                                                                                                                  |
| `NovaPostModule`         | `GET /nova-post/sync` (SSE)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Public GETs: `/nova-post/cities`, `/nova-post/warehouses`                                                                                                                                                                                                            |
| `PromModule`             | `GET /prom/sync-availability` (SSE)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                                    |
| `FeedModule`             | `POST /feeds/google-shopping/regenerate`, `GET /feeds/google-shopping/status` | Public GET: `/feeds/google-shopping.xml` (the Google Shopping feed — ACTIVE variants only, no supplier values; see `MERCHANT_FEED.md`) |

Not role-guarded by design: `AuthModule` (`/auth/*`, issues its own tokens), `LiqpayModule`
(`/liqpay/*`, payment callback), and `CartModule` (`/cart/*`, `JwtAuthGuard` only — the cart is
a user-owned resource).

---

## Admin-only reads

GETs on catalogue data are public by default, with one exception: **a GET that returns
supplier/internal fields or an unpaginated dump is admin-only.** In `ProductModule` that is:

| Endpoint                                | Why admin-only                                                                                                                                                                              | Consumer      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `GET /products`                         | Returns every product without pagination or status filter. The storefront lists via `/products/catalog`.                                                                                    | Admin UI only |
| `GET /products/:id`                     | Returns the raw `products` document, and it carries `vendor_id` — which supplier the product is bought from. The storefront reads `/products/by-slug/:slug`.                                | Admin UI only |
| `GET /products/:id/variants`            | Returns full `product_variants` documents — `vendor_product_sku`, `prom_id`, `prom_base_price`, `prom_discount_ratio`, `prom_discount_seen_at` — for every status incl. `draft`/`archived`. | Admin UI only |
| `GET /products/:id/variants/:variantId` | Same document shape for a single variant.                                                                                                                                                   | Admin UI only |
| `GET /vendors`                          | The supplier list itself.                                                                                                                                                                   | Admin UI only |
| `GET /vendors/:id`                      | A single supplier record.                                                                                                                                                                   | Admin UI only |
| `GET /vendors/check-availability`       | Answers whether a supplier name or slug is taken — a public probe confirms which suppliers exist.                                                                                           | Admin UI only |

The admin UI **needs** `vendor_product_sku` / `prom_id` to edit a variant, so these endpoints are
guarded rather than projected: same `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.ADMIN)`
as a write. The admin frontend calls them through the cookie-authenticated `httpService`, so an
`ADMIN` session keeps working unchanged; a `USER` gets 403 and an anonymous caller 401. A malformed
`:id` / `:variantId` on the two variant GETs is a 404 (`Types.ObjectId.isValid` check in the
service), not a `BSONError` 500. Their Swagger `summary` carries an `(admin)` suffix and the
`description` starts with `Admin-only`.

Everything the storefront reads goes through public endpoints that return a **projection**, not a
document, and list only `status = active` variants (`ProductStatus.ACTIVE`):

- `GET /products/by-slug/:slug` — `toPublicVariant` allowlist (`id`, `name`, `slug`, `sku`, `price`,
  `price_updated_at`, `stock`, `images`, `v_value`, `status`, `color`, `weight_g`) for the variant
  and its siblings, `toPublicAttributes` for `product.attributes` (`k`, `l`, `v`, `unit`), plus
  `product.manufacturer` from the «Виробник» attribute. A `draft` slug → 404;
  an `archived` slug → 200 with `status: archived` (the discontinued product page, TD-0006 §5.4) —
  siblings stay `active`-only.
- `GET /products/price-sheet` — `PRICE_SHEET_PUBLIC_PROJECTION`; search no longer matches
  `vendor_product_sku`. See `src/docs/PRICE_SHEET.md`.
- `GET /products/variants/slugs` — sitemap source, active slugs only.
- `GET /products/variants/count` — counts the same active set (the storefront uses it as the
  sitemap cache key, so archiving a variant must change it).
- `GET /products/catalog`, `GET /products/search` — storefront projections, active only.

The allowlists live in `src/modules/product/product-public.mappers.ts` — `toPublicVariant` for the
variant and its siblings, `toPublicAttributes` for `product.attributes` (`k`, `l`, `v`, plus the
`unit` the category declares for that key). `GET /products/:id` used to be public on the grounds
that a `Product` document is only the shared header; it is not — the header includes `vendor_id`,
so it is now guarded like the variant reads. The projection rules are in
`src/docs/API_AND_SWAGGER.md` §4 "Public projections".

---

## How to Apply

1. Add `RolesGuard` to the guards list **after** `JwtAuthGuard`: `@UseGuards(JwtAuthGuard, RolesGuard)`.
2. Add `@Roles(Role.ADMIN)` to the handler, or to the controller class when every handler is admin-only.
3. Never put `RolesGuard` on a handler without `@Roles(...)` — the guard is default-deny, so the
   endpoint would return 403 for everyone, including admins.
4. Add a case to the module's `*.controller.rbac.spec.ts` (see [Testing](#testing)).

Rule of thumb: write endpoints on catalogue/admin resources (products, vendors, categories,
uploads, payment settings, order management, coupons) are `ADMIN`; so is any **read** that returns
supplier/internal fields (`vendor_product_sku`, `prom_id`, `prom_*`) or an unpaginated dump — if
the storefront needs part of that data, add a projected public endpoint instead of opening the
document. User-owned resources (`/cart`, `/users/me`, `/orders/me`) use `JwtAuthGuard` alone and
scope by `req.user.id` in the service.

---

## Testing

RBAC is covered by supertest-based controller specs that boot only the controller under test —
no database, they run with plain `yarn test`:

- `src/common/testing/rbac-harness.ts`
    - `createRbacApp({ controllers, providers })` — boots a minimal Nest app with the given
      controller and stubbed service providers, overriding `JwtAuthGuard` with
      `HeaderRoleAuthGuard`. `RolesGuard` stays **real**, so the actual guard chain is exercised.
      Global pipes from `main.ts` are not registered — the specs test guards, not DTO validation.
    - `HeaderRoleAuthGuard` — reads the `x-test-role` header (`TEST_ROLE_HEADER`): no header →
      401 (like the real guard on a missing token); header present → `req.user` is populated with
      that `role`.
    - `send(app, method, path, { role?, body? })` — supertest shorthand that sets the header when
      `role` is given.
- `*.controller.rbac.spec.ts` next to each controller — table-driven (`it.each`): for every
  admin-only endpoint (writes **and** the admin-only GETs — `GET /products`, `GET /products/:id`,
  `GET /products/:id/variants`, `GET /products/:id/variants/:variantId`, all three vendor GETs,
  every read of `/payment-details`) assert 401 with no header,
  403 for `Role.USER`, 2xx for `Role.ADMIN`, and that the stubbed service method was called exactly
  once only in the ADMIN case; for every public GET assert 200 without a header. An admin-only GET
  belongs in the admin table, never in `PUBLIC_GETS` — a row in the wrong table is a red flag in
  review, because the harness would then assert the endpoint is open.
- `src/common/guards/roles.guard.spec.ts` — unit tests for the guard itself (default-deny, missing
  user/role, handler-then-class lookup order). Real class-level `@Roles` resolution is covered
  end-to-end by the upload spec (`UploadController` is guarded at class level).

**Adding a case for a new endpoint:**

1. Add a row `[method, path, body, serviceMock]` to the admin table (`ADMIN_ENDPOINTS` in the
   product spec, `WRITE_ENDPOINTS` in vendor/upload) or to `PUBLIC_GETS` in the module's
   `*.controller.rbac.spec.ts`. For a new module, create
   `<module>.controller.rbac.spec.ts` next to the controller and build the app with
   `createRbacApp`, passing `{ provide: XService, useValue: stub }` for each constructor
   dependency (controllers that inject `PinoLogger` also need
   `{ provide: getLoggerToken(XController.name), useValue: noopLogger }` — see the upload spec).
2. Stub the service method the handler calls with `jest.fn().mockResolvedValue({})`. A missing
   stub surfaces as a 500 in the ADMIN case, never as a 403, so guard results cannot be masked.
3. Pass a `body` (`{}` is enough) whenever the handler dereferences the DTO.

### Modules covered by a spec

| Module                   | Spec                                          | What it pins                                                                                                                                          |
| ------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProductModule`          | `product.controller.rbac.spec.ts`             | 13 admin endpoints (writes + the four full-document reads), 6 public storefront GETs                                                                  |
| `VendorModule`           | `vendor.controller.rbac.spec.ts`              | all 6 endpoints admin-only — the module has no public route                                                                                           |
| `UploadModule`           | `upload.controller.rbac.spec.ts`              | class-level `@UseGuards` + `@Roles`, all 3 endpoints                                                                                                  |
| `ColorModule`            | `color.controller.rbac.spec.ts`               | 3 writes admin-only, 2 public reads, `GET /colors/admin` admin-only and not swallowed by `/:id`                                                       |
| `LandingModule`          | `landing.controller.rbac.spec.ts`             | writes admin-only, the draft-exposing reads admin-only, the `status: active` reads public                                                             |
| `FeedModule`             | `feed.controller.rbac.spec.ts`                | regenerate + status admin-only, `google-shopping.xml` public                                                                                          |
| `CategoryModule`         | `category.controller.rbac.spec.ts`            | 4 writes admin-only (`PUT /:id` has its own row next to `PATCH /:id`), 3 public reads, `/slug/:slug` not swallowed by `/:id`                          |
| `OrderModule`            | `order.controller.rbac.spec.ts`               | 9 admin endpoints, 3 user-owned (`JwtAuthGuard` only, USER must pass), 3 guest endpoints, route order around `/:id`, and the three `@Throttle` limits |
| `PaymentDetailsModule`   | `payment-details.controller.rbac.spec.ts`     | all 7 endpoints admin-only, reads included — the shop's own IBAN; `/active` not swallowed by `/:id`                                                   |
| `UsersModule`            | `users.controller.rbac.spec.ts`               | `GET /users` admin-only; `GET`/`PATCH /users/me` need a token and **no** role, and the caller's id reaches the service                                |
| `WholesaleInquiryModule` | `wholesale-inquiry.controller.rbac.spec.ts`   | inbox + status write admin-only, `POST /wholesale-inquiries` public (the storefront form)                                                             |
| `AuthModule`             | `auth.controller.throttle.spec.ts`            | `ThrottlerGuard` + `@Throttle` on login (10/min), register (10/min), refresh (30/min); failed logins count; the limits are per handler                |
| `DiscountCouponModule`   | `discount-coupon.controller.throttle.spec.ts` | the 20/min limit on `POST /discount-coupons/validate` and the internal-token bypass                                                                   |
| `ProductModule`          | `product.controller.throttle.spec.ts`         | the 120/min limit on `GET /products/catalog` and the internal-token bypass                                                                            |

Every one of these specs also lists its **public** endpoints explicitly, not just the guarded
ones. A guard added to a public route breaks the shop as thoroughly as a missing guard exposes
it — an anonymous `POST /orders` (guest checkout), `POST /wholesale-inquiries` (the wholesale
form), `GET /categories` (the header menu) or the `/orders/lookup/:orderNumber` link in the
confirmation email would simply start answering 401, with nothing in the logs to say why. The
public rows are therefore assertions, not documentation.

Three details of the harness worth knowing before writing the next spec:

- **Guard order is proved by two assertions, not by reading the decorator.** `RolesGuard` reads
  `req.user.role`, so `@UseGuards(RolesGuard, JwtAuthGuard)` answers before the token is
  validated: an anonymous caller gets 403 instead of 401, and a real ADMIN gets 403 too. "401
  without a token" plus "2xx for ADMIN" is what tells the correct order from the swapped one.
- **A missing `@Roles(...)` shows up in the ADMIN case only.** `RolesGuard` is default-deny, so
  dropping the decorator returns 403 for everyone — the 401 and USER rows stay green. Never
  write a spec that omits the ADMIN row.
- **`OptionalJwtAuthGuard` is not overridden by the harness** (only `JwtAuthGuard` is). A
  controller that uses it — `POST /orders`, `GET /auth/me` — needs a passport `'jwt'` strategy
  registered, or the request dies at "Unknown authentication strategy". `order.controller.rbac.spec.ts`
  registers a header-reading stand-in strategy (same `x-test-role` convention as the harness)
  and keeps the real guard, which is what makes its guest-checkout assertions meaningful.

### Rule for a new controller

A new controller that carries a **write endpoint** — or a read that returns a full document —
arrives with its own `*.controller.rbac.spec.ts` in the same PR. Not a follow-up, not a
TODO: the spec is part of the endpoint, the same way its DTO is. A **new or changed** write
endpoint without a row in its module's RBAC spec is a review blocker. Rate-limited handlers get
the same treatment: `@UseGuards(ThrottlerGuard)` + `@Throttle(...)` comes with a case in a
`*.controller.throttle.spec.ts` (or, where the module already has one, in its RBAC spec — see
`OrderModule`) plus a row in `API_AND_SWAGGER.md` §4a.

Still without an RBAC spec: `PaymentProvidersModule`, `DiscountCouponModule` (throttling is
covered, the role guards are not), `CartModule`, `LiqpayModule`, `NovaPostModule`, `PromModule`.
Writing one is ~30 lines with `createRbacApp`.

**Known gap, not covered by a passing test:** `POST /wholesale-inquiries` is the only
unauthenticated write in the backend with no `ThrottlerGuard` — `POST /orders` is capped at
10/min, `POST /discount-coupons/validate` at 20/min, `POST /auth/login` at 10/min. A skipped
test in `wholesale-inquiry.controller.rbac.spec.ts` holds the behaviour it should have
(10/min, 429 with `Retry-After`); enable it together with the decorator and the §4a row.

Integration specs (`*.int-spec.ts`, run with `yarn test:db:up && yarn test:integration`) use the
disposable MongoDB from `docker-compose.test.yml` via `test/integration-db.ts`; the RBAC specs do
not need it.

The public-projection guarantees (active-only visibility, allowlisted fields, no
`vendor_product_sku` / `prom_id` / `prom_*` in public responses) are **not** RBAC and are covered
separately: `src/modules/product/product-public.mappers.spec.ts` pins the exact key set of each
allowlist, and the `ProductVariantRepository` `*.int-spec.ts` runs `findPriceSheet`,
`findAllSlugs` and `findVariantWithProduct` against seeded `draft` / `active` / `archived` variants
on the disposable MongoDB (`archived` is found by `findVariantWithProduct` only, still through the
public allowlist). Changing a public response shape means updating those specs, not the RBAC spec.

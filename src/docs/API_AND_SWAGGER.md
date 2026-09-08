# API endpoints and Swagger documentation

This guide explains how to add new endpoints and how to keep Swagger docs in sync.

---

## 1. What is responsible for what

| Part               | File(s)                                               | Responsibility                                                                                                                                                         |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Route path**     | `src/common/constants/endpoints.constant.ts`          | Base path and path segments for each endpoint (e.g. `/auth`, `/login`). Single source of truth for URLs.                                                               |
| **Operation docs** | `src/common/constants/docs/api-operation.constant.ts` | Swagger **summary** and **description** for each endpoint. Used by `@ApiOperation()` in controllers.                                                                   |
| **Property docs**  | `src/common/constants/docs/api-property.constant.ts`  | Swagger **example**, **description**, **minLength** etc. for DTO fields. Used by `@ApiProperty()` in DTOs.                                                             |
| **Controller**     | `src/modules/<module>/<module>.controller.ts`         | Declares HTTP method + path, guards, and calls the service. Adds `@ApiTags`, `@ApiOperation()`.                                                                        |
| **Service**        | `src/modules/<module>/<module>.service.ts`            | Business logic: validation, DB, external APIs. No HTTP or Swagger.                                                                                                     |
| **DTO**            | `src/modules/<module>/dto/*.dto.ts`                   | Request/response shape + validation (`class-validator`) + Swagger (`@ApiProperty()`).                                                                                  |
| **Swagger UI**     | `src/main.ts`                                         | `DocumentBuilder` + `SwaggerModule.setup('swagger', app, document)` (or `<prefix>/swagger` when a global prefix is set). Docs are generated from controllers and DTOs. |

---

## 2. How to create a new endpoint

### Step 1: Add path and operation text

**`src/common/constants/endpoints.constant.ts`**

- Add the path for your module/action (e.g. `MY_ACTION: '/my-action'`).

**`src/common/constants/docs/api-operation.constant.ts`**

- Add an object with `summary` and `description` for this endpoint (e.g. under the right module key).

Example for a new “Get item” under a `items` module:

```ts
// endpoints.constant.ts
ITEMS: {
  BASE: '/items',
  GET_ONE: '/:id',
},

// api-operation.constant.ts
ITEMS: {
  GET_ONE: {
    summary: 'Get one item',
    description: 'Returns item by id',
  },
},
```

### Step 2: DTO (if the endpoint has a body or you want to document response)

**`src/modules/<module>/dto/<name>.dto.ts`**

- Define the class and use `@ApiProperty()` so Swagger shows the schema.
- Use shared texts from `API_PROPERTY` when possible (e.g. email, password).
- Add validation with `class-validator` (`@IsString()`, `@MinLength()`, etc.).

If you add a new reusable field description, add it to **`src/common/constants/docs/api-property.constant.ts`** and use it in the DTO.

Example:

```ts
// api-property.constant.ts — add if needed
export const API_PROPERTY = {
	// ...
	ITEM_ID: { example: '123', description: 'Item id' }
}

// dto/get-item.dto.ts
import { ApiProperty } from '@nestjs/swagger'
import { IsString } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'

export class GetItemParamDto {
	@ApiProperty(API_PROPERTY.ITEM_ID)
	@IsString()
	id: string
}
```

### Step 3: Controller

**`src/modules/<module>/<module>.controller.ts`**

- Use `@Controller(ENDPOINTS.<MODULE>.BASE)` and `@ApiTags(ENDPOINTS.<MODULE>.BASE)` so all routes are under one tag.
- For each method:
    - Use `@Get()`, `@Post()`, etc. with the path from `ENDPOINTS`.
    - Use `@ApiOperation(API_OPERATION.<MODULE>.<ACTION>)` so Swagger shows the right summary/description.
    - Use `@Body()`, `@Param()`, `@Query()` with your DTOs so Swagger shows request body/params/query.
    - Call the service and return the response.

Example:

```ts
@Get(ENDPOINTS.ITEMS.GET_ONE)
@ApiOperation(API_OPERATION.ITEMS.GET_ONE)
async getOne(@Param() params: GetItemParamDto) {
  return this.itemsService.getOne(params.id);
}
```

### Step 4: Service

**`src/modules/<module>/<module>.service.ts`**

- Add a method that implements the logic (DB, validation, etc.) and returns the data. Controllers only call the service and send the response.

### Step 5: Module

- Register the controller and service in the module if they are new. If the module already exists, just add the new method and route.

---

## 3. Swagger documentation checklist

When adding or changing an endpoint:

1. **Paths** — Add or update the path in `endpoints.constant.ts`.
2. **Operation text** — Add or update `summary` and `description` in `api-operation.constant.ts` and use it in the controller with `@ApiOperation(API_OPERATION.<MODULE>.<ACTION>)`.
3. **Tags** — Controller has `@ApiTags(ENDPOINTS.<MODULE>.BASE)` so the endpoint appears in the right group in Swagger.
4. **Request body/params/query** — Use DTOs with `@ApiProperty()` (and `API_PROPERTY` where it fits) so Swagger shows the schema and examples.
5. **Response** — Optionally use `@ApiResponse()` on the controller method if you want to document status codes and response shape.

Shared descriptions (e.g. “User email”, “Password”) live in **`api-property.constant.ts`** and are reused in DTOs via `API_PROPERTY.*`.

---

## 4. Guard convention

**GET endpoints on catalogue data are public by default** — with one exception: **a GET that
returns supplier/internal fields or an unpaginated dump of a collection is admin-only.** Everything
else falls into one of two buckets:

1. **Catalogue / admin resources** (products, vendors, categories, uploads, payment settings,
   order management, coupons, sync jobs) — every write endpoint, and any read that exposes
   admin data, is **admin-only**: `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.ADMIN)`.
2. **User-owned resources** (`/cart/*`, `/users/me`, `/orders/me`) — `JwtAuthGuard` alone; the
   service scopes the query by `req.user.id`.

Admin-only reads today: `GET /products` (unpaginated full dump, used only by the admin UI),
`GET /products/:id/variants` and `GET /products/:id/variants/:variantId` (full variant documents
including `vendor_product_sku`, `prom_id` and the `prom_*` pricing fields, which the admin UI needs
to edit a variant), `GET /products/:id` (the raw product document carries `vendor_id` — which
supplier the product is bought from) and **every** read of `VendorModule` — `GET /vendors`,
`GET /vendors/check-availability`, `GET /vendors/:id` — because a `Vendor` **is** a supplier. They
are guarded exactly like writes. When the storefront needs part of the same data, it gets a
**projection** on a separate public endpoint — never the raw document with a hope that the client
ignores the extra fields (see [Public projections](#public-projections) below).

The rule has no exception for "the field is harmless on its own": the shop resells at supplier
price + margin, so the *link* between a product and its supplier is enough to look the supplier's
price up. Before closing such an endpoint, check who calls it — every consumer of these five was in
`fillando-fe/src/app/admin/**`, which talks to the API through the cookie-authenticated
`httpService`, so an `ADMIN` session keeps working unchanged.

```ts
import { UseGuards } from '@nestjs/common'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'

// Admin-only write on a catalogue resource
@Post(ENDPOINTS.ITEMS.CREATE)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiOperation(API_OPERATION.ITEMS.CREATE)
create(@Body() dto: CreateItemDto) {
  return this.itemsService.create(dto)
}

// User-owned resource — authenticated, scoped by the caller's id
@Get(ENDPOINTS.ITEMS.MY)
@UseGuards(JwtAuthGuard)
@ApiOperation(API_OPERATION.ITEMS.MY)
findMine(@Req() req: Request & { user: JWTPayload }) {
  return this.itemsService.findByUser(req.user.id)
}
```

Rules that matter:

- **Order of guards matters.** `JwtAuthGuard` must come first — it validates the cookie and
  sets `req.user`; `RolesGuard` reads `req.user.role`. Reversed or alone, `RolesGuard` sees no
  user and rejects everyone.
- **`RolesGuard` is default-deny.** Without `@Roles(...)` on the handler or class it returns
  403 for every caller. Never add `RolesGuard` without a matching `@Roles(...)`.
- **`@Roles` takes `Role[]`**, not strings — `@Roles('ADMIN')` is a compile error; use
  `@Roles(Role.ADMIN)`.
- `@Roles` + `@UseGuards` may be placed on the controller class when every handler is admin-only
  (see `UploadController`).
- Add a case for every new guarded endpoint to the module's `*.controller.rbac.spec.ts`.

Full endpoint list, guard internals and the test harness: `src/docs/RBAC.md`.

### Public projections

A public endpoint never returns a raw Mongoose document. Its response is built from an explicit
**allowlist** — a mapper or an aggregation `$project` stage — so a new schema field is private until
someone decides otherwise. For the product domain the allowlists live in
`src/modules/product/product-public.mappers.ts`:

| Export                                               | Used by                                                                 | Fields                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `toPublicVariant(variant)` + `PUBLIC_VARIANT_FIELDS` | `GET /products/by-slug/:slug` (the variant and its siblings)            | `id`, `name`, `slug`, `sku`, `price`, `price_updated_at`, `stock`, `images`, `v_value`, `status`, `color`, `weight_g`       |
| `toPublicAttributes(attributes, requiredAttributes)`  | `GET /products/by-slug/:slug` (`product.attributes`)                    | `k`, `l`, `v`, `unit`                                                                                                       |
| `PRICE_SHEET_PUBLIC_PROJECTION`                      | `ProductVariantRepository.findPriceSheet` → `GET /products/price-sheet` | `id`, `product_name`, `slug`, `v_value`, `sku`, `price`, `stock`, `stock_updated_at`, `image`, `attributes`, `variant_type` |

Never on either list: `vendor_product_sku`, `prom_id`, `prom_base_price`, `prom_discount_ratio`,
`prom_discount_seen_at` — the shop resells at supplier price + margin, so any of them lets a visitor
derive the margin. Public product endpoints also list only `status = active` variants
(`ProductStatus.ACTIVE`) — the price sheet, `GET /products/variants/slugs` (sitemap source) and
`GET /products/variants/count` (its cache key), `catalog`/`search`. `GET /products/by-slug/:slug`
additionally resolves an `archived` slug (200, `status: archived`, for the discontinued product
page — TD-0006 §5.4); a `draft` slug → 404. The response also carries `product.manufacturer`,
read from the «Виробник» attribute with the same `pickAttr(MANUFACTURER_PATTERNS)` the price sheet
uses — `Vendor` is the supplier and is never exposed as the brand.

`product.attributes` goes through `toPublicAttributes` for the same reason, and is the one place a
field is joined **in** rather than dropped: each attribute carries the `unit` its category declares
for that key (`categories.required_attributes[].unit`), so the specification table prints
«Вага | 1 кг» instead of «Вага | 1». `unit` is `null` when the category has no entry for the key or
that entry has no unit, and the key is always present so the row shape does not vary. Units are the
only addition — the supplier rule above stays absolute.

Rules:

- **Adding a field to a public response = update the mapper/projection and its spec.**
  `product-public.mappers.spec.ts` pins the exact key set of each projection, so a field added to
  the mapper without a spec change fails the build, and a field added to the schema never appears
  publicly on its own. Treat the change as a security review, not a routine edit; re-run
  `yarn spec:export` afterwards as for any contract change.
- The allowlist sits at the repository/projection boundary, not only in a service mapper —
  otherwise a second consumer of the same repository method leaks the fields again. The Google
  Shopping feed (`ProductVariantRepository.findActiveForFeed`, `src/docs/MERCHANT_FEED.md`) is the
  third public projection and follows the same rule: an explicit `$project`, ACTIVE only, pinned by
  the int-spec.
- A field the admin UI needs but the public must not see is **not** projected: the endpoint that
  returns it becomes admin-only instead (this is why `GET /products/:id/variants` and
  `GET /products/:id/variants/:variantId` are guarded).
- Mark an admin-only endpoint in Swagger so the contract shows the guard without reading the
  controller: `(admin)` suffix on the `summary` and a leading `Admin-only` in the `description`
  (see `API_OPERATION.PRODUCTS.GET_ALL`, `GET_VARIANTS`, `PRICE_LIST_PDF`).

---

## 4a. Rate limiting

`@nestjs/throttler` is configured in `app.module.ts` **without** a global guard — a per-IP
limit on the public catalogue would throttle our own SSR traffic (one container = one IP).
Limits are opt-in per handler:

```ts
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'

@Post(ENDPOINTS.AUTH.LOGIN)
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
login(...) {}
```

| Endpoint                                           | Limit (per IP, per minute) |
| -------------------------------------------------- | -------------------------- |
| `POST /auth/login`, `POST /auth/register`          | 10                         |
| `POST /auth/refresh`                               | 30                         |
| `POST /orders`                                     | 10                         |
| `POST /liqpay/checkout`                            | 10                         |
| `POST /discount-coupons/validate`                  | 20                         |
| `GET /products/price-sheet`                        | 20                         |
| `GET /products/catalog`                            | 120                        |
| `GET /orders/lookup/:orderNumber`                  | 30                         |
| `PATCH /orders/lookup/:orderNumber/payment-method` | 5                          |
| `POST /wholesale-inquiries`                        | 10                         |

- The IP comes from `req.ips[0] ?? req.ip`, via the `getTracker` in
  `src/common/guards/throttler-tracker.util.ts`. `main.ts` sets `trust proxy 1`, so `req.ips`
  is the `X-Forwarded-For` chain, client first. The library's own default is `req.ip`, which
  behind a proxy is the proxy — every visitor arriving through one Cloudflare edge would have
  shared a single allowance while a caller from another edge went uncounted. This paragraph
  described the tracker for a while before the tracker existed (Plan-0005 I-39).
- The header is only as trustworthy as the deployment: anything that can reach the app without
  passing the proxy can set `X-Forwarded-For` itself. Keeping the origin unreachable except
  through Cloudflare and Nginx is the release check (Plan-0005 A1), not something the tracker
  can enforce.
- `GET /products/catalog` is deliberately the loosest limit in the table (120/min = 2/s). It runs
  three `$facet` aggregations, so it must not be free — but it is also the endpoint the storefront
  calls on every filter click, it is rendered server-side (all SSR renders share the one container
  IP), and behind Cloudflare the leftmost `X-Forwarded-For` entry is only the real client as long as
  the edge is configured to send it. A tight limit here breaks browsing, not scraping. **Follow-up:**
  the storefront's `serverFetch` does not send `X-Internal-Token` yet, so SSR catalogue renders are
  counted like a visitor's; adding the header exempts them (`skipIf`) and is the proper fix.
- A blocked request gets `429` with a `Retry-After` header (exposed through CORS).
- **Internal bypass:** requests carrying `X-Internal-Token: <INTERNAL_API_TOKEN>` are never
  throttled (`skipIf` → `src/common/guards/internal-request.util.ts`, constant-time compare).
  The env var is optional and shared with the frontend, which sends it from server-side
  fetches only. Today no SSR fetch targets a throttled endpoint, so the header is a safety net.
- `ThrottlerGuard` goes **first** in `@UseGuards(...)` so an over-limit client is rejected
  before any auth work. Add a case to `*.controller.throttle.spec.ts` when you guard a new
  handler (see `discount-coupon.controller.throttle.spec.ts`,
  `product.controller.throttle.spec.ts`). A handler's own `@Throttle` overrides the module
  default, so the spec asserts the real limit: raising it in the controller alone fails the spec.

---

## 5. Current modules

Non-exhaustive — see `app.module.ts` for the full list (18 feature modules) and
`src/docs/RBAC.md` for the current, accurate guard status per module.

| Module           | Base path     | Guard (writes + admin-only reads)                                                                                                                                                                                                                                     |
| ---------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthModule`     | `/auth`       | Public (issues its own tokens)                                                                                                                                                                                                                                        |
| `VendorModule`   | `/vendors`    | `JwtAuthGuard` + `RolesGuard` + `Roles(Role.ADMIN)` on **every** route, reads included — a vendor is a supplier                                                                                                                                                        |
| `CategoryModule` | `/categories` | `JwtAuthGuard` + `RolesGuard` + `Roles(Role.ADMIN)`                                                                                                                                                                                                                   |
| `ProductModule`  | `/products`   | `JwtAuthGuard` + `RolesGuard` + `Roles(Role.ADMIN)` on writes **and** on `GET /`, `GET /:id`, `GET /:id/variants`, `GET /:id/variants/:variantId`                                                                                                                     |
| `UploadModule`   | `/upload`     | `JwtAuthGuard` + `RolesGuard` + `Roles(Role.ADMIN)` (class-level, all)                                                                                                                                                                                                |
| `UsersModule`    | `/users`      | `JwtAuthGuard` on GET/PATCH `/me`; `GET /users` is `Roles(Role.ADMIN)`                                                                                                                                                                                                |
| `OrderModule`    | `/orders`     | `JwtAuthGuard` + `RolesGuard` + `Roles(ADMIN)` on admin routes; `POST /` uses `OptionalJwtAuthGuard` (guest checkout). Public read: `GET /orders/lookup/:orderNumber?token=…` — no guard, gated by an HMAC token (see `LIQPAY_FLOW.md`)                               |
| `LiqpayModule`   | `/liqpay`     | Public — `POST /checkout` and `POST /callback` (LiqPay signature verified in the service), see `LIQPAY_FLOW.md`                                                                                                                                                       |
| `FeedModule`     | `/feeds`      | Public `GET /google-shopping.xml` (the Merchant feed — ACTIVE variants, explicit projection, no supplier values); `JwtAuthGuard` + `RolesGuard` + `Roles(Role.ADMIN)` on `POST /google-shopping/regenerate` and `GET /google-shopping/status`, see `MERCHANT_FEED.md` |

`ProductModule` imports `NumbersModule` and `CategoryModule` — it does not import `VendorModule`.

---

## 6. Where Swagger is configured

- **`src/main.ts`** — Builds the OpenAPI document and mounts Swagger UI at **`/swagger`** (or `/<global-prefix>/swagger` if a global prefix is configured).
- **Controllers** — Provide tags and operation metadata via `@ApiTags`, `@ApiOperation`.
- **DTOs** — Provide request/response schemas via `@ApiProperty`.
- **Constants** — `API_OPERATION` and `API_PROPERTY` keep doc texts in one place so you don’t duplicate them in every controller/DTO.

Running the app and opening `http://localhost:3000/swagger` (with your base URL and port) shows the live Swagger UI generated from this setup.

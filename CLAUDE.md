# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
yarn start:dev           # Start with hot reload
yarn start:debug         # Start with debugger

# Build & Production
yarn build               # Compile TypeScript
yarn start:prod          # Run compiled output

# Code Quality
yarn lint                # ESLint with auto-fix
yarn format              # Prettier format

# Testing
yarn test                # Run unit tests (*.spec.ts, no DB — includes *.controller.rbac.spec.ts)
yarn test:watch          # Unit tests in watch mode
yarn test:cov            # With coverage report
yarn test:db:up          # Start disposable MongoDB 7 for integration tests (127.0.0.1:27018)
yarn test:integration    # Run *.int-spec.ts against it (test/jest-integration.json)
yarn test:db:down        # Stop and remove it (data lives on tmpfs, discarded automatically)
```

Integration specs connect via `test/integration-db.ts` (`connectTestDb` / `dropTestDb`,
`TEST_DATABASE_URL`, default `mongodb://127.0.0.1:27018/fillando-test`) — never to
`DATABASE_URL`. Local development uses `docker-compose.local.yml` (`yarn db:up` / `yarn db:down`)
and `DATABASE_URL=mongodb://127.0.0.1:27019/fillando`. Data persists in `.local/mongo-8/`
(bind mount, excluded from Git and Docker build context). `docker-compose.test.yml`
remains separate and disposable. See README for local setup.

To run a single test file: `yarn test -- path/to/file.spec.ts`

## Architecture

NestJS backend with MongoDB (via Mongoose). No global prefix in the app (nginx adds `/api` in production). Swagger at `/swagger`.

**Module layout under `src/`:**

- `app.module.ts` — root module; imports LoggerModule, MongooseModule, AuthModule, VendorModule, CategoryModule, ProductModule, ColorModule, LandingModule, UploadModule, NumbersModule, CartModule, EmailModule, PaymentDetailsModule, PaymentProvidersModule, LiqpayModule, NovaPostModule, PromModule, OrderModule, DiscountCouponModule, UsersModule, WholesaleInquiryModule
- `common/` — shared code: configs, constants, decorators, guards, passport strategies, types, services
- `database/mongoose/schemas/` — Mongoose schema classes (one file per domain)
- `database/mongoose/repositories/` — data access layer; `base.repository.ts` + concrete repos
- `database/mongoose/mongoose.filter.ts` — global Mongoose exception filter
- `modules/` — feature modules (auth, vendor, category, product)
- `docs/` — internal dev documentation

**Request flow:** `HTTP → Controller → Service → Repository → MongoDB`
Full details in `src/docs/REPOSITORY_PATTERN.md`.

## Key Patterns

**Environment variables** are validated at startup via a Zod schema in `src/common/constants/env.constant.ts`. All env vars must be declared there before use. Required vars:

```
DATABASE_URL
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL
JWT_SECRET / JWT_EXPIRATION (minutes) / ACCSESS_TOKEN_NAME
REFRESH_JWT_SECRET / REFRESH_JWT_EXPIRATION (minutes) / REFRESH_TOKEN_NAME
PASSWORD_PEPPER (min 16 chars)
PROM_API_KEY
FRONTEND_URL
PORT
NODE_ENV / LOG_LEVEL
RUN_CRON (optional, default false — enables in-process scheduled jobs; set true on one instance only)
INTERNAL_API_TOKEN (optional, min 32 chars — requests with `X-Internal-Token` bypass rate limits; shared with the frontend)
REVALIDATE_SECRET (optional, min 32 chars — sent as `x-revalidate-secret` to the frontend's `POST /api/revalidate` after landing writes; the same value must be set on the frontend, and it is never `NEXT_PUBLIC_*`)
```

**Authentication** uses JWT (from `access_token` cookie) + Google OAuth. `JwtAuthGuard` is the standard guard for protected routes. Admin-only endpoints add `RolesGuard` after it — `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.ADMIN)`; `RolesGuard` is default-deny (no `@Roles` metadata or no `req.user.role` → 403) and `@Roles` accepts only `Role[]`, not strings (see `src/docs/RBAC.md`). Access and refresh tokens are set as `httpOnly` cookies. Refresh tokens are stored hashed (SHA256) in `refresh_tokens` collection with IP/UA tracking. Token lifetimes are configured via `JWT_EXPIRATION` / `REFRESH_JWT_EXPIRATION` (in minutes) in `.env`.

**Rate limiting** is opt-in per handler (`@UseGuards(ThrottlerGuard)` + `@Throttle(...)`, no global guard) — see `src/docs/API_AND_SWAGGER.md` §4a for the limits table and the `X-Internal-Token` bypass.

**Enums** (`Role`, `AuthMethod`) are defined in `src/common/types/enums.ts` — import from there, not from any ORM client.

**Attribute keys** — `generateAttrKey(label)` in `src/common/utils/attribute.utils.ts` derives `products.attributes[].k` and `categories.required_attributes[].key` from the label on every save (`ProductService.create`/`update`, `CategoryService.mapRequiredAttributes`). It first consults `ATTR_KEY_OVERRIDES` (normalized label → key; normalization = NFC, trim, whitespace collapsed to single spaces, lower-case) and falls back to Ukrainian→Latin transliteration otherwise. The overridden keys are the catalogue filter dimensions from TD-0002 §5.2.1 (`fillando-meta` repo, `docs/designs/TD-0002-catalog-taxonomy-and-landings.md`): migrations write them, landings pin them and the storefront filters by them, so they must be stable English identifiers rather than transliterated Ukrainian.

| Label               | Key              |
| ------------------- | ---------------- |
| Тип пластику        | `polymer`        |
| Ефект поверхні      | `finish`         |
| Армування           | `reinforcement`  |
| Серія               | `series`         |
| Котушка в комплекті | `spool_included` |
| Вага філаменту      | `vaha`           |

The last row is not a TD-0002 dimension. It pins an existing key across a label change: the
mock's specification row reads «Вага філаменту», the stored label is «Вага», and the key is
recomputed from the label on every save — so renaming the label, in the admin or by migration,
would move `vaha` to `vaha_filamentu` and drop the dimension out of the sidebar, the facets and
any landing pinning it. Both labels therefore resolve to `vaha` (Plan-0005 I-27).

Rules:

- Keys are never supplied by the client — they are always derived from the label server-side.
- Adding a catalogue filter dimension requires matching entries in `ATTR_KEY_OVERRIDES` here and frontend `toAttrKey` in `fillando-fe/src/common/utils/slug.utils.ts`. If existing stored keys must change, create a dedicated migration with a dry-run and verification; changing the override only affects subsequent saves.
- `Product.variant_type.key` is the exception to "derived server-side": `VariantTypeDto.key` is a plain `@IsString()` that `ProductService.create`/`update` store verbatim, so the frontend is its only author. A later save does not repair it, which is why the migration renames it too — otherwise it stops matching the `attributes[].k` it points at.
- Attribute values must not contain commas: the catalogue query splits multi-value filters (`?polymer=PLA,PETG`) on `,`.

**Catalogue colour & landings** (TD-0002, `fillando-meta`) — `colors` is the colour dictionary and `landings` the SEO pages over a category. Two rules are easy to break:

- `ProductVariant.color_family` is a denormalized copy of `Color.family`. `ColorService.update` writes the dictionary **first** and backfills the variants **second**. That order is the compensation for a missing transaction: this deployment runs a **standalone MongoDB**, where `session.withTransaction` fails outright, so the design's "one transaction" (TD-0002 §5.2.2) is not available. Because the dictionary is the source of truth, a failed backfill is repairable — re-issuing the same `PATCH /colors/:id` backfills again, since the update filters on drift rather than on a changed value. Making transactions possible means converting the server to a single-node replica set.
- Landing reads come in two flavours: the public ones (`GET /landings`, `/landings/slugs`, `/landings/slug/:categorySlug/:landingSlug`) filter `status: 'active'`; the draft-exposing ones (`GET /landings/admin`, `GET /landings/:id`) are ADMIN-only. Never widen a public one to all statuses — that is the defect Plan-0003 closed for products.

**Variant identity — name from the dictionary, slug from `v_value`.** After `normalize-variant-colors.js`, `ProductVariant.v_value` holds the canonical English colour (`colors.name_en`) and the shopper-facing `name` is `"<product> — Чорний (Black)"` (Ukrainian first, `colors.name_en` in brackets, collapsed when the two are the same word). `ProductService.variantName` therefore prefers the dictionary spelling and treats `v_value` as the fallback for variants that carry no colour; the slug keeps coming from `v_value`, so addresses stay stable. Deriving `name` from `v_value` instead renames migrated variants to English on the next ordinary save — silently, one product per edit, and visible in the catalogue listing, the price sheet, the `ItemList` markup and the cart. Two related rules live in the same code path:

- A product rename regenerates every variant slug, and `slug` is unique. Only an **actual** change of name triggers it (the admin form posts `name` on every save). `planVariantRename` computes the whole batch and `assertSlugsAvailable` refuses a clash with a 409 naming the SKUs **before the first write** — there is no transaction to fall back on here (standalone MongoDB), so a duplicate found mid-batch used to leave the product renamed and its variants half-rewritten. Slugs can also **rotate** within a product, where the address one variant is moving to is still held by a sibling that is moving too; that is a race rather than a clash, so `applyVariantRename` writes in two passes, parking every mover on a temporary `…-moving-<id>` address before any of them claims its target.
- `target: ES2023` gives every declared DTO field an own property, so `'field' in dto` is **always true** even when the client never sent it. Compare against `undefined` instead (`dto.v_value !== undefined`); the old `in` check made a stock-only PATCH rewrite the variant's name and slug, and stamped `price_updated_at` / `stock_updated_at` — both public, the latter as the price sheet's "synced" column — on edits that touched neither.

**Catalogue transition completed.** The one-off scripts and their migration-only tests were
retired on 2026-09-11. Do not recommend `yarn migrate*` or recreate old seed dictionaries.
For a new environment restore a current dump. See `scripts/README.md` for retained tools,
historical Git recovery and the archive location, and `src/docs/CATALOG_RELEASE.md` for
current release checks. Attribute requiredness has its own strict migration and rollback.

## Endpoint & Swagger Conventions

Follow the pattern documented in `src/docs/API_AND_SWAGGER.md`:

1. **Paths** → `src/common/constants/endpoints.constant.ts` (single source of truth for all URLs)
2. **Operation text** → `src/common/constants/docs/api-operation.constant.ts` — add `summary`/`description` per endpoint
3. **Property docs** → `src/common/constants/docs/api-property.constant.ts` — shared DTO field metadata
4. **Controller** — use `@Controller(ENDPOINTS.X.BASE)`, `@ApiTags(ENDPOINTS.X.BASE)`, `@ApiOperation(API_OPERATION.X.Y)`
5. **DTOs** — use `class-validator` for validation and `@ApiProperty(API_PROPERTY.X)` for Swagger

## Documentation & Flow Integrity

Before finishing any task, check whether the changes affect a documented flow, API contract, or data structure.

- If a documented flow changes → update the relevant file in `src/docs/` before considering the task done.
- If a new flow, module, or endpoint is added and no doc exists → suggest creating a new file in `src/docs/`.
- Changes to request/response shapes, auth behaviour, or repository contracts always require a doc check.

A task is **not done** until the documentation reflects the current reality.

## API Contract

After adding or modifying any endpoint, controller, or DTO — run:

```bash
yarn spec:export
```

This updates `openapi.json` in the project root which the frontend agent relies on.

## Prettier Config

Tabs, no semicolons, single quotes, no trailing comma, print width 100, arrow parens avoided.

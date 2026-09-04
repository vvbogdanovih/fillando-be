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
`DATABASE_URL`. There is no dev `docker-compose.yml`; local development uses the remote
`DATABASE_URL` from `.env`, and `docker-compose.test.yml` exists only for the test database.

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

Rules:

- Keys are never supplied by the client — they are always derived from the label server-side.
- Adding a catalogue filter dimension means adding the pair in three places: `ATTR_KEY_OVERRIDES` here, the frontend mirror `toAttrKey` in `fillando-fe/src/common/utils/slug.utils.ts`, and `scripts/migrations/normalize-attr-keys.js` (a unit test enforces BE↔migration sync). Then deploy and run the migration (`node scripts/migrations/normalize-attr-keys.js --dry-run`, then without the flag) to rename keys already stored — the override applies on the next save, not retroactively.
- `Product.variant_type.key` is the exception to "derived server-side": `VariantTypeDto.key` is a plain `@IsString()` that `ProductService.create`/`update` store verbatim, so the frontend is its only author. A later save does not repair it, which is why the migration renames it too — otherwise it stops matching the `attributes[].k` it points at.
- Attribute values must not contain commas: the catalogue query splits multi-value filters (`?polymer=PLA,PETG`) on `,`.

**Catalogue colour & landings** (TD-0002, `fillando-meta`) — `colors` is the colour dictionary and `landings` the SEO pages over a category. Two rules are easy to break:

- `ProductVariant.color_family` is a denormalized copy of `Color.family`. `ColorService.update` writes the dictionary **first** and backfills the variants **second**. That order is the compensation for a missing transaction: this deployment runs a **standalone MongoDB**, where `session.withTransaction` fails outright, so the design's "one transaction" (TD-0002 §5.2.2) is not available. Because the dictionary is the source of truth, a failed backfill is repairable — re-issuing the same `PATCH /colors/:id` backfills again, since the update filters on drift rather than on a changed value. Making transactions possible means converting the server to a single-node replica set.
- Landing reads come in two flavours: the public ones (`GET /landings`, `/landings/slugs`, `/landings/slug/:categorySlug/:landingSlug`) filter `status: 'active'`; the draft-exposing ones (`GET /landings/admin`, `GET /landings/:id`) are ADMIN-only. Never widen a public one to all statuses — that is the defect Plan-0003 closed for products.

**Catalogue migrations run in one order** (`scripts/migrations/`, TD-0002). Each takes `--dry-run`, is idempotent, writes its plan before it writes data, and pins the array it read in the update filter so a concurrent admin save is skipped and reported rather than overwritten:

1. `normalize-attr-keys.js` — renames keys stored before `ATTR_KEY_OVERRIDES` existed.
2. `derive-material-taxonomy.js` — writes `polymer`/`finish`/`reinforcement`/`series` from `material` (which stays), and swaps `material` for those four in the category's `required_attributes`.
3. `backfill-spool-included.js` — gives every product `spool_included = Так`, then adds the filter. Products first: a category offering a filter no product carries returns an empty catalogue, whereas the reverse is invisible.
4. `seed-colors.js` — the colour dictionary. `synonyms` live here, not in the database, and the normalizer reads them from this file.
5. `normalize-variant-colors.js` — points variants at the dictionary. **Do not run this on production until Plan-0004 tasks 12 and 32 are both live**: it rewrites `v_value` to the English name, and until the storefront renders `color` instead, the whole shop flips to English colour names. Variant slugs change with no 301 (the owner's decision); `reports/slug-map.json` records every move and is merged, never truncated, across runs. Unidentifiable spellings are left untouched and listed in `reports/color-report.json` for a human. A slug collision aborts the run — `--force` applies the rest.

Reports land in `scripts/migrations/reports/` and are gitignored.

**Admin-authored HTML** is sanitized on write by `sanitizeRichText` / `sanitizePlainText` (`src/common/utils/html.utils.ts`): landing copy, FAQ entries and product descriptions. The storefront renders these with `dangerouslySetInnerHTML`, so an allowlist is the only thing between an admin account and stored XSS for every visitor. `sanitize-html` is pinned to **2.17.0** on purpose — 2.17.7 moved to an ESM-only `htmlparser2`, which Jest's CommonJS runtime cannot load, so every suite importing it fails to parse.

**Repository pattern** — services never use `@InjectModel` directly; all DB access goes through a repository that extends `BaseRepository<T>` (`src/database/mongoose/repositories/base.repository.ts`). Register the repository in the module's `providers` array alongside the `MongooseModule.forFeature` schema. See `src/docs/REPOSITORY_PATTERN.md` for the full pattern and a step-by-step example.

**New feature modules** go in `src/modules/`. The nest-cli is configured with `generate.options.baseDir = "modules"`, so `nest g module foo` places it there automatically.

**Logging** uses `nestjs-pino`. Inject `PinoLogger` from `nestjs-pino` in controllers (with `setContext`), and `Logger` from `@nestjs/common` in services.

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

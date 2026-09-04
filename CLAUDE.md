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

- `app.module.ts` — root module; imports LoggerModule, MongooseModule, AuthModule, VendorModule, CategoryModule, ProductModule, UploadModule, NumbersModule, CartModule, EmailModule, PaymentDetailsModule, PaymentProvidersModule, LiqpayModule, NovaPostModule, PromModule, OrderModule, DiscountCouponModule, UsersModule, WholesaleInquiryModule
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

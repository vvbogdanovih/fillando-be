# Fillando Backend

NestJS REST API for the Fillando e-commerce platform. MongoDB via Mongoose. JWT + Google OAuth authentication.

- Global API prefix: none (no `/api`)
- Swagger UI: `/swagger`

---

## Prerequisites

- Node.js 18+
- Yarn
- Docker with Compose (Docker Desktop on macOS)

---

## Setup

```bash
# 1. Install dependencies
yarn install

# 2. Copy and fill environment variables
cp .env.example .env

# 3. Start local MongoDB and wait for readiness
yarn db:up

# 4. Start the dev server
yarn start:dev
```

### Local MongoDB

Step-by-step operations: [Local MongoDB runbook](../../docs/runbooks/local-mongodb.md) (meta-repository).

`.env.example` defaults to `DATABASE_URL=mongodb://127.0.0.1:27019/fillando`.
For an existing `.env`, replace `DATABASE_URL` with this value and restart the backend.
If you use the meta-repo's env sync, set the same URL in its master `.env` too.

The `db:*` commands skip the application `.env` when invoking Compose; MongoDB needs no app secrets.
`docker-compose.local.yml` runs MongoDB 8.0 on localhost only, without authentication.
Port 27019 avoids the system MongoDB (27017) and disposable integration database (27018).
The database starts empty; restore a dump if you need existing users and catalogue data.

Data is bind-mounted into **`.local/mongo-8/` inside this repository**, excluded from Git
and the Docker build context. MongoDB config data is also local in `.local/mongo-8-config/`.
`yarn db:down` removes the container but keeps these files;
`yarn db:up` reuses them. Do not delete `.local/mongo-8/` unless you intend to erase the database.

```bash
yarn db:up    # Start and wait until healthy
yarn db:logs  # Follow MongoDB logs
yarn db:down  # Stop; preserve local data
```

---

## Environment Variables

| Variable                  | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `DATABASE_URL`            | MongoDB connection string                      |
| `PORT`                    | HTTP port (default: 3000)                      |
| `NODE_ENV`                | `development` or `production`                  |
| `LOG_LEVEL`               | `debug` / `info` / `warn` / `error`            |
| `JWT_SECRET`              | Access token secret (min 10 chars)             |
| `JWT_EXPIRATION`          | Access token lifetime in **minutes**           |
| `ACCSESS_TOKEN_NAME`      | Access token cookie name                       |
| `REFRESH_JWT_SECRET`      | Refresh token secret (min 10 chars)            |
| `REFRESH_JWT_EXPIRATION`  | Refresh token lifetime in **minutes**          |
| `REFRESH_TOKEN_NAME`      | Refresh token cookie name                      |
| `PASSWORD_PEPPER`         | Argon2 server-side pepper (min 16 chars)       |
| `GOOGLE_CLIENT_ID`        | Google OAuth client ID                         |
| `GOOGLE_CLIENT_SECRET`    | Google OAuth client secret                     |
| `GOOGLE_CALLBACK_URL`     | Google OAuth redirect URI                      |
| `FRONTEND_URL`            | Allowed CORS origin + post-OAuth redirect base |

All variables are validated at startup via a Zod schema (`src/common/constants/env.constant.ts`).
The server will refuse to start if any required variable is missing or invalid.

---

## Commands

```bash
yarn start:dev       # Development with hot reload
yarn start:debug     # Development with debugger
yarn build           # Compile TypeScript
yarn start:prod      # Run compiled output
yarn lint            # ESLint with auto-fix
yarn format          # Prettier format
yarn test            # Unit tests
yarn test:watch      # Unit tests in watch mode
yarn test:cov        # Unit tests with coverage
yarn test:db:up      # Disposable MongoDB 7 for integration tests (127.0.0.1:27018)
yarn test:integration # *.int-spec.ts against it
yarn test:db:down    # Stop and remove it (tmpfs, nothing to clean up)
```

---

## Architecture

```
src/
├── app.module.ts                        # Root module
├── main.ts                              # Bootstrap (Swagger, CORS, cookies, prefix)
├── common/
│   ├── constants/                       # ENV, token lifetimes, endpoints, Swagger metadata
│   ├── decorators/                      # @Roles
│   ├── guards/                          # JwtAuthGuard, RolesGuard
│   ├── strategies/                      # JWT and Google Passport strategies
│   ├── services/                        # Shared injectable services (NicePriceService)
│   └── types/                           # Enums, JWTPayload, User type
├── database/mongoose/
│   ├── schemas/                         # Mongoose schema classes
│   ├── repositories/                    # BaseRepository + concrete repos
│   └── mongoose.filter.ts              # Global duplicate-key exception filter
├── modules/
│   ├── auth/                            # Email/password + Google OAuth
│   ├── vendor/                          # Vendor CRUD
│   ├── category/                        # Category + embedded subcategory management
│   └── product/                         # Product CRUD with NicePrice stock enrichment
└── docs/                                # Internal developer documentation
```

**Request flow:** `HTTP → Controller → Service → Repository → MongoDB`

---

## Key Docs

- [Repository Pattern](src/docs/REPOSITORY_PATTERN.md)
- [API & Swagger Conventions](src/docs/API_AND_SWAGGER.md)
- [Nova Post cache & lookup API](src/docs/NOVA_POST.md) (cities / warehouses, including `q` search)
- [Authentication Flow](src/docs/AUTH_FLOW.md)
- [Documentation TODO](src/docs/TODO.md)

## Maintenance scripts

See [scripts/README.md](scripts/README.md) for retained tools and migration recovery.
The completed catalogue transition scripts and `yarn migrate*` commands have been retired.

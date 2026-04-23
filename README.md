# Fillando Backend

NestJS REST API for the Fillando e-commerce platform. MongoDB via Mongoose. JWT + Google OAuth authentication.

- Global API prefix: none (no `/api`)
- Swagger UI: `/swagger`

---

## Prerequisites

- Node.js 18+
- Yarn
- Docker (for local MongoDB)

---

## Setup

```bash
# 1. Install dependencies
yarn install

# 2. Copy and fill environment variables
cp .env.example .env

# 3. Start MongoDB
docker compose up -d

# 4. Start the dev server
yarn start:dev
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
| `DOCKER_MONGO_USER`       | MongoDB username (docker-compose)              |
| `DOCKER_MONGO_PASSWORD`   | MongoDB password (docker-compose)              |
| `DOCKER_MONGO_DB`         | MongoDB database name (docker-compose)         |
| `DOCKER_DB_PORT_EXTERNAL` | Host port for MongoDB container                |
| `DOCKER_DB_LOCAL_PATH`    | Host path for MongoDB data volume              |

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
yarn test:e2e        # End-to-end tests
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
- [Product Enrichment Flow](src/docs/PRODUCT_ENRICHMENT.md)
- [Documentation TODO](src/docs/TODO.md)

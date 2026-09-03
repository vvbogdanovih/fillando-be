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

**GET endpoints on catalogue data are public by default.** Everything else falls into one of
two buckets:

1. **Catalogue / admin resources** (products, vendors, categories, uploads, payment settings,
   order management, coupons, sync jobs) — every write endpoint, and any read that exposes
   admin data, is **admin-only**: `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.ADMIN)`.
2. **User-owned resources** (`/cart/*`, `/users/me`, `/orders/me`) — `JwtAuthGuard` alone; the
   service scopes the query by `req.user.id`.

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

---

## 5. Current modules

Non-exhaustive — see `app.module.ts` for the full list (17 feature modules) and
`src/docs/RBAC.md` for the current, accurate guard status per module.

| Module           | Base path     | Write guard                                                            |
| ---------------- | ------------- | ---------------------------------------------------------------------- |
| `AuthModule`     | `/auth`       | Public (issues its own tokens)                                         |
| `VendorModule`   | `/vendors`    | `JwtAuthGuard` + `RolesGuard` + `Roles(Role.ADMIN)`                    |
| `CategoryModule` | `/categories` | `JwtAuthGuard` + `RolesGuard` + `Roles(Role.ADMIN)`                    |
| `ProductModule`  | `/products`   | `JwtAuthGuard` + `RolesGuard` + `Roles(Role.ADMIN)`                    |
| `UploadModule`   | `/upload`     | `JwtAuthGuard` + `RolesGuard` + `Roles(Role.ADMIN)` (class-level, all) |
| `UsersModule`    | `/users`      | `JwtAuthGuard` on GET/PATCH `/me`; `GET /users` is `Roles(Role.ADMIN)` |

`ProductModule` imports `NumbersModule` and `CategoryModule` — it does not import `VendorModule`.

---

## 6. Where Swagger is configured

- **`src/main.ts`** — Builds the OpenAPI document and mounts Swagger UI at **`/swagger`** (or `/<global-prefix>/swagger` if a global prefix is configured).
- **Controllers** — Provide tags and operation metadata via `@ApiTags`, `@ApiOperation`.
- **DTOs** — Provide request/response schemas via `@ApiProperty`.
- **Constants** — `API_OPERATION` and `API_PROPERTY` keep doc texts in one place so you don’t duplicate them in every controller/DTO.

Running the app and opening `http://localhost:3000/swagger` (with your base URL and port) shows the live Swagger UI generated from this setup.

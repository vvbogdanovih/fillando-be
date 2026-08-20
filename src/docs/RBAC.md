# Role-Based Access Control (RBAC)

## Current State

The infrastructure exists but is **not yet applied** to any endpoint.

Available roles (`src/common/types/enums.ts`):

```ts
enum Role {
	USER = 'USER',
	ADMIN = 'ADMIN'
}
```

---

## Available Pieces

### `@Roles(...roles)` decorator

`src/common/decorators/roles.decorator.ts`

Sets `ROLES_KEY` metadata on a route handler or controller.

```ts
import { Roles } from 'src/common/decorators/roles.decorator'

@Roles('ADMIN')
@Post(ENDPOINTS.VENDORS.CREATE)
create(@Body() dto: CreateVendorDto) { ... }
```

### `RolesGuard`

`src/common/guards/roles.guard.ts`

Reads the required roles from metadata and compares against `req.user.role`.
Returns `true` (allows through) if no roles are set on the route.

**Must be used together with `JwtAuthGuard`** — `RolesGuard` reads `req.user.role`,
which is only populated after `JwtAuthGuard` has validated the token.

```ts
@Post(ENDPOINTS.VENDORS.CREATE)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
create(@Body() dto: CreateVendorDto) { ... }
```

---

## Enforced Admin-Only Endpoints

Already restricted with `JwtAuthGuard` + `RolesGuard` + `@Roles(Role.ADMIN)`:

| Endpoint                              | Module        |
| ------------------------------------- | ------------- |
| `POST /api/products/price-list/pdf`   | ProductModule |

(Plus the order-management endpoints in `OrderModule` and the sync endpoints in `PromModule`.)

---

## Planned Admin-Only Endpoints

The following write endpoints currently require only authentication (`JwtAuthGuard`).
They should be restricted to `ADMIN` once RBAC is wired up:

| Endpoint                                          | Module         |
| ------------------------------------------------- | -------------- |
| `POST /api/vendors`                               | VendorModule   |
| `PATCH /api/vendors/:id`                          | VendorModule   |
| `DELETE /api/vendors/:id`                         | VendorModule   |
| `POST /api/categories`                            | CategoryModule |
| `PATCH /api/categories/:id`                       | CategoryModule |
| `DELETE /api/categories/:id`                      | CategoryModule |
| `POST /api/products`                              | ProductModule  |
| `PATCH /api/products/:id`                         | ProductModule  |
| `DELETE /api/products/:id`                        | ProductModule  |

---

## How to Apply

1. Add `RolesGuard` to the guards list after `JwtAuthGuard`.
2. Add `@Roles(Role.ADMIN)` to the handler or the entire controller class.
3. Ensure the user's role is correctly set at registration/login — it defaults to `Role.USER`.

The `ADMIN` role must be assigned directly in the database for now (no promotion endpoint exists yet).

# Documentation TODO

Status of the initial security audit (`src/docs/todo/AUDIT_CRITICAL.md`), verified
2026-09-03:

- **#1 Cookie `secure: false`** — still open. Both cookies are still `secure: false`,
  and the access-token cookie's `maxAge` still uses `RefreshTokenLifetime.ms`.
- **#2 Payment details leak** — fixed. `payment-details.controller.ts` now requires
  `JwtAuthGuard` + `RolesGuard` + `Roles(ADMIN)` on every endpoint, including
  `findAll`/`findActive`.
- **#3 Missing ownership/role check on vendor/product mutations** — fixed. Every write
  endpoint in `vendor.controller.ts`, `product.controller.ts` and `upload.controller.ts` now
  requires `JwtAuthGuard` + `RolesGuard` + `Roles(ADMIN)`. A role check was chosen over
  ownership because vendors/products are catalogue entities owned by the shop, not by users.
  `RolesGuard` is now default-deny and `@Roles` is typed `Role[]`. Covered by
  `*.controller.rbac.spec.ts`. See `RBAC.md`.
- **#4 Refresh token race condition** — fixed. `AuthService.refresh` now verifies the
  JWT signature before deleting the stored token.
- **#5 No cascade delete / referential integrity** — still open. No repository
  implements cascade delete or dependency checks before a hard delete.

Add new items here as the codebase evolves (new flows, external integrations, breaking changes).

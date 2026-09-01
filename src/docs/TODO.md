# Documentation TODO

Status of the initial security audit (`src/docs/todo/AUDIT_CRITICAL.md`), verified
2026-09-01:

- **#1 Cookie `secure: false`** — still open. Both cookies are still `secure: false`,
  and the access-token cookie's `maxAge` still uses `RefreshTokenLifetime.ms`.
- **#2 Payment details leak** — fixed. `payment-details.controller.ts` now requires
  `JwtAuthGuard` + `RolesGuard` + `Roles(ADMIN)` on every endpoint, including
  `findAll`/`findActive`.
- **#3 Missing ownership/role check on vendor/product mutations** — still open.
  `VendorModule` and most of `ProductModule` still only require `JwtAuthGuard`; any
  logged-in `USER` can create/edit/delete any vendor or product. See `RBAC.md`.
- **#4 Refresh token race condition** — fixed. `AuthService.refresh` now verifies the
  JWT signature before deleting the stored token.
- **#5 No cascade delete / referential integrity** — still open. No repository
  implements cascade delete or dependency checks before a hard delete.

Add new items here as the codebase evolves (new flows, external integrations, breaking changes).

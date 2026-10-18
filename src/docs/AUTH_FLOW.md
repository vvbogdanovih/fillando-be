# Authentication Flow

## Overview

Two auth methods are supported: **email/password** and **Google OAuth 2.0**.
Both result in the same token pair being issued and set as `httpOnly` cookies.

---

## Token Strategy

| Token         | Cookie name          | Secret               | Lifetime env var                   | Storage                                    |
| ------------- | -------------------- | -------------------- | ---------------------------------- | ------------------------------------------ |
| Access token  | `ACCSESS_TOKEN_NAME` | `JWT_SECRET`         | `JWT_EXPIRATION` (minutes)         | Client cookie only                         |
| Refresh token | `REFRESH_TOKEN_NAME` | `REFRESH_JWT_SECRET` | `REFRESH_JWT_EXPIRATION` (minutes) | SHA256 hash in `refresh_tokens` collection |

Both cookies are `httpOnly`. The access token cookie is `sameSite: lax`; the refresh token cookie is `sameSite: strict`.

The access JWT still expires per `JWT_EXPIRATION`; the **browser cookie** `maxAge` for the access token matches the refresh cookie (`REFRESH_JWT_EXPIRATION`) so the client can keep calling `POST /auth/refresh` until the refresh window ends.

The JWT payload (`JWTPayload`) contains: `id`, `email`, `name`, `role`.

---

## Flows

### Register (`POST /auth/register`)

1. Check no user exists with that email → `409` if duplicate.
2. Validate `password === confirmPassword` → `409` if mismatch.
3. Hash password with **Argon2** + `PASSWORD_PEPPER` (min 16 chars, from env).
4. Create user in `users` collection (`authMethod: EMAIL`).
5. Issue access token + refresh token.
6. Store refresh token (see [Refresh Token Storage](#refresh-token-storage)).
7. Set both cookies on the response.

### Login (`POST /auth/login`)

1. Look up user by email → `401` if not found or has no password (OAuth-only account).
2. Verify password with `argon2.verify` + `PASSWORD_PEPPER` → `401` on mismatch.
3. Issue access token + refresh token.
4. Store refresh token.
5. Set both cookies.

### Google OAuth (`GET /auth/google` → `GET /auth/google/callback`)

1. Browser is redirected to Google consent screen via `GoogleStrategy` (scope: `email`, `profile`).
2. Google redirects to `GOOGLE_CALLBACK_URL` with a code; Passport exchanges it for a profile.
3. Look up user by email; create one if not found (`authMethod: GOOGLE`).
4. Issue access token + refresh token.
5. Store refresh token.
6. Redirect browser to `FRONTEND_URL/auth/success` with cookies set.

### Token Refresh (`POST /auth/refresh`)

1. Read refresh token from `REFRESH_TOKEN_NAME` cookie → `401` if absent.
2. Hash it (SHA256) and look up in `refresh_tokens` → `401` if not found (already used or never existed).
3. Check `expiresAt` → if expired, delete the stored record and return `401`.
4. If the record carries `usedAt` older than `REFRESH_REUSE_GRACE_MS` (30 s) → delete it and return `401` (a reuse this late is read as a stolen token).
5. Cryptographically verify JWT signature with `REFRESH_JWT_SECRET` → `401` on failure.
6. **Mark the stored token consumed** (`usedAt = now`) if it was not already; a reuse inside the window leaves the record as it is.
7. Issue a new access token + new refresh token (each refresh token carries a random `jti`, so two issued in the same second never collide on the unique hash index).
8. Store the new refresh token.
9. Set both cookies.

Every `401` above also **clears both cookies** on the response (`AuthController.refresh`). A rejected refresh means the jar cannot open a session any more, and clearing it here is what lets the storefront stop calling `POST /auth/logout` on a failed refresh — that call sent whatever refresh cookie the jar held at the time, which in a two-tab race was the *other* tab's freshly rotated token, so one lost race logged every tab out.

**Why a reuse window.** Two tabs that meet an expired access token at the same moment both send the same refresh cookie: each tab deduplicates its own 401s, but knows nothing of the other. With a strictly single-use token the loser got `401`. Within the window the second caller gets its own fresh pair (two live refresh tokens for one session for up to a week; only the newer one ever sits in the jar, the orphan is deleted by the housekeeping below or on expiry).

### Logout (`POST /auth/logout`)

1. Read refresh token from cookie.
2. Hash it and delete from `refresh_tokens` via `deleteByTokenHash`.
3. Clear both cookies from the response.

### Get Current User (`GET /auth/me`) — `OptionalJwtAuthGuard`

1. `OptionalJwtAuthGuard` reads the JWT from the `ACCSESS_TOKEN_NAME` cookie. **No cookie → guest** (`req.user = null`); **a cookie that fails verification (expired, bad signature) → `401`.** "Optional" is about the cookie's presence, not its validity.
2. With no cookie, returns `{ message: 'Not authenticated', user: null }` with `200`.

   The `401` for an expired access JWT is deliberate: the storefront's HTTP client refreshes only on `401`, and when this route answered `200 { user: null }` for an expired token a tab reloaded more than `JWT_EXPIRATION` minutes after the last refresh looked logged out while the refresh cookie was still good for days. The same guard protects `POST /orders`, where an expired token used to place the order silently as a guest instead of under the account.
3. Otherwise `AuthService.getMe` fetches the full user document by id → `401` if the user no longer exists.
4. Returns `{ message: 'Me successful', user: { id, email, name, role, picture } }`.

---

## Refresh Token Storage

Every time a refresh token is saved (`saveRefreshToken`):

1. **Housekeeping first** (`deleteExpiredForUser`): that user's expired tokens, and consumed tokens (`usedAt`) whose reuse window has closed, are deleted to keep the collection clean. No TTL index or cron is needed for the window.
2. The raw token is **hashed with SHA256** before being written — the plaintext token never touches the database.
3. The record stores: `token` (hash), `userId`, `expiresAt`, `usedAt` (set on first consumption; absent on records written before the window existed, which therefore count as unused), `ipAddress`, `userAgent` (parsed browser/OS string).

`findByTokenHash` returns the raw `RefreshToken` document without populating `userId` — the refresh flow only needs the `ObjectId` to save the rotated token.

---

## Security Notes

- Tokens are never stored in `localStorage`; only `httpOnly` cookies are used.
- The refresh token rotates on every use. A consumed token stays presentable for `REFRESH_REUSE_GRACE_MS` (30 s) so two tabs racing one cookie are both served; a reuse after that is rejected and the record deleted. The window is the one place a leaked-and-already-used token still works, which is why it is seconds, not minutes.
- `PASSWORD_PEPPER` is a server-side secret mixed into every Argon2 hash — a leaked database alone is not enough to crack passwords.
- `app.set('trust proxy', 1)` is enabled so `req.ip` resolves correctly behind a reverse proxy.

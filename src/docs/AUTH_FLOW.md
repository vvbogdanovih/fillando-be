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

The access JWT still expires per `JWT_EXPIRATION`; the **browser cookie** `maxAge` for the access token matches the refresh cookie (`REFRESH_JWT_EXPIRATION`) so the client can keep calling `POST /api/auth/refresh` until the refresh window ends.

The JWT payload (`JWTPayload`) contains: `id`, `email`, `name`, `role`.

---

## Flows

### Register (`POST /api/auth/register`)

1. Check no user exists with that email → `409` if duplicate.
2. Validate `password === confirmPassword` → `409` if mismatch.
3. Hash password with **Argon2** + `PASSWORD_PEPPER` (min 16 chars, from env).
4. Create user in `users` collection (`authMethod: EMAIL`).
5. Issue access token + refresh token.
6. Store refresh token (see [Refresh Token Storage](#refresh-token-storage)).
7. Set both cookies on the response.

### Login (`POST /api/auth/login`)

1. Look up user by email → `401` if not found or has no password (OAuth-only account).
2. Verify password with `argon2.verify` + `PASSWORD_PEPPER` → `401` on mismatch.
3. Issue access token + refresh token.
4. Store refresh token.
5. Set both cookies.

### Google OAuth (`GET /api/auth/google` → `GET /api/auth/google/callback`)

1. Browser is redirected to Google consent screen via `GoogleStrategy` (scope: `email`, `profile`).
2. Google redirects to `GOOGLE_CALLBACK_URL` with a code; Passport exchanges it for a profile.
3. Look up user by email; create one if not found (`authMethod: GOOGLE`).
4. Issue access token + refresh token.
5. Store refresh token.
6. Redirect browser to `FRONTEND_URL/auth/success` with cookies set.

### Token Refresh (`POST /api/auth/refresh`)

1. Read refresh token from `REFRESH_TOKEN_NAME` cookie → `401` if absent.
2. Hash it (SHA256) and look up in `refresh_tokens` → `401` if not found (already used or never existed).
3. Check `expiresAt` → if expired, delete the stored record and return `401`.
4. Cryptographically verify JWT signature with `REFRESH_JWT_SECRET` → `401` on failure.
5. **Delete the stored token** (single-use rotation).
6. Issue a new access token + new refresh token.
7. Store the new refresh token.
8. Set both cookies.

### Logout (`POST /api/auth/logout`)

1. Read refresh token from cookie.
2. Hash it and delete from `refresh_tokens` via `deleteByTokenHash`.
3. Clear both cookies from the response.

### Get Current User (`GET /api/auth/me`) — `OptionalJwtAuthGuard`

1. `OptionalJwtAuthGuard` validates the JWT from the `ACCSESS_TOKEN_NAME` cookie if present, but does not reject the request if it's missing or invalid.
2. If there's no valid `req.user`, returns `{ message: 'Not authenticated', user: null }` (no `401`).
3. Otherwise `AuthService.getMe` fetches the full user document by id → `401` if the user no longer exists.
4. Returns `{ message: 'Me successful', user: { id, email, name, role, picture } }`.

---

## Refresh Token Storage

Every time a refresh token is saved (`saveRefreshToken`):

1. **Expired tokens for that user are deleted first** (`deleteExpiredForUser`) to keep the collection clean.
2. The raw token is **hashed with SHA256** before being written — the plaintext token never touches the database.
3. The record stores: `token` (hash), `userId`, `expiresAt`, `ipAddress`, `userAgent` (parsed browser/OS string).

`findByTokenHash` returns the raw `RefreshToken` document without populating `userId` — the refresh flow only needs the `ObjectId` to save the rotated token.

---

## Security Notes

- Tokens are never stored in `localStorage`; only `httpOnly` cookies are used.
- The refresh token is single-use: it is deleted the moment it is consumed.
- `PASSWORD_PEPPER` is a server-side secret mixed into every Argon2 hash — a leaked database alone is not enough to crack passwords.
- `app.set('trust proxy', 1)` is enabled so `req.ip` resolves correctly behind a reverse proxy.

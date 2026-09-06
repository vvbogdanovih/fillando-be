# Storefront cache revalidation

The storefront (`fillando-fe`) caches its backend reads of landings for an hour and prerenders
the sitemap. Without a purge, copy saved in `/admin/landings` reaches shoppers up to an hour
later (or after a restart). The frontend exposes `POST /api/revalidate` for that; in production
**the backend is the caller** — this document is the backend half of the contract described in
fillando-fe `docs/cache-revalidation.md`.

## When it fires

`LandingService.create`, `update` and `delete` each call `revalidateStorefront()` after their
write succeeds. Publishing is an `update` with `status: active`, so it is covered. Product and
category writes do not trigger it: the product page and catalogue are not tag-cached today.

## The call

```
POST {FRONTEND_URL}/api/revalidate
Content-Type: application/json
x-revalidate-secret: {REVALIDATE_SECRET}      # only when the env var is set
{"resource":"landings"}
```

- `resource` is a closed enum on the frontend; `landings` purges the `landings` and `sitemap`
  tags and `/sitemap.xml`.
- **Fire-and-forget.** The admin's save never waits on it and never fails because of it: a
  non-2xx or a timeout (3 s) is logged as a warning and the cache expires on its own.
- No `Origin` header is sent, which the frontend's same-origin check treats as a server caller.

## Configuration

| Variable            | Where              | Value                                                        |
| ------------------- | ------------------ | ------------------------------------------------------------ |
| `FRONTEND_URL`      | backend (existing) | the storefront origin the call goes to                       |
| `REVALIDATE_SECRET` | backend **and** frontend | the same ≥32-char secret on both; never `NEXT_PUBLIC_*`, never a Docker build arg |

Outside production the frontend accepts the call without a secret (localhost development), and
when the backend has none it sends no header. In production the frontend answers 503 until its
secret is set and 401 when the two disagree — both show up as a warning in the backend log,
`Storefront revalidation after update failed (401)`.

## Limits (inherited from the frontend)

One storefront replica only: the tag manifest is a per-process in-memory map. Cloudflare's edge
cache is not touched by this call.

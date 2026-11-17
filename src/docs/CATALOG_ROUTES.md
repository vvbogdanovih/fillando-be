# Old addresses and redirect-backed slug changes (Plan-0010 B07, local)

An ordinary rename never changes a URL (slugs are generated once). This is the explicit operation that
does — and keeps the old address working.

## Model

`catalog_routes` holds **aliases only**: `{path (normalised, unique), kind: 'alias', entity_type:
'category'|'landing'|'variant', entity_id, created_at, operation_id}`. The canonical address is never
stored: it is computed from the entity's current slug — a category `/{slug}`, its landing
`/{category}/{landing}`, a SKU `/products/{slug}`. Because an alias points at the entity, not at a path,
every old address lands on the current one in **one** hop (no A → B → C chains). The product identity
allocator already refuses a slug whose `/products/…` path is an alias.

## Operations (ADMIN, `Idempotency-Key`, `{slug, expected_revision}`, behind `admin_draft_writes_enabled`)

| Endpoint | Writes |
|---|---|
| `POST /routes/variants/:id/slug-change` | SKU `slug`; alias `/products/{old}` |
| `POST /routes/categories/:id/slug-change` | v2 draft/published category `slug`; alias `/{old}` and `/{old}/{landing}` for every landing of it |
| `POST /routes/landings/:id/slug-change` | typed landing `slug`; alias `/{category}/{old}` |

One journal plan (profile `routes`: `slug`/`updatedAt` of SKUs, categories, landings; creation and
deletion of aliases). Moving back to an old address reclaims the entity's own alias there; an address (or
alias) of another entity is `409 ROUTE_PATH_TAKEN`; a category slug equal to a storefront root
(`admin`, `catalog`, `products`, `faq`, …) is `409 ROUTE_PATH_RESERVED`; the same slug is
`409 ROUTE_SLUG_UNCHANGED`; an invalid slug is `400 INVALID_SLUG`, a body that is not
`{expected_revision, slug}` `400 INVALID_ROUTE_FIELDS` (audit 11.11). Afterwards the storefront `products`, `categories` and `landings` caches are
revalidated and the feed is signalled. SKU codes and IDs never change; orders and carts keep their ids.

**Creation keeps the same rules (audit 31.10.2026).** A new v2 category (`POST /categories/drafts`) refuses a
reserved slug (`409 ROUTE_PATH_RESERVED`) and a slug whose `/{slug}` is an old address of another entity
(`409 ROUTE_PATH_TAKEN`); a typed landing (create, or a save that changes its slug) refuses `/{category}/{slug}` held as an alias of
another entity (`409 LANDING_SLUG_TAKEN`; its own old address is allowed, an unchanged address is not re-judged). Before, only a slug change checked
them: a live page created at an old address silently ended that address's 301, and a category named like a
storefront route (`checkout`, `catalog`) was shadowed by it.

## Resolution — `GET /routes/resolve?path=` (public)

Normalises the path (`normalizeCatalogPath`: one decode, no dot segments/encoded separators/control
characters), finds the alias and answers `{kind: 'redirect', path, target_path, status: 301}` with the
entity's current public address — only when that entity is public (a visible category; an active landing
of a visible category, typed under a v2 one; an active or archived SKU of a visible category). Anything
else is 404, never a redirect to a page that does not exist. The storefront calls it from its 404
branches (`redirectIfMoved` in the FE) and issues one permanent redirect (308), query kept.

Tests: `catalog-routes.int-spec.ts` (changes, chains, reclaim, conflicts, reserved roots, hidden targets),
`catalog-route-plan.spec.ts` (normalisation, reserved first segments), `category-tree-writer.int-spec.ts` and
`typed-landing.int-spec.ts` (creation), FE `moved-route.server.test.ts` (the 308, query kept).

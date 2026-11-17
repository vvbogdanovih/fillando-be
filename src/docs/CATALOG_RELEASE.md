# Catalogue release and data maintenance

The original catalogue transition is complete. Its one-off `fillando_v_2` scripts and
`yarn migrate*` commands were retired on 2026-09-11. Do not rerun the historical pipeline
against the current catalogue.

## Current procedure

1. Start a new environment from a current MongoDB dump, including `categories`, `colors`,
   `landings` and the other catalogue collections. The original seed scripts are no longer a
   bootstrap mechanism. Restore procedures live in the meta repository's
   `docs/runbooks/local-mongodb.md`.
2. Review any migration required by the specific release. The
   [scripts inventory](../../scripts/README.md) explains which tools remain and why.
3. For attribute requiredness, follow the coordinated backend/frontend release and full data
   verification in [the migration runbook](../../scripts/migrations/category-attribute-requiredness.md).
   Entries with `is_required: false` remain filters; missing flags must not be defaulted.
4. Invalidate the relevant storefront caches after direct database changes, then verify
   catalogue filters, product URLs, prices, colour names, stock and the Google feed.
5. The Plan-0010 release (filament v1 → v2 in place, then the new admin's writes) uses
   `scripts/catalog-v2-migrate.cjs --production` with a restore-checked backup manifest and
   `scripts/catalog-admin-writes.cjs`; the order, commands, stop criteria and rollback are in the
   meta repository's `docs/runbooks/catalog-v2-release.md` (draft, rehearsed locally only).
   After the release the filament stays editable in the new admin (name, image, order,
   characteristics by exact usage, colours, promotions, supplier, archive/remove — see
   `CATEGORY_TREE.md`). There is no in-place undo of the migration (`revert` removed, owner
   decision 2026-11-06): a failed release is rolled back by restoring the catalogue from the
   release's own backup (runbook §5).
   Verify is scripted (meta `scripts/catalog-rehearsal/release-check.cjs`, `seo-status.mjs` — PASS/FAIL); the
   full verify in production mode on the dump copy found two defects, both fixed 29.10: the typed listing did not
   put in-stock SKUs first, and the feed stayed 503 after the CLI's write (a stale stamp now queues a rebuild).

## Runtime contracts retained after the transition

- `colors` is the source of Ukrainian and English colour names. Variant names use the dictionary;
  initial variant slugs are derived from `v_value`.
- Local Plan-0010 changes preserve variant slugs when product/variant names change.
  Intentional URL changes use the redirect-backed operation (`POST /routes/*/slug-change`,
  `CATALOG_ROUTES.md`; was «future» here before 28.10).
- Draft products and draft landings must remain hidden from public listings. Public variant
  detail pages may expose ACTIVE/ARCHIVED variants according to the current API contract.
- `weight_g` is editable in the variant form. The old 220 g spool backfill was an initial estimate,
  not a reason to recalculate all weights on every deployment.
- Existing landings are edited/published in the admin; do not recreate them from historical copy.

## Historical release notes

The original deployment order, data decisions and rollback procedures remain in Git:

```sh
git show c091e43dcabab0e287f0079545e3ab133a6da5f2:src/docs/CATALOG_RELEASE.md
```

This historical document is relevant only when restoring a pre-transition dump in an isolated
environment. Local old migration reports were preserved under
`.local/migration-archives/2026-09-11-script-retirement/`; they were not deleted with the scripts.

## Local Plan-0010 tree writer (not an HTTP API)

`CategoryTreeWriter` now supports create/move and permanent removal or explicit
kind conversion of unused v2 drafts. Deletion checks children, products, variants,
landings, route reservations and storefront references; it never cascades. Conversion
requires no children/products/variants/landings and validates the new definitions.
Neither operation accepts active categories or upgrades legacy records implicitly.

The journal stores an exact BSON before-image for draft deletion, rechecks references
on resume, and refuses restoration on identity/parent conflicts. Partial operations
keep the gate closed for explicit recovery. (Superseded: since 28.10 they are ADMIN HTTP
operations — `POST /categories/:id/admin/deletion|conversion` — and an interrupted one is recovered
with `scripts/catalog-recover.cjs`, audit 31.10; the release itself is meta
`docs/runbooks/catalog-v2-release.md`.)

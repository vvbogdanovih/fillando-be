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

## Runtime contracts retained after the transition

- `colors` is the source of Ukrainian and English colour names. Variant names use the dictionary;
  variant slugs remain derived from `v_value`.
- Changing a product name must validate all target slugs before writing. Colliding/rotating slugs
  are handled by the existing product service; no old migration runner is involved.
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

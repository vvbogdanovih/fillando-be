# Fillando v2 — catalogue data migration

Everything that changes catalogue data for the TD-0002 / TD-0005 work lives here, in the one
order that works. Older, unrelated one-off migrations stay in `../migrations/`.

## Run it

```bash
yarn migrate --dry-run   # read every plan, writes nothing
yarn migrate             # apply; the colour step is held back on purpose
# …deploy the frontend, confirm a product page shows "Чорний (Black)"…
yarn migrate --colors-only
```

`yarn migrate` is `node scripts/fillando_v_2/run-all.js`. It is the only thing you have to run:
it invokes the twelve scripts below in order, stops at the first failure, and prints which database
it is about to touch before it starts. An apply on a terminal asks for confirmation; non-interactive apply requires `--yes`.
Unknown flags and conflicting colour modes are refused before connecting.

Two more commands:

```bash
yarn migrate:verify                                  # read-only report, safe against production
yarn migrate:rehearse ~/Desktop/db_backup_for_test   # whole chain against a dump, in a throwaway DB
```

## Flags

| Flag               | Effect                                                         |
| ------------------ | -------------------------------------------------------------- |
| `--dry-run`        | every step prints its plan and writes nothing                  |
| `--colors-only`    | runs only the held-back steps (colours and the product rename) |
| `--include-colors` | runs the whole chain including them                            |
| `--single-pass`    | one pass instead of two (see below)                            |
| `--yes`            | do not ask for confirmation before writing                     |

## The order, and why it is this order

| #   | Script                        | Why here                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `fix-known-data-defects.js`   | repairs the known-broken documents first, so the taxonomy has a `material` to read                                                                                                                                                                                                                                                                                 |
| 2   | `normalize-attr-keys.js`      | renames attribute keys stored before `ATTR_KEY_OVERRIDES` existed                                                                                                                                                                                                                                                                                                  |
| 3   | `derive-material-taxonomy.js` | writes `polymer` / `finish` / `reinforcement` / `series` from `material`                                                                                                                                                                                                                                                                                           |
| 4   | `split-refill-products.js`    | after the taxonomy, so the new product inherits it; before the backfill, so its parent stops being a mixed product                                                                                                                                                                                                                                                 |
| 5   | `backfill-spool-included.js`  | now that every refill is separate, `Так` is true of every remaining product                                                                                                                                                                                                                                                                                        |
| 6   | `seed-colors.js`              | the dictionary the next steps match against                                                                                                                                                                                                                                                                                                                        |
| 7   | `seed-landings.js`            | its pinned filters key off the dimensions steps 3 and 5 create                                                                                                                                                                                                                                                                                                     |
| 8   | `fill-landing-copy.js`        | writes the reviewed copy into those landings, leaving them drafts                                                                                                                                                                                                                                                                                                  |
| 9   | `backfill-variant-weight.js`  | sets `weight_g` on every variant from «Вага» plus a 220 g spool (refills without it); anywhere, since it touches only variants whose weight is still null                                                                                                                                                                                                          |
| 10  | `backfill-attribute-units.js` | after 3 and 5, which decide which required attributes a category has: a unit can only be written onto an attribute that is already there. Fills `required_attributes[].unit` and renames the «Вага» label to «Вага філаменту»                                                                                                                                      |
| 11  | `normalize-variant-colors.js` | **held back**: it rewrites `v_value` to the English colour name, so until the storefront renders `color` the whole shop shows English colours                                                                                                                                                                                                                      |
| 12  | `rename-products-short.js`    | **held back**, after 11: renames products to the short names in `short-names.js` («Kingroon PLA Silk Rainbow»), keeping the «— Чорний (Black)» suffix step 11 wrote; every variant slug is regenerated **without a 301** (the owner's decision) and appended to `slug-map.json`. A product with the long prefix and no dictionary entry is refused, not guessed at |

Step 10 has one precondition of its own. The attribute label is the source of the attribute
key (`generateAttrKey`), so renaming «Вага» to «Вага філаменту» would move `vaha` to
`vaha_filamentu` on the next admin save and every filter, landing and facet pinned on `vaha`
would stop matching. The step therefore renames the label **only** when `ATTR_KEY_OVERRIDES`
maps «вага філаменту» to the key the document already carries; until that entry is deployed it
fills the units, reports the rename as waiting and exits 0. Nothing else in the chain depends on
it, so a re-run of that single step finishes the job later.

Supporting files, not steps: `landing-copy.js` is the reviewed landing text, `short-names.js` the
reviewed short product names (draft it with `node rename-products-short.js --propose`), `verify-catalog-state.js`
is the report, `rehearse-on-dump.sh` is the rehearsal harness, `reports/` is gitignored output. `catalog-snapshot.js` supports the rehearsal;
`tests/` contains runner and interruption regressions (`yarn migrate:test`).
`../shipping-rates.js` (`yarn shipping:rates`) is not a migration either: it asks Nova Poshta for
the shop's tariff and writes `scripts/shipping-rates.json`, which the storefront's delivery
estimate and Merchant Center's shipping settings are both filled from (TD-0006 §5.4).

## Two passes

An apply runs the chain twice. Steps after the taxonomy append attributes to products while the
taxonomy rebuilds its derived entries into a canonical order, so the first pass leaves a few
products merely ordered differently from what it would write. The second pass settles that and
reports nothing to do. Verified on a production dump: a third pass plans no changes at all.

## What every script guarantees

- `--dry-run` prints the full plan before anything is written.
- Idempotent: a second run reports "Nothing to do."
- Run with catalogue writes and synchronisation stopped. Conditional updates detect many
  concurrent edits, but the chain is not a transaction and does not support a live writer.
  Standalone and replica-set MongoDB use the same sequential write protocol.
- Reports land in `reports/`, or in `MIGRATION_REPORT_DIR` when it is set. The rehearsal sets it
  to a temporary directory, so a rehearsal can never overwrite the reports of a real run.

## Rehearsing on a dump

```bash
yarn migrate:rehearse ~/Desktop/db_backup_for_test
```

Restores a `mongodump` into a new disposable MongoDB 7 container on a randomly assigned localhost
port. It never reuses or removes the integration-test container. A failed restore stops the run.
Both the dump root (one database) and the database folder itself are accepted; ambiguous roots
are refused. Only catalogue collections are restored; orders and accounts stay in the dump.
The harness compares BSON-aware snapshots before/after dry-run and before/after a third apply.
Any changed value fails the convergence check. The container is removed on success or failure;
`--keep` retains it for inspection. Reports and snapshots remain at the printed temporary path.

Last run against a production dump, 2026-09-05: chain applied cleanly, converged on the second
pass, colour coverage 291 of 293 variants (293 of 293 since step 3a tells the two «Candy»
variants apart, 2026-09-07), all fourteen landings listing products, integrity
clean. Before that fix the two variants left unmatched were both stored as "Candy" on one product and needed a
person to tell them apart.

## After the chain

The full procedure, including what to deploy before which step and how to undo each one, is
[`src/docs/CATALOG_RELEASE.md`](../../src/docs/CATALOG_RELEASE.md).

## Fresh database on the new hosting (2026-09-10)

Restore the complete production dump into the new database first, preserving BSON ObjectIds and
indexes. Do not use JSON import. Keep storefront traffic, admin edits and stock synchronisation
on the old deployment until migration and verification finish. Run the migration locally from the updated backend checkout with dependencies installed.
The production image does not need the migration scripts.

From the **local backend root**, explicitly set `DATABASE_URL` to the NEW database URI (including the
database name). The runner prints host and database without credentials and checks for restored
`filament`, products and variants before starting. For a different target use a new persistent
`MIGRATION_REPORT_DIR`; keep that directory through retries and for rollback. Keep the reports locally alongside the source dump; they are not stored on the hosting.

```bash
# DATABASE_URL and MIGRATION_REPORT_DIR must already point at the new target and its reports.
yarn migrate --dry-run --include-colors
yarn migrate --include-colors --yes
yarn migrate:verify
```

`--include-colors` is correct for the new, offline database: the new frontend will be the first
one to read it. The default `yarn migrate` deliberately holds colours and short names back for
an in-place deployment. Do not use `--single-pass` for the first migration.

An initial dry run reads the original dump at every step: it can stop at the empty colour
dictionary because the seed was only simulated. This is **not** proof of a failed apply or a
successful end-to-end migration; `yarn migrate:rehearse` on that dump is the end-to-end check.

A full apply now runs the complete verifier automatically. `yarn migrate:verify` also uses
`--complete`: empty/missing catalogue, missing dimensions, unresolved colours, invalid shipping
weights, broken references, duplicate/parked slugs, missing landing copy and unfinished names
produce a non-zero exit. Draft landings with copy are allowed; publication is an editorial action.
The direct `node scripts/fillando_v_2/verify-catalog-state.js` remains an integrity/status report
for intermediate migration stages.

**Evidence survives retries:** dry runs write into a separate temporary directory. Apply reports
are archived under `$MIGRATION_REPORT_DIR/history/<run>/pass-1` and `pass-2`, preserving the first
pass's refill split and original fields. `rename-journal.json` is saved atomically BEFORE rename
writes and retains original names/slugs across retries; use it for `--rollback`, not the latest
`rename-report.json` (which is a current plan and may be empty). A corrupted slug map is refused
instead of silently replaced. A database backup remains the full rollback for the entire chain.

After migration: review/publish landings, rewrite the refill description, check estimated weights,
set the filament category's Google taxonomy to `499682` in the admin, then refresh the new
storefront caches and sitemap. The chain does not publish content, configure Google accounts,
fetch shipping tariffs, or run old unrelated migrations in `scripts/migrations/`.

Validation on the available `db_backup_for_test` dump: 44 products, 301 variants, 293/293 colour
assignments, 122 dictionary colours, 14 landings with copy. Also run the fault regressions against
a retained rehearsal container by setting `TEST_MIGRATION_URI` to its printed localhost
`mongodb://127.0.0.1:<port>/rehearsal` URI and running `yarn migrate:test`; those tests copy catalogue
fixtures into their own database and remove it afterwards.

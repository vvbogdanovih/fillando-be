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
it invokes the nine scripts below in order, stops at the first failure, and prints which database
it is about to touch before it starts. An apply on a terminal asks for confirmation; `--yes`
skips that for scripts and CI.

Two more commands:

```bash
yarn migrate:verify                                  # read-only report, safe against production
yarn migrate:rehearse ~/Desktop/db_backup_for_test   # whole chain against a dump, in a throwaway DB
```

## Flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | every step prints its plan and writes nothing |
| `--colors-only` | runs only the held-back colour step |
| `--include-colors` | runs the whole chain including it |
| `--single-pass` | one pass instead of two (see below) |
| `--yes` | do not ask for confirmation before writing |

## The order, and why it is this order

| # | Script | Why here |
| --- | --- | --- |
| 1 | `fix-known-data-defects.js` | repairs the known-broken documents first, so the taxonomy has a `material` to read |
| 2 | `normalize-attr-keys.js` | renames attribute keys stored before `ATTR_KEY_OVERRIDES` existed |
| 3 | `derive-material-taxonomy.js` | writes `polymer` / `finish` / `reinforcement` / `series` from `material` |
| 4 | `split-refill-products.js` | after the taxonomy, so the new product inherits it; before the backfill, so its parent stops being a mixed product |
| 5 | `backfill-spool-included.js` | now that every refill is separate, `Так` is true of every remaining product |
| 6 | `seed-colors.js` | the dictionary the next steps match against |
| 7 | `seed-landings.js` | its pinned filters key off the dimensions steps 3 and 5 create |
| 8 | `fill-landing-copy.js` | writes the reviewed copy into those landings, leaving them drafts |
| 9 | `normalize-variant-colors.js` | **held back**: it rewrites `v_value` to the English colour name, so until the storefront renders `color` the whole shop shows English colours |

Supporting files, not steps: `landing-copy.js` is the reviewed landing text, `verify-catalog-state.js`
is the report, `rehearse-on-dump.sh` is the rehearsal harness, `reports/` is gitignored output.

## Two passes

An apply runs the chain twice. Steps after the taxonomy append attributes to products while the
taxonomy rebuilds its derived entries into a canonical order, so the first pass leaves a few
products merely ordered differently from what it would write. The second pass settles that and
reports nothing to do. Verified on a production dump: a third pass plans no changes at all.

## What every script guarantees

- `--dry-run` prints the full plan before anything is written.
- Idempotent: a second run reports "Nothing to do."
- Updates pin the values they read, so a save made in the admin mid-run is skipped and reported
  rather than silently overwritten. There are no transactions on this standalone MongoDB, so
  this is the compensation for that.
- Reports land in `reports/`, or in `MIGRATION_REPORT_DIR` when it is set. The rehearsal sets it
  to a temporary directory, so a rehearsal can never overwrite the reports of a real run.

## Rehearsing on a dump

```bash
yarn migrate:rehearse ~/Desktop/db_backup_for_test
```

Restores a `mongodump` into the disposable MongoDB from `docker-compose.test.yml`, runs the whole
chain against it, and prints the state before and after plus a convergence check. It restores
only the catalogue collections, so customers' orders and accounts never leave the dump.

Last run against a production dump, 2026-09-05: chain applied cleanly, converged on the second
pass, colour coverage 291 of 293 variants, all fourteen landings listing products, integrity
clean. The two variants left unmatched are both stored as "Candy" on one product and need a
person to tell them apart.

## After the chain

The full procedure, including what to deploy before which step and how to undo each one, is
[`src/docs/CATALOG_RELEASE.md`](../../src/docs/CATALOG_RELEASE.md).

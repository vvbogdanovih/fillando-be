# Catalogue release — deploy and migration order

How to take Plan-0003 and Plan-0004 from `dev` to production. Written because the ordering
rules were spread across two `CLAUDE.md` files, a plan document and several commit messages,
and getting one of them wrong is visible to every visitor.

Everything below is already merged into `dev` in both repositories and **not deployed**.

---

## 0. Before you start

Three decisions are still open. None of them blocks the deploy, but each one leaves something
half-finished until it is made.

| # | Decision | Consequence of leaving it |
| --- | --- | --- |
| 1 | One product has an **empty `material`**: *Філамент Kingroon PETG (CoPET) 1,75 мм 3 кг* (`6a81a21315e62e1899044300`). | It is skipped by the taxonomy migration, so it appears under no polymer filter and on no landing. Set `Матеріал = PETG` in the admin, then re-run step 3b. |
| 2 | **49 colour spellings** the dictionary cannot identify, and **2 slug collisions**, listed in `scripts/migrations/reports/color-report.json` after a dry run. | Those variants keep their current Ukrainian value and stay out of the colour filter. Nothing breaks; the filter is simply less complete. |
| 3 | The **refill is a variant, not a product** (`FL-000253`, "Clear Безбарвний Refill"). TD-0002 assumed a separate product. | `spool_included` cannot describe that product, `/filament/refill` matches nothing, and the migrations deliberately skip it. Splitting it into its own product makes all three work with no code change. |

The same product also carries `category_id` as a **string** rather than an ObjectId. It is
harmless today (its variant has the right type), but any future query that filters products by
`category_id` must compare with `$toString` or it will silently skip this one.

---

## 1. Deploy the backend

`dev → main`, then the server (see `fillando-meta/docs/runbooks/deploy-backend-lxc.md`).

Ships: RBAC on write endpoints, the public projections, rate limiting, the payment-status
lookup, `ATTR_KEY_OVERRIDES`, the `colors` and `landings` modules, the colour filter, and the
colour payload on every public product response.

`INTERNAL_API_TOKEN` must be present in `.env.prod` and identical to the frontend's — the
frontend's server-side fetches use it to bypass the rate limiter.

**Verify:** `/swagger` lists `/colors` and `/landings`; `GET /colors` answers 200 with `[]`;
`GET /landings/admin` answers 401 without a token.

---

## 2. Deploy the frontend

`dev → main`, then the server.

This step is not optional before step 3f, and it is the one that is easy to postpone: the
storefront must be rendering `color` **before** the colour migration rewrites `v_value` to the
English name. Deploying the backend alone and running 3f would switch the whole Ukrainian shop
to English colour names.

**Verify:** a product page still shows its Ukrainian colour; `/filament?page=2` is reachable by
clicking, and its links are real `<a href>`; the header lists categories fetched from the API.

---

## 3. Migrations

Run from the backend project root, against production. **Every script takes `--dry-run` and
prints its full plan before it writes anything — always run the dry run first and read it.**
Each script is idempotent, so a re-run after a fix is safe.

Reports land in `scripts/migrations/reports/` (gitignored).

### 3a. `normalize-attr-keys.js`

```bash
node scripts/migrations/normalize-attr-keys.js --dry-run
node scripts/migrations/normalize-attr-keys.js
```

Renames attribute keys stored before `ATTR_KEY_OVERRIDES` existed. On the current data it
reports **"Nothing to do."** — it is a safety net for keys created through the admin between
the code deploy and this run, not a required step.

Must run **after** step 1, never before: the override table has to be live, or the next admin
save regenerates the transliterated key.

### 3b. `derive-material-taxonomy.js`

```bash
node scripts/migrations/derive-material-taxonomy.js --dry-run
node scripts/migrations/derive-material-taxonomy.js
```

Writes `polymer` / `finish` / `reinforcement` / `series` on every product from its `material`,
which stays as the marketing name, and swaps `material` for those four in the category's
`required_attributes`.

Expect on current data: 42 of 43 products changed, 1 category changed, 1 unmatched value (the
empty `material` from decision 1). Derived values: 7 polymers, 10 finishes, 2 reinforcements,
4 series.

**Verify:** the script's own `Verify:` block is all `OK`; `/filament` shows the four new filters
and no longer shows «Матеріал».

### 3c. `backfill-spool-included.js`

```bash
node scripts/migrations/backfill-spool-included.js --dry-run
node scripts/migrations/backfill-spool-included.js
```

Gives every product `spool_included = Так`, then adds the filter to the category. Products
first: a category offering a filter no product carries returns an empty catalogue, whereas the
reverse is invisible.

Expect on current data: 42 products changed, 1 category changed, 1 product skipped.

It **skips and reports** the product that holds the refill variant (decision 3), because no
single product-level value is true for it.

### 3d. `seed-colors.js`

```bash
node scripts/migrations/seed-colors.js --dry-run
node scripts/migrations/seed-colors.js
```

Inserts 53 dictionary colours. Non-destructive: an existing colour matched on `name_en` is left
untouched, so a hex tweaked in the admin survives a re-run.

### 3e. `seed-landings.js`

```bash
node scripts/migrations/seed-landings.js --dry-run
node scripts/migrations/seed-landings.js
```

Creates the 14 landings **as drafts** and prints how many variants each would list. Read that
list: on current data 13 have products and `/filament/refill` has **0**, because of decision 3.
A landing with 0 products must not be published.

Must run after 3b and 3c — its filters key off the dimensions those create.

### 3f. `normalize-variant-colors.js` — the risky one

**Do not run this until steps 1 and 2 are both live in production.** It rewrites `v_value` to
the canonical English name; until the storefront renders `color` instead, the shop displays
English colour names.

```bash
node scripts/migrations/normalize-variant-colors.js --dry-run
# read scripts/migrations/reports/color-report.json, then:
node scripts/migrations/normalize-variant-colors.js
```

Expect on current data: 242 of 292 colour variants matched (83%), 49 spellings left untouched,
1 refill variant skipped, and 2 slug collisions. **A collision aborts the run** rather than half-applying it — resolve it (rename
a variant, or split the dictionary entry) and re-run. `--force` applies everything else and
leaves the collisions for later; use it deliberately, not to get past the message.

Variant **slugs change without a 301** — the owner's decision. `reports/slug-map.json` records
every old → new address and is merged across runs, never truncated, so it survives a re-run.

**Verify:** a migrated product page shows "Чорний (Black)"; the colour filter offers swatches;
`reports/color-report.json` has the unmatched list for the manual pass.

---

## 4. After the migrations

1. Mark the refill by hand: `Котушка в комплекті = Ні (рефіл)` on the refill product, once
   decision 3 is made.
2. Write the copy for each landing in `/admin/landings` and publish it. A landing stays a draft
   until someone writes its text — an empty SEO page in the index is worse than no page.
3. Work through `color-report.json`: add a synonym to `seed-colors.js` for each spelling worth
   mapping, then re-run 3d and 3f. Both are idempotent.
4. Resubmit the sitemap in Search Console — it now carries the legal pages, the price sheet and
   the published landings.

---

## 5. Rollback

| Step | How to undo |
| --- | --- |
| 1, 2 | Redeploy the previous image. No data changed. |
| 3a–3c | No automatic undo. The derived attributes are rebuilt from `material` on every run, so a corrected mapping table is simply re-applied; removing them entirely means a one-off script. |
| 3d | Delete the inserted colours — the API refuses while variants reference them, which is the safety you want. |
| 3e | Delete the landings; they are drafts and invisible until published. |
| 3f | `v_value_legacy` holds the original spelling on every migrated variant, and `slug-map.json` holds every address change. Keep both for **one release**, then a follow-up can drop `v_value_legacy`. |

A migration that fails verification exits non-zero and prints which check failed. None of them
writes partially on purpose: the two riskiest pin the array they read in the update filter, so a
document edited in the admin mid-run is skipped and reported rather than overwritten.

# Catalogue release — deploy and migration order

> **New hosting / fresh database (2026-09-10):** follow
> [`scripts/fillando_v_2/README.md`, “Fresh database on the new hosting”](../../../scripts/fillando_v_2/README.md).
> Restore the dump, explicitly select the new database, then `yarn migrate --include-colors --yes`
> and `yarn migrate:verify` before switching traffic. The runner executes all 12 steps twice and
> performs complete verification. Run these commands locally from the updated backend checkout,
> with DATABASE_URL pointing to the new database; no production image change is needed. The LXC/main
> deployment commands below are historical; the owner's new release branch is `production`.
> Save migration reports on persistent storage. Rollback of names uses `rename-journal.json`;
> first-pass reports survive under `history/<run>/pass-1`. Initial dry-run may stop at an empty
> colour dictionary because earlier seed steps are simulated; rehearse the dump before apply.


How to take Plan-0003 and Plan-0004 from `dev` to production. Written because the ordering
rules were spread across two `CLAUDE.md` files, a plan document and several commit messages,
and getting one of them wrong is visible to every visitor.

Everything below is already merged into `dev` in both repositories and **not deployed**.

---

## 0. Before you start

Four decisions are still open. None of them blocks the deploy, but each one leaves something
half-finished until it is made.

| #   | Decision                                                                                                                                                                                                                                                                                          | Consequence of leaving it                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~One product has an empty `material`~~ — **handled by step 3a** since 2026-09-05.                                                                                                                                                                                                                | Nothing to decide. `fix-known-data-defects.js` sets `Матеріал = PETG` on Kingroon PETG (CoPET) 3 кг and repairs its `category_id`, which was stored as a string.                                                                                     |
| 2   | **49 colour spellings** the dictionary cannot identify, listed in `scripts/fillando_v_2/reports/color-report.json` after a dry run.                                                                                                                                                               | Those variants keep their current Ukrainian value and stay out of the colour filter. Nothing breaks; the filter is simply less complete.                                                                                                             |
| 3   | ~~The refill is a variant, not a product~~ — **handled by step 3d** since 2026-09-05.                                                                                                                                                                                                             | Nothing to decide. `split-refill-products.js` moves FL-000253 onto its own product; the only manual step left is rewriting that product's description, which it inherits from the parent.                                                            |
| 4   | ~~**Two 'Candy' variants sit on one product**~~ — **handled by step 3a** since 2026-09-07. `FL-000157` (Kingroon B01889, ₴890) and `FL-000162` (Kingroon HC258, ₴860) on _Kingroon PLA Silk Rainbow_ arrived from Prom with the same colour name; the owner told them apart from the photographs. | Nothing to decide. `fix-known-data-defects.js` sets `FL-000162` to «Rainbow Candy» (pastel shades; B01889 stays the saturated «Candy»), `seed-colors.js` carries both entries, so 3k matches all 293 colour variants and 3l renames all 43 products. |

The same product as #1 also carries `category_id` as a **string** rather than an ObjectId. It is
harmless today (its variant has the right type), but any future query that filters products by
`category_id` must compare with `$toString` or it will silently skip this one.

Find every latent pair of #4's shape before the deploy. A rename regenerates all of a product's
slugs at once, so two variants whose values collapse to the same slug block that product. Collide
on the generated slug, not on `v_value` — different values can still slugify to one address:

```js
// node, from the backend project root, against production
const { generateSlug } = require('./dist/common/utils/attribute.utils')
// for each product, group its variants by generateSlug(`${product.name} ${v.v_value}`)
// and report every group holding more than one SKU
```

On `fillando-dev` this reported exactly one group, `FL-000157 + FL-000162`, until step 3a began
telling them apart; after 3a it reports none. Step 3l (the product rename) runs the same check
itself and refuses any product that still collides, so a new pair of this shape must be settled
**before 3l**.

---

## 1. Deploy the backend

`dev → main`, then the server (see `fillando-meta/docs/runbooks/deploy-backend-lxc.md`).

Ships: RBAC on write endpoints, the public projections, rate limiting, the payment-status
lookup, `ATTR_KEY_OVERRIDES`, the `colors` and `landings` modules, the colour filter, and the
colour payload on every public product response.

**Step 3j wants one more pair in `ATTR_KEY_OVERRIDES`:** `'вага філаменту': 'vaha'`, in
`src/common/utils/attribute.utils.ts`, its mirror `toAttrKey` in
`fillando-fe/src/common/utils/slug.utils.ts` and the copy in
`scripts/fillando_v_2/normalize-attr-keys.js` (a unit test enforces BE ↔ migration sync).
Without it 3j fills the units and refuses the label rename, which is safe but leaves the row
reading «Вага». Not a blocker for this deploy — that one step can be re-run on its own later.

**Merging is deploying.** `.github/workflows/deploy.yml` fires on every push to `main`: it pulls
`main` on the LXC, rebuilds the image with `--no-cache` and restarts the container. Have
`.env.prod` and the checks below ready before clicking merge, not after.

`INTERNAL_API_TOKEN` is **optional and should stay out of `.env.prod` for now.** The schema is
`z.string().min(32).optional()` (`src/common/constants/env.constant.ts`): an unset key means
"nothing is exempted" and is safe, but an **empty `INTERNAL_API_TOKEN=` line fails validation and
the API does not boot** — check the file for exactly that line before deploying. The frontend on
`dev` never sends `X-Internal-Token` (no `serverFetch` call hits a throttled endpoint, so it does
not need to), so setting the token buys nothing today.

**Rate limiting keys on `req.ip`** (the `@nestjs/throttler` default tracker) with `trust proxy 1`
in `main.ts`, i.e. the address the **last** proxy saw. Production sits behind Cloudflare
(`server: cloudflare` and `cf-ray` on `api.fillando.com`) in front of Nginx Proxy Manager, so
unless NPM restores the client address from `CF-Connecting-IP` (`set_real_ip_from` the Cloudflare
ranges + `real_ip_header CF-Connecting-IP`), `req.ip` is a Cloudflare edge address and every
visitor behind that edge shares one bucket. The visible symptom is a `429` on `POST /auth/refresh`
(30/min), which the frontend answers by logging the user out. Check the NPM host config before
the deploy; if it does not restore the real IP, fix it there or add a `getTracker` that reads
`CF-Connecting-IP` before relying on the limits.

**Verify:** `docker logs fillando-be` shows a clean boot; `/swagger` lists `/colors` and
`/landings`; `GET /colors` answers 200 with `[]`; `GET /landings/admin` answers 401 without a
token. Plan-0003 checks: with a USER cookie `PATCH /products/:id` → 403 while the admin creates a
product → 201; `GET /products/by-slug/<slug>` carries no `prom_id` / `vendor_product_sku`; a draft
variant slug → 404; `GET /products/price-sheet?q=<vendor sku>` → empty; the 11th `POST /auth/login`
within a minute → 429 with `Retry-After`; `GET /orders/lookup` with a wrong token → 404 and with
the right one → the four public fields only.

---

## 2. Deploy the frontend

`dev → main`, then the server.

Same mechanism: the push to `main` builds the image on the frontend LXC. **The build talks to the
live API** — on `dev`, `serverFetch` throws on failure and `next build` pre-renders pages and the
sitemap from `NEXT_PUBLIC_API_BASE_URL`, so the build fails outright if `api.fillando.com` is
down and ships a stale sitemap if the backend is still the old one. Merge the frontend only after
step 1 is verified live.

This step is not optional before step 3i, and it is the one that is easy to postpone: the
storefront must be rendering `color` **before** the colour migration rewrites `v_value` to the
English name. Deploying the backend alone and running 3i would switch the whole Ukrainian shop
to English colour names.

**Verify:** a product page still shows its Ukrainian colour; `/filament?page=2` is reachable by
clicking, and its links are real `<a href>`; the header lists categories fetched from the API;
`sitemap.xml` carries the legal pages and `/price-sheet` and no draft SKU. LiqPay sandbox
(Plan-0003 §6): success → «Дякуємо» and exactly one Google Ads conversion; declined card →
«Оплата не пройшла» and no conversion; window closed → PENDING with polling and no conversion;
`initLiqpayCheckout` failure → toast and the success page with an «Оплатити» button.

---

## 3. Migrations

**Where they run.** The production image has no `scripts/` directory (the `Dockerfile` copies
only `dist`, `package.json` and production `node_modules`) and the LXC has Docker but no Node, so
`node scripts/…` on the host does not work. Run each script in a one-off container from the
checkout GitHub Actions keeps at `/srv/fillando-api`, with `scripts/` bind-mounted:

```bash
cd /srv/fillando-api            # already on main after the deploy
docker compose -f docker-compose.prod.yml run --rm --no-deps \
  -v "$PWD/scripts:/app/scripts" api \
  node scripts/fillando_v_2/normalize-attr-keys.js --dry-run
```

`env_file: .env.prod` gives the container `DATABASE_URL` (the scripts call `dotenv.config()`,
which never overrides a variable that is already set); `mongoose` and `dotenv` are production
dependencies already in the image; `normalize-variant-colors.js` finds `./seed-colors.js` through
the same mount; and reports land in `scripts/fillando_v_2/reports/` **on the host** (gitignored).
The §0 slug-collision check runs the same way — `dist/` is inside the image. The `node
scripts/fillando_v_2/…` lines below are what goes after `api` in that invocation.

**Rehearse on a dump before you touch production.** `rehearse-on-dump.sh` restores a
`mongodump` into the disposable MongoDB from `docker-compose.test.yml`, runs the whole chain
against it and prints the state before and after. It restores only the catalogue collections,
so customer data never leaves the dump, and it writes its reports to a temporary directory so
they cannot be mistaken for a real run:

```bash
yarn migrate:rehearse ~/Desktop/db_backup_for_test
```

Last rehearsal against a production dump, 2026-09-05: the chain applied cleanly, converged on
the second pass, and a third dry pass planned no changes. Every number quoted below is measured
from that run rather than estimated.

`verify-catalog-state.js` is the report it uses, and it writes nothing, so it is also the thing
to run against production right after the real migration:

```bash
yarn migrate:verify
```

**Everything that migrates catalogue data lives in `scripts/fillando_v_2/`, and one command runs
all of it.** The order below is what `run-all.js` encodes; getting it wrong by hand is easy, so
do not invoke the twelve scripts individually.

```bash
yarn migrate --dry-run      # read every plan, writes nothing
yarn migrate                # apply; the colour step is held back
yarn migrate --colors-only  # after the frontend is live
```

It prints which database it is about to change before it starts, and an apply on a terminal asks
for confirmation: `yarn migrate` follows `.env`, which on a laptop is the shared dev database
rather than production. `--yes` skips the question.

An apply makes two passes. Steps after the taxonomy append attributes to products while the
taxonomy rebuilds its derived entries into a canonical order, so the first pass leaves a few
products merely ordered differently from what it would write; the second settles that and
reports nothing to do. Verified on a disposable database: a third pass plans no changes at all.

In a dry run each step reads the state as it is now, so a later step shows what it would do
_before_ the earlier ones have run. Read each plan for its own step, not as a forecast of the
whole chain.

**Every script also takes `--dry-run` on its own and prints its full plan before it writes
anything.** Each is idempotent, so a re-run after a fix is safe.

### 3a. `fix-known-data-defects.js`

```bash
node scripts/fillando_v_2/fix-known-data-defects.js --dry-run
node scripts/fillando_v_2/fix-known-data-defects.js
```

Repairs the individually known broken documents rather than applying a rule. The catalogue is
frozen while this work lands, so the broken set is closed and inspected: on current data it is
two fixes, both on _Kingroon PETG (CoPET) 3 кг_ — an empty `material`, which kept it out of the
taxonomy, and a `category_id` stored as a string, which drops it from any query matching
products by category.

Each fix names its document by `_id` and asserts what it expects to find there, so a changed
catalogue makes the run stop rather than write the wrong thing.

The third fix is the one that used to be reported as "needs a person": since 2026-09-07 the owner
has told the two «Candy» variants apart (decision 4 above), so FL-000162 gets «Rainbow Candy»
here. The script still reports any other pair of variants sharing one colour value on one
product, without touching it.

Expect on current data: 6 fixes applied (two on Kingroon PETG 3 кг, FL-000004 «Блакитний» → «Sky Blue»,
FL-000067 «Бірюзовий» → «Cyan» and FL-000127 «HC186» → «Yellow-Green» by the Kingroon article numbers on the June 2026 invoice, one on FL-000162 «Candy» →
«Rainbow Candy»); nothing left to decide.

### 3b. `normalize-attr-keys.js`

```bash
node scripts/fillando_v_2/normalize-attr-keys.js --dry-run
node scripts/fillando_v_2/normalize-attr-keys.js
```

Renames attribute keys stored before `ATTR_KEY_OVERRIDES` existed. On the current data it
reports **"Nothing to do."** — it is a safety net for keys created through the admin between
the code deploy and this run, not a required step.

Must run **after** step 1, never before: the override table has to be live, or the next admin
save regenerates the transliterated key.

### 3c. `derive-material-taxonomy.js`

```bash
node scripts/fillando_v_2/derive-material-taxonomy.js --dry-run
node scripts/fillando_v_2/derive-material-taxonomy.js
```

Writes `polymer` / `finish` / `reinforcement` / `series` on every product from its `material`,
which stays as the marketing name, and swaps `material` for those four in the category's
`required_attributes`.

Expect on current data: 42 products changed, 1 category changed, 1 unmatched value (the empty
`material` from decision 1). Derived: polymer on 43 of 44 products (PLA 24, PETG 9, PA6 3, ABS 3,
TPU 2, ASA 1, PET 1), finish on 16, reinforcement on 8 (CF 7, GF 1), series on 43.

**Verify:** the script's own `Verify:` block is all `OK`; `/filament` shows the four new filters
and no longer shows «Матеріал».

### 3d. `split-refill-products.js`

```bash
node scripts/fillando_v_2/split-refill-products.js --dry-run
node scripts/fillando_v_2/split-refill-products.js
```

Moves every refill variant onto a product of its own. On current data that is one variant,
FL-000253 "Clear Безбарвний Refill", which sits on the Bambu Lab PETG Translucent product beside
eight spooled colours. It creates `<parent name> (без котушки)`, copying the parent's category,
vendor, description, variant axis and attributes, and marks it `Котушка в комплекті = Ні (рефіл)`;
the parent gets `Так`.

It also strips the word "Refill" from the variant's `v_value`, because the product name now
carries the distinction. That is what lets step 3i resolve the colour: while the marker lived in
the colour value, the normaliser had to skip the variant to avoid erasing it. For the same reason
the suffix is `(без котушки)` and not `Refill` — `isRefillVariant` reads the variant name, and the
variant name is built from the product name.

The variant's address changes and there is no 301, so the move is recorded in
`reports/slug-map.json` alongside the colour migration's moves. Target slugs are checked for a
clash before the first write.

Expect on current data: 1 product created, 1 variant moved, parent keeps 8 spooled variants.

**Verify:** `reports/refill-split-report.json`; `/filament/refill` stops matching zero products;
the new product opens in the admin. Its description was copied from the parent, so rewrite it.

### 3e. `backfill-spool-included.js`

```bash
node scripts/fillando_v_2/backfill-spool-included.js --dry-run
node scripts/fillando_v_2/backfill-spool-included.js
```

Gives every product `spool_included = Так`, then adds the filter to the category. Products
first: a category offering a filter no product carries returns an empty catalogue, whereas the
reverse is invisible.

Expect on current data: 42 products changed, 1 category changed, nothing skipped — step 3d has
already separated the one refill. The end state is `Так` on 43 products and `Ні (рефіл)` on 1.

It **skips and reports** the product that holds the refill variant (decision 3), because no
single product-level value is true for it.

### 3f. `seed-colors.js`

```bash
node scripts/fillando_v_2/seed-colors.js --dry-run
node scripts/fillando_v_2/seed-colors.js
```

Inserts 122 dictionary colours. The 47 added on 2026-09-05 exist to cover the spellings this
catalogue actually stores: the Dual-Silk and Tri-Silk gradients, the numbered Sunlu rainbows,
the thermochromic pairs and the one-off finishes. The 17 added (and «Dual Silk HC186» renamed to Yellow Green Silk) on 2026-09-07 give Sunlu and
Kingroon colours the names their invoices print (Sunny Orange, Cherry Red, Sky Blue, Transparent,
the Blue-Green and Blue-Purple Dual-Silk pairs…) instead of a Bambu neighbour's name; a supplier's
misspelling («Roasted Chesnut») is a synonym only. A spec asserts every stored spelling still
resolves, and that these resolve to the supplier's own name, so an edit here cannot silently drop
a product out of the colour filter or hand it another brand's colour. Non-destructive: an existing colour matched on `name_en` is left
untouched, so a hex tweaked in the admin survives a re-run.

### 3g. `seed-landings.js`

```bash
node scripts/fillando_v_2/seed-landings.js --dry-run
node scripts/fillando_v_2/seed-landings.js
```

Creates the 14 landings **as drafts** and prints how many variants each would list. On current
data, after step 3d, **all fourteen list something**:

| landing           | variants |     | landing               | variants |
| ----------------- | -------: | --- | --------------------- | -------: |
| `/filament/pla`   |      180 |     | `/filament/pla-silk`  |       24 |
| `/filament/petg`  |       72 |     | `/filament/pla-matte` |       18 |
| `/filament/abs`   |       26 |     | `/filament/carbon`    |       13 |
| `/filament/asa`   |        3 |     | `/filament/pla-cf`    |        8 |
| `/filament/tpu`   |       14 |     | `/filament/petg-cf`   |        2 |
| `/filament/nylon` |        4 |     | `/filament/wood`      |        5 |
|                   |          |     | `/filament/glow`      |        8 |
|                   |          |     | `/filament/refill`    |        1 |

A landing that lists 0 must not be published.

Must run after 3c and 3e — its filters key off the dimensions those create.

### 3h. `fill-landing-copy.js`

```bash
node scripts/fillando_v_2/fill-landing-copy.js --dry-run
node scripts/fillando_v_2/fill-landing-copy.js
```

Writes the reviewed landing copy from `scripts/fillando_v_2/landing-copy.js`: `h1`, `title`,
`meta_description`, the intro, the SEO body and the FAQ for all fourteen. Every landing stays
**draft** — the script never publishes, because two of them still match nothing (see below) and
because deciding a page is ready for Google is a person's call.

It refuses to run on copy that would not survive `sanitizeRichText`, since writing straight to
Mongo skips the API's sanitizer. It also never overwrites text edited in the admin: only a draft
whose copy is still empty is filled, so a re-run after hand edits reports them and moves on.

Expect on current data: 14 filled, 0 skipped, with `refill` flagged as matching no products.

**Verify:** `reports/landing-copy-report.json` lists every landing with its match count; open two
or three in `/admin/landings` and read the text before publishing anything. Check `petg-cf`
first: its two SKUs (FL-000180, FL-000231) reach the landing only if their `material` reads
exactly `PETG-CF`, the key step 3c maps to `polymer: PETG` + `reinforcement: CF`. A different
spelling leaves the page empty and lands in the unmatched list of `taxonomy-report.json`.

### 3i. `backfill-variant-weight.js`

```bash
node scripts/fillando_v_2/backfill-variant-weight.js --dry-run
node scripts/fillando_v_2/backfill-variant-weight.js
```

Sets `weight_g` on every variant whose weight is still `null`: the product's «Вага» attribute
(kilograms in this catalogue) converted to grams, plus a **220 g spool** unless the variant is a
refill. The spool figure is an assumption in the middle of the 200–250 g range for a 1 kg reel;
the report names any heavier reel so a person checks it. A variant with no readable weight stays
`null` and is listed — the delivery estimate, the JSON-LD and the feed then omit the weight rather
than guess. Weights typed in the admin are never overwritten.

Expect on current data: 301 variants weighed from the attribute, 0 unmatched, the one 3 kg reel
flagged for a manual check.

**Verify:** `reports/weight-report.json`; open a few variants in `/admin/products` and read
«Вага, г». The delivery block on a product page shows a figure only once this has run.

### 3j. `backfill-attribute-units.js`

```bash
node scripts/fillando_v_2/backfill-attribute-units.js --dry-run
node scripts/fillando_v_2/backfill-attribute-units.js
```

Closes the missing «Вага філаменту» row of the mock (Plan-0005 I-27), which is a **data** gap:
the backend already carries the unit in the public product payload and the storefront already
prints `value + unit`, but `required_attributes[].unit` is `null` in every category — every
migration written before this one sets it that way — so the storefront has nothing to print
after the bare `1` the products store and **drops the row** rather than show «Вага | 1».

Two writes, in this order:

1. **The unit, on the category.** From an explicit label → unit table in the script: «Вага» →
   `кг`, «Діаметр» → `мм`, «Температура друку» → `°C`. An attribute is skipped, never guessed
   at, when the label is not in the table, when the stored values already spell the unit
   («1,75 мм» would print as «1,75 мм мм»), or when a value breaks the unit's sanity bound (a
   weight above 20 is grams, not kilograms). Every skip is printed with its reason and lands in
   `reports/attribute-units-report.json`.
2. **The label, on the category and on every product.** «Вага» → «Вага філаменту», with the key
   left exactly as it was.

The value is **not** converted. This catalogue stores the net weight in kilograms and says so
everywhere a shopper looks — product names («1,75 мм 1 кг»), the price sheet, the invoices — so
the row reads «Вага філаменту | 1 кг». The mock spells the same fact as «1000 г»; the shop's own
convention wins, and `backfill-variant-weight.js` reads the same attribute under the same rule.

**The rename has a precondition, and the script enforces it rather than trusting the operator.**
The label is the source of the attribute key (`generateAttrKey`), and
`CategoryService.mapRequiredAttributes` / `ProductService` recompute the key from the label on
every save — so «Вага філаменту» would become `vaha_filamentu` on the next admin save and the
catalogue filters, the landings' pinned filters, the facets and the unit join (which matches
`attributes[].k` to `required_attributes[].key`) would all stop matching. The step therefore
renames the label **only** for an entry whose stored key is exactly what `ATTR_KEY_OVERRIDES`
maps «вага філаменту» to. Without that entry it fills the units, prints the rename as waiting
together with the three tables to change, and **exits 0** — the units are not held hostage to it.

The order of the two writes is deliberate. There are no transactions here (standalone MongoDB),
so the question is which half-state a shopper may see, and products-first would leave a product
labelled «Вага філаменту» whose category still has no unit — the one combination the storefront
hides, so the row would vanish instead of improving. Categories-first leaves at worst
«Вага | 1 кг»: correct, visible, merely not yet the mock's wording.

Expect on current data: **1 unit filled** (`vaha` → «кг»); «Діаметр» and the rest listed as
skipped with their reason; the label rename reported as waiting until the override entry is
deployed. A second run prints "Nothing to do.".

**Verify:** the script's `Verify:` block is all `OK`; a product page shows the
«Вага філаменту | 1 кг» row (or «Вага | 1 кг» while the rename waits); `/filament` still filters
on `vaha`, i.e. the key did not move.

### 3k. `normalize-variant-colors.js` — the risky one

**Do not run this until steps 1 and 2 are both live in production.** It rewrites `v_value` to
the canonical English name; until the storefront renders `color` instead, the shop displays
English colour names.

```bash
node scripts/fillando_v_2/normalize-variant-colors.js --dry-run
# read scripts/fillando_v_2/reports/color-report.json, then:
node scripts/fillando_v_2/normalize-variant-colors.js
```

Expect on current data: 293 of 293 colour variants matched and 8 variants off the colour
axis. The refill is no longer skipped: step 3d moved its marker onto the product name, so its
colour resolves like any other. The two «Candy» variants resolve to «Candy» and «Rainbow Candy»
since step 3a tells them apart. **A slug collision aborts the run** rather than
half-applying it — resolve it (rename a variant, or split the dictionary entry into two
colours) and re-run. `--force` applies everything else and
leaves the collisions for later; use it deliberately, not to get past the message.

Variant **slugs change without a 301** — the owner's decision. `reports/slug-map.json` records
every old → new address and is merged across runs, never truncated, so it survives a re-run.

**Verify:** a migrated product page shows "Чорний (Black)"; the colour filter offers swatches;
`reports/color-report.json` has the unmatched list for the manual pass.

### 3l. `rename-products-short.js` — short product names, held back with 3k

**Runs after 3k, in the same window**, and only once the frontend is live: it renames every
product from the long SEO name («Філамент (пластик для 3D принтера) Kingroon PLA Silk Rainbow
1,75 мм 1 кг») to the short one the artboards draw («Kingroon PLA Silk Rainbow»), keeping the
«— Чорний (Black)» suffix 3k wrote on the variants. The short names come from the committed
dictionary `scripts/fillando_v_2/short-names.js` (draft it with `--propose`, review, commit); a
product carrying the long prefix with no entry is refused, not guessed at. Decisions the
dictionary already records: «3 кг» stays (it tells the two Kingroon PETG reels apart),
«(еко-пакування)» and «(CoPET)» stay, « (без котушки)» on the refill stays (or the refill and
its parent would share a name and their variants an address).

```bash
node scripts/fillando_v_2/rename-products-short.js --dry-run
# read scripts/fillando_v_2/reports/rename-report.json, then:
node scripts/fillando_v_2/rename-products-short.js
```

Expect on current data: 43 products planned (44 with the refill of 3d) and no collisions —
before step 3a told the two «Candy» variants apart, _Kingroon PLA Silk Rainbow_ collided on
`kingroon-pla-silk-rainbow-candy` and the run stopped on it (a new pair of that shape would do the
same; `--force` renames the rest and leaves the colliding product long). About 300 slug moves are
appended to `reports/slug-map.json`. Each product is written in three
pinned phases (park the movers on `…-moving-<id>`, rename the product, land every variant), the
way `ProductService.applyVariantRename` does; a document edited mid-run is skipped and reported,
and a re-run picks up anything left parked.

Variant **slugs change without a 301** — the owner's decision, recorded for 3k and confirmed again
on 2026-09-06 knowing that 242 indexed product addresses will answer 404 until Google recrawls.
Order items and the guest cart keep the long names by design (they are snapshots).

**Verify:** `yarn migrate:verify` prints `products still carrying the long SEO prefix: 0` and no
`-moving-` slugs; a product page reads «Kingroon PLA Silk
Rainbow — Золотий (Gold)» with the title suffixed «— філамент 1,75 мм»; the feed's `<title>` is
short; searching «філамент» still lists the category (the search falls back on the category
name).

---

## 4. After the migrations

After 3l: purge the storefront caches and resubmit the sitemap. `POST /api/revalidate
{"resource":"landings"}` with the `x-revalidate-secret` header on the frontend expires the
`landings` and `sitemap` tags. This call is not optional after 3l: the sitemap's entry list is
memoised for a day and keyed on the variant **count**, which a rename never moves, so without it
the sitemap keeps every old slug until the day is up (seen on dev, 2026-09-07: 301 old addresses
until the call, 301 new right after). Product and catalogue pages are ISR-cached for up to an
hour and simply expire — an old product address serves its cached page for that hour, then 404. Expect the 242 old addresses to show as 404 in Search
Console; that is the accepted cost.

1. Rewrite the refill product's description: 3d copies it from the parent, so it still reads as
   the spooled product. `Котушка в комплекті = Ні (рефіл)` is already set by 3d/3e.
2. Read the copy step 3h wrote, correct it in `/admin/landings`, and publish the landings one by
   one. A landing stays a draft until a person has read its text, and one that matches no
   products is never published — an empty SEO page in the index is worse than no page. After 3d
   `refill` matches its one variant, so it may be published too; `yarn migrate:verify` prints how
   many are ready.
3. Work through `color-report.json`: add a synonym to `seed-colors.js` for each spelling worth
   mapping, then re-run 3f and 3k. Both are idempotent. On dev every spelling is covered
   (293/293).
4. Resubmit the sitemap in Search Console — it now carries the legal pages, the price sheet and
   the published landings.

**Editing a migrated product is safe from here on, and this is worth knowing why.** 3k writes
`v_value` as the English `colors.name_en` but the display `name` as `"<product> — Чорний (Black)"`
— Ukrainian first, the manufacturer's own spelling in brackets.
`ProductService` builds `name` from the dictionary whenever the variant points at it and falls
back to `v_value` only for variants without a colour, so re-saving a product reproduces the name
it already had. Before that, every save regenerated the name from `v_value` and quietly renamed
the variant to English — on current data 243 of 301 variants, one admin edit at a time, visible
in the catalogue listing, the `ItemList` markup, the cart rows and the price-list PDF (where the
variant name is also the sort key). The slug is still built from `v_value`, so addresses do not
move.

Renames are handled in three parts, and only an actual change of name triggers any of them — the
admin form posts `name` on every save, so keying off its presence would re-plan on edits that
have nothing to do with it:

1. The whole batch is planned and vetted **before the first write**. Two variants of one product
   heading for the same slug get a 409 naming both SKUs, as does an address already held by
   another product. Previously the duplicate surfaced partway through `Promise.all` as an
   unhandled `E11000`, which — with no transaction available on a standalone MongoDB — left the
   product renamed and only some of its variants rewritten.
2. Slugs can **rotate** within a product: the address one variant is moving to may still belong
   to a sibling that is moving too. That is not a conflict, but it is a race, so the writes go in
   two passes — every mover is parked on a temporary `…-moving-<id>` address first, which empties
   the target range before anyone claims it.
3. Variants whose slug does not change are written once, in the second pass.

---

## 5. Rollback

| Step  | How to undo                                                                                                                                                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 2  | Redeploy the previous image. No data changed.                                                                                                                                                                                                                                 |
| 3a    | The previous values were an empty `material` and a string `category_id`; restoring them serves no purpose.                                                                                                                                                                    |
| 3b–3c | No automatic undo. The derived attributes are rebuilt from `material` on every run, so a corrected mapping table is simply re-applied; removing them entirely means a one-off script.                                                                                         |
| 3d    | Move the variant back with `$set: { product_id, v_value, name, slug }` from the first-pass archived `history/<run>/pass-1/refill-split-report.json`, then delete the product it created. Nothing else referenced it.                                                                                               |
| 3e    | No automatic undo; re-running rebuilds the attribute from the same rule.                                                                                                                                                                                                      |
| 3f    | Delete the inserted colours — the API refuses while variants reference them, which is the safety you want.                                                                                                                                                                    |
| 3g    | Delete the landings; they are drafts and invisible until published.                                                                                                                                                                                                           |
| 3h    | Clear `intro_html` / `bottom_html` / `faq` on the landings; they are still drafts, so nothing was public.                                                                                                                                                                     |
| 3j    | `reports/attribute-units-report.json` names every unit written and every label renamed. To undo a unit, `$set` that entry's `unit` back to `null`; to undo the label, `$set` it back to «Вага». The key was never touched, so nothing else has to move, and re-running rebuilds both from the same table. |
| 3k    | `v_value_legacy` holds the original spelling on every migrated variant, and `slug-map.json` holds every address change. Keep both for **one release**, then a follow-up can drop `v_value_legacy`.                                                                            |
| 3l    | `node scripts/fillando_v_2/rename-products-short.js --rollback scripts/fillando_v_2/reports/rename-journal.json` replays the report backwards — every product and variant back to its old name and slug, in the same three pinned phases. Keep the report for **one release**. |

A migration that fails verification exits non-zero and prints which check failed. None of them
writes partially on purpose: the two riskiest pin the array they read in the update filter, so a
document edited in the admin mid-run is skipped and reported rather than overwritten.

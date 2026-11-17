# Category topology preparation (TD-0013)

`modules/category/category-tree.ts` is a pure, storage-independent topology
validator/query helper. It does **not** change the current category HTTP API or
database schema. Integration into write paths waits for the mutation/recovery
contract described in the meta repository's TD-0013.

- Input is a flat list of `{ id, parent_id, kind: 'group' | 'product' }`.
- Rejects duplicate IDs, invalid nodes, missing parents, product parents and cycles.
- Traversals are iterative; there is no hard-coded hierarchy depth.
- `ancestorIds` returns root-first ancestors excluding the node.
- `productCategoryIds` returns the node itself if it accepts products, otherwise
  its product descendants; an unknown root throws rather than returning empty.
- `assertMove` checks a proposed parent without modifying the snapshot.
- The helper owns copies of records; returned arrays do not expose its internals.

Snapshot validation alone cannot protect concurrent database writes. The future
service must serialize relevant mutations, revalidate under that protection and
recover partially completed operations before exposing tree writes. Do not call
`assertMove` followed by an unguarded update and claim the tree is race-safe.

Tests: `yarn test --runInBand category-tree.spec.ts`. Includes deep (20k levels)
and wide (150k children) synthetic trees; these are not production performance
guarantees. Audit tooling is documented in `scripts/README.md`.

## V2 configuration and attribute core (local implementation)

`category-configuration.ts` validates a serialized category configuration and
provides an explicit legacy read adapter. Absent fields read as root/product/
active/contract version 1; it never writes those defaults or guesses typed
attributes from `required_attributes`. V1 ignores staged v2 definitions until
explicit activation. Groups and nested nodes require version 2; v2 requires an
explicit definitions array, including an empty array. Groups cannot own product
attribute definitions. Serialize ObjectIds before using this adapter.

`attribute-definitions.ts` defines and checks the internal v2 shape. It assigns
opaque keys on creation, preserves keys on rename, validates filter/type/unit
combinations, enum options, scalar values and single/multiple cardinality.
Strings containing commas remain one value; false and zero are valid. Required
values are checked for active products; draft values are still type-checked.
Variant-axis values are checked separately and cannot also appear in product
attributes. No color is inferred from a generic variant value.

**Variation rules (owner, 2026-11-06 — «як у бест практіс»: Magento's configurable attributes,
Akeneo's variant axes, Google's variant attributes).** Enforced in `attribute-definitions.ts`, so
every writer (create, edit, transfer, conversion, migration) obeys them:
- A variation is built only on a characteristic that `isAxisCandidate`: **required**, one value, and
  a **list, a number with its unit, yes/no or the colour** — never free text («63A» and «63 А» would
  be two variants). Anything else is `INVALID_AXIS`.
- While SKUs vary by it, it stays required: `checkDefinitionChange` refuses the change with
  `AXIS_REQUIRED` and the counts.
- **The colour is always the SKU's dictionary colour**, even on a product with one SKU; a product
  never holds a colour value of its own (`COLOR_VALUE_ON_SKU`) — such text reached neither the colour
  filter nor `g:color`. So a required colour makes the colour the variation of every product.
- A colour definition is one text value (the dictionary id), without unit or attribute filter — the
  catalogue filters it by family automatically — and a category has at most one (like the brand).
- Filters are not variations: `parseAttributeFilters` checks operands with `validateScalarValue`,
  so any characteristic, required or not, may filter and be pinned by a landing.
The filament migration makes «Колір» required; every filament product carries the colour axis.

Used type/unit/multiplicity/semantic changes, removal and used-option deletion
require an explicit migration. The caller must compute usage under the writer
lock, including active/draft products, variants and landing pins. These helpers
alone cannot prove usage or detect concurrent modifications. When requiredness,
filter configuration or options change, the future service must revalidate all
affected products/axes/pins before persistence. `validateVariantValue` checks one
SKU value; sibling uniqueness and the single-SKU no-axis rule remain service work.

These modules are not yet called by HTTP services and add no Mongo fields or
indexes. Existing CRUD, legacy keys and public responses remain as before.
Do not enable v2 categories until the journal writer, storage, adapters and new
DTOs are integrated. OpenAPI still describes the running legacy contract.

Checks: `yarn test --runInBand category-configuration.spec.ts category-tree.spec.ts
attribute-definitions.spec.ts` (41 cases). Unit checks do not establish migration,
API/DB concurrency or production readiness.

## Persistent write gate (B02 preparation)

`database/mongoose/repositories/catalog-write-gate.ts` is a Mongo persistence
primitive, not an enabled Nest provider. Its two collections use primary reads
and journal-acknowledged writes (`w:1,j:true`) on standalone MongoDB. Explicit
`initialize()` is a bootstrap operation; acquire/read never synthesize missing
control. Unique `_id` reserves each operation key before global CAS acquisition.

The caller supplies a stable request hash (including normalized payload, actor,
operation kind and target). Reusing a key with another hash is rejected. Matching
retries return `OPERATION_ALREADY_REGISTERED`; the future ADMIN service must look
up the durable operation result instead of executing it again. Rejected attempts
are also retained; a corrected request needs a fresh key. No TTL cleanup exists.

An acquired token binds operation, owner, revision and epoch. Mark domain writes
before the first possible write. Abort is permitted only before that marker;
otherwise failures retain the gate for recovery. `publishVerified` assumes the
caller has already persisted and verified its domain journal: this primitive
cannot itself prove category invariants or that domain writes used the gate.

Publication has a `published` phase: advance revision/epoch while still blocking
readers/writers, persist the operation receipt, then open the gate. A crash or
receipt conflict remains closed rather than letting a later operation erase the
publication evidence. Abort advances epoch without revision, so an in-flight
read detects even an intervening write that was cancelled. Reader APIs must use
both readStamp and assertReadUnchanged and buffer output until the second check.

Missing: journal item before/after storage, resume/rollback CLI, automatic
completion of interrupted publication, outbox/cache invalidation and integration
of all application writers/readers. A process restart does not clear the lock.
An operation stranded between key reservation and acquisition also needs explicit
reconciliation. No runtime migration or category API integration is enabled.

Integration checks (disposable localhost Mongo only):
`TEST_DATABASE_URL=mongodb://127.0.0.1:27018/fillando-test yarn test:integration catalog-write-gate.int-spec.ts`.
Nine checks cover competing writers, repeated keys, stale revisions, epoch/abort,
foreign owners, missing control, persistence across gate instances and a missing
receipt during publication. They do not simulate every process/DB crash or prove
end-to-end category recovery.

## Update journal (B02/B04 preparation)

`catalog-mutation-journal.ts` persists an immutable, bounded plan with before/after
images, then applies or reverses updates using conditional Mongo expressions.
Only allowlisted top-level catalog configuration fields can be changed. Price,
stock, order data and arbitrary collection names are excluded. It distinguishes
missing fields from explicit null; BSON images are copied and lossy serialization
is rejected. Each target occurs once per plan. Limits: 500 targets / 8 MiB.
The plan is a single atomic document; larger/chunked migrations are not implemented.

All targets are checked before each execution. A target already at the desired
image is skipped, so an interrupted domain write before its checkpoint can resume.
Those checks — before the plan is stored, before the first write and after the last
one, and `inspect` — are reads of independent documents and run `READ_BATCH` (20)
targets at a time; the error is still the one a walk in plan order would meet first.
The writes stay one target at a time in plan order: four round trips each (the gate,
the target's image, the conditional update, the checkpoint). That is what a remote
caller pays — the migration CLI from a laptop: 360 targets at 40 ms keep the
catalogue closed 72 s (115 s before the checks were batched, 2026-11-15).
A third value, missing target or different plan under the same operation fails
closed. Checkpoints are diagnostic: recovery checks actual images instead of
trusting a counter. Rollback runs in reverse order, changes only owned fields,
verifies before-images, and cannot subsequently switch back to apply.

The gate remains closed after journal execution: the coordinator must additionally
validate category/product/landing invariants and then call publishVerified or
finishRolledBack. The latter increments epoch, retains revision and persists a
rolled_back receipt. Domain exceptions never unlock via finally.

One execution coordinator owns the token; do not execute apply and rollback
concurrently or hand its token to another active process. Resuming with the same
token is only safe after the old coordinator is stopped. Ownership transfer,
recovery_required→writing, interrupted publication completion, recovery CLI,
inserts/deletes, chunked plans and outbox remain separate implementation work.
These modules are not wired into current HTTP services.

Eight journal integration cases plus nine gate cases pass on the disposable DB:
resume at write/checkpoint boundary, idempotent apply/rollback, preserve new price/
stock on rollback, missing-vs-null, divergence, missing targets, immutable plans,
unsafe fields/duplicate targets, stale ownership and lossy BSON images. The tests
construct failure-boundary states; they do not kill a DB process or establish
end-to-end migration readiness. The restored production baseline was not modified.

## Controlled ownership recovery (2026-10-24)

The internal protocol now supports `inspect → claimRecovery → adoptRecovery →
finishRecovery → execute → domain verification → publish/finishRolledBack`.
`inspect` returns counts of before/after/both/conflicting/missing targets without
exposing their values or changing data. It is diagnostic, not a database snapshot;
run it after all previous writers and in-flight commands have stopped.

`claimRecovery` requires the old token, a distinct new owner and explicit stopped-
writers confirmation. That boolean is an operator precondition, not automatic
process fencing: the coordinator must actually stop/isolate the previous process.
CAS accepts writing/recovery_required and enters recovering with epoch+1, keeping
all readers/writers closed. Same-owner retries of an interrupted claim are allowed;
a different recovery owner cannot claim it. Old tokens fail subsequent gate checks.

`adoptRecovery` rejects conflicts/missing documents and atomically changes only
the journal token; before/after images and rollback direction remain intact.
Repeating adoption is safe. `finishRecovery` updates the operation owner, then
moves recovering→writing (not idle). Recovery can then resume the saved direction
or select rollback. Only a single recovery coordinator may execute a token.

A crash during adoption can retry the same old/new owner pair. If the recovery
process itself must be replaced, or the gate is already published, automated
reconciliation is not yet implemented: do not manually clear the control record.
The CLI/runbook still needs persistent recovery-attempt identity and domain checks.
No HTTP/production integration is enabled.

21 integration checks pass (9 gate + 12 journal/recovery), including owner handover,
restart between claim and adoption, repeated adoption, stale token rejection,
concurrent competing owners, divergence and rollback preserving changed stock.
They construct failure-boundary states and do not prove recovery after arbitrary
MongoDB/process failure.

## Publication reconciliation (2026-10-24)

Publication now atomically records its explicit outcome (completed/aborted/
rolled_back) in control alongside the epoch/revision transition. The receipt
stores the publication token. `recoverPublication(token, writersStopped)` completes
bookkeeping for a published operation without reapplying data or incrementing
revision/epoch again. Matching receipt writes are idempotent; contradictory or
missing receipts/outcomes are not reconstructed by guessing.

A retry after completion verifies the durable receipt and does not touch control,
including when another writer has acquired it. Recovery requires stopped/isolated
previous writers; that remains an operator prerequisite, not a timer-based lease.
The method assumes domain verification preceded the original publication CAS.
It does not make unverified domain data publishable. Old pre-outcome published
records remain ambiguous and fail closed. No automatic migration of such records.

27 integration checks pass (15 gate + 12 journal/recovery). Six new cases cover
all three outcomes, both sides of receipt persistence, repeated completion after
a subsequent writer, ambiguous metadata, contradictory receipts and ongoing writes.
Recovery CLI, replacement of a recovering owner, domain service integration,
outbox and end-to-end migration are still outstanding.

## Read API and local staging (2026-10-24)

`GET /categories/tree` returns public active branches; `GET /categories/admin/tree`
requires ADMIN and includes hidden nodes. Both return `{revision, items, next_cursor}`,
limit 1–1000 (default 200), sorted by ID. Cursor binds audience, revision/epoch and
snapshot hash; restart pagination on 409. Invalid cursor: 400; corrupt topology,
active mutation or missing control for a v2/nested tree: 503. Legacy flat roots
can be read without control. This does not enable topology writes through legacy CRUD.

`Category.presentation` (display rules of the product card) was retired on 2026-11-05 — see
«Product data, not category rules» below. Older documents may still store it; nothing reads it,
product detail sends no `category_presentation`, the staging planner no longer stages it.

`scripts/catalog-stage.cjs` supports dry-run/apply/inspect/resume/rollback
on localhost:27019 and `fillando_rehearsal_work_YYYYMMDD` only. Writes require
`--writers-stopped`; the operator must actually isolate all writers. Plans preserve
legacy fields and add definitions/attributes_v2 with contract version 1. Verification
hashes all non-internal collections excluding only the explicitly staged fields.
Published changes are undone with a new compensating operation, not history rewrite.
The baseline backup is never targeted. Limits: 500 targets/8 MiB, update-only;
no v2 activation, production support or automatic process fencing. Recovery without
a persisted journal plan fails closed and requires operator investigation.

`GET /categories/children?parent_id=...` returns visible direct children ordered by
(order, ID); omit parent for roots. Its cursor also binds parent/scope. A hidden or
absent parent is 404; reusing a tree/other-parent cursor is 400.

`modules/catalog-routes/catalog-route-plan.ts` normalises paths (`normalizeCatalogPath`) and
lists the storefront's reserved first segments (`RESERVED_ROOTS`, `reservedCategorySlug`).
(Superseded: its early preflight planner/resolver over a `/catalog/...` canonical namespace was
never wired and was removed in the 31.10 audit; the registry, resolution and redirects are
`catalog-route-writer.ts` and `GET /routes/resolve` — `CATALOG_ROUTES.md`.) Backup inventory:
316 canonical + 15 aliases, no collisions.

## Internal create/move coordinator (2026-10-24)

`CategoryTreeWriter` is not registered in Nest or exposed over HTTP yet. It requires
an explicitly initialized gate and builds each plan under ownership. Creation writes
a draft v2 node after definitions/parent/identity validation; move requires an existing
v2 node and changes only parent/order. There is no fixed depth. Invalid domain plans
abort before writes. A failure after execution starts leaves the gate closed for
operator recovery. Completed request replay returns the saved operation revision;
request hash includes command and expected_revision, but not owner identity.

`CatalogMutationJournal` additionally accepts category creation with an absent
before-image and full BSON after-image. Update patches remain field-scoped. Creation
rollback verifies the whole document and checks children, products, variants, landings,
catalog_routes and storefront_settings references before conditional deletion.
Composite plans roll back in reverse order. No lifecycle insert of products/orders
or deletion of pre-existing categories is supported. Keep all writers isolated during
recovery; these checks do not fence an uncooperative external process.

Integration suite `category-tree-writer.int-spec.ts` covers an eight-level tree,
URL-preserving moves, cycles/product parents, competing moves, legacy rejection,
idempotent result replay and failure after insert before publication. Existing
staging CLI does not operate these tree plans. HTTP registration waits for the writer
inventory/read barrier and visibility/cache publication work in TD-0013.

## Legacy HTTP write interlock (2026-10-24)

AppModule registers LegacyCatalogWriteInterceptor globally, scoped by controller
metadata to Category/Product/Color/Landing controllers. All unsafe methods are
blocked after catalog control initialization, including idle phase, with 503
`details.code=CATALOG_LEGACY_WRITES_DISABLED`. Product validation and PDF generation
are explicitly read-only POST exceptions. Existing JWT/RBAC run first. GETs are
unchanged; this is not a public read barrier. Manual promotion/images/stock writes
on these controllers are conservatively blocked too; background services are not
intercepted.

Without control only original flat active v1 categories permit legacy HTTP writes;
incompatible data returns 503 `CATALOG_CONTROL_MISSING`. No automatic control
initialization, deletion or retry occurs. Bootstrap still requires stopped/isolated
writers and drained requests: a preflight check cannot fence a request already in
flight, direct DB/service calls or old processes. Local additive staging initializes
control and therefore also disables old HTTP writes, even before v2 activation.
Do not remove control to re-enable them. New gated write APIs and the corresponding
admin UI remain release prerequisites; this interlock alone is not a rollout.

## Legacy HTTP read barrier (2026-10-24)

The same interceptor now brackets GET/HEAD and read-only POST handlers with
primary control reads. A valid idle phase, unchanged revision/epoch and unchanged
control existence are required before returning data. Maintenance/malformed counters
produce 503 CATALOG_MAINTENANCE; a changed stamp produces CATALOG_READ_CHANGED.
Errors include Retry-After: 5 and Cache-Control: no-store; no internal retry.

Legacy HTTP projections remain v1-only until their adapters are implemented.
V2/group/nested/hidden categories fail closed with CATALOG_READ_UPGRADE_REQUIRED
(or CATALOG_CONTROL_MISSING without control), rather than exposing a draft through
old category/product reads. Stable idle v1 and pre-bootstrap flat active v1 work.
New tree/children routes retain their independent visibility-aware read service.

Product PDF generation now returns StreamableFile. The interceptor verifies the
stamp before Nest sends the completed buffer or its download headers. Direct
response writes would bypass this guarantee and must not be added to these handlers.
This updates the previous section's GET/read-only exceptions: they bypass the write
interlock but must satisfy the read barrier. Background exports, checkout, partner
API and direct service calls still need integration before v2 activation.

## Спільний sitemap export (локально, 24.10.2026)

GET /catalog/sitemap повертає {initialized, revision, epoch, variants, categories,
landings}. Усі три набори читаються під одним legacy read stamp до/після queries,
із primary. SKU лише active; landings лише active з існуючою категорією. Поля
обмежені slug/category_slug/updatedAt, немає приватних category/product полів.
Busy, changed stamp або несумісний v2 — 503, не частковий набір. Справді порожній
legacy каталог повертає три явні порожні arrays. Cache-Control: no-store.

Frontend робить один запит до цього endpoint замість незалежних slug/category/
landing reads. Валідатор відкидає null/404, відсутню array, неправильну дату чи
небезпечний slug: помилка не стає статичним sitemap без товарів. Реальні updatedAt
використовуються для lastModified; при відсутності дати поле пропущене, замість
поточного часу генерації. Legacy URLs зберігаються до redirect-backed migration.

Один щоденний unstable_cache artifact з tags SITEMAP/PRODUCTS/CATEGORIES замінює
count-key і другий force-static route cache. Route force-dynamic, тому live API
не потрібне під час build; готовий artifact кешується на рівні даних. Старий
перевірений artifact може залишатися доступним при невдалій регенерації; cold
metadata-route failure не обіцяє спеціального HTTP 503 mapper. Для visibility
release потрібні purge ACK; це не реалізовано цим пакетом.

Порядок deploy: backend endpoint → frontend. Немає fallback на три незалежні
джерела. Оновлення 29.10: export розбито на індекс і частини (≤ 50 000 URL і ≤ 2 MiB
кожна, одна ревізія на весь обхід) — розділ «Large catalogue II» нижче.

## Opt-in draft placement HTTP (2026-10-25)

PATCH /categories/:id/draft-placement is ADMIN-only. Required UUID Idempotency-Key,
body {parent_id: ObjectId|null, order: nonnegative safe integer, expected_revision}.
Response {operation_id, revision, category_id} is the durable operation receipt;
a replay returns the original revision without reapplying. No name/slug changes.

Disabled by default: catalog_control must already exist with
admin_draft_writes_enabled=true. HTTP does not bootstrap/toggle control. The flag
is rechecked inside writer ownership. Enable only in an isolated, prepared rehearsal
environment with old writers stopped; existing v2 read/export adapters are incomplete
and this flag is not production activation. Disabling it also refuses HTTP replays.

Only a draft category with no active/archived descendants can move. V1 is rejected.
The existing journal validates topology, preserves ownership, verifies after-images
and publishes before responding. Known topology/revision/key conflicts return 409;
missing target/parent 404; invalid inputs 400; disabled/busy 503. Unclassified failure
returns 503 CATALOG_OPERATION_REQUIRES_INSPECTION with operation_id, no raw internal
error. After execution begins the gate stays closed; the same unfinished key gets
409 OPERATION_ALREADY_REGISTERED. Never automatically retry under a fresh key.

Operation-status UI, general create/update/visibility APIs and automatic recovery
are still pending. Keep the UUID for operator inspection/recovery. Public legacy
writers stay interlocked; this dedicated controller does not bypass the journal.

### ADMIN operation status (25.10.2026)

GET /catalog-operations/:UUID тепер повертає тільки {operation_id, status,
result_revision, error_code}, без owner/hash/token/journal images. Доступ ADMIN,
Cache-Control: no-store, невідомий key — 404. Працює і при вимкненому draft flag
та закритому gate: діагностика не є public catalog read.

Status pending означає незавершений receipt; він не відрізняє живий writer від
процесу після збою. Recovery_required відображає явний recovering/recovery_required
control для цієї операції. Completed/rejected/aborted/rolled_back беруться з receipt.
Жодних takeover, retries або зміни control цей GET не виконує. State є діагностикою
на момент запиту, не обіцянкою, що pending завершиться самостійно. Operation-status
UI ще попереду; operator recovery — `scripts/catalog-recover.cjs` (аудит 31.10, нижче).


### Draft workspace, implemented locally — 2026-10-25

- POST `/categories/drafts`: ADMIN; body `name, slug, kind, parent_id, order, expected_revision`; required UUID Idempotency-Key; 201 receipt. Definitions start empty, status always draft. ID derives deterministically from the UUID; identical replay returns the same category.
- PATCH `/categories/:id/draft-details`: ADMIN; `name, expected_revision`; 200 receipt. v2 draft only; slug, kind and visibility remain unchanged. Names must be unique.
- GET `/categories/admin/capabilities`: ADMIN, no-store; `{draft_writes_enabled, legacy_writes_enabled}`. Advisory UI state, not permission to bypass the gate. Missing control does not initialize it.
- Existing draft-placement and operation status are now consumed by the admin workspace. Admin tree items additionally expose `attribute_contract_version` (1 or 2); public shape unchanged.

All HTTP writes check `admin_draft_writes_enabled` before acquisition and again under
the gate. The flag remains disabled by default; it must only be enabled in an isolated
prepared rehearsal while legacy writers are stopped. A v2 draft still causes the legacy
storefront adapters to fail closed; this block is **not** permission to enable it on prod.
Rename journals only `name`, preserving slug and all unrelated category data. The new
editor has no publication, deletion, conversion or image writes. Attribute-definition
writes and ADMIN filter checks were added in the next block described below; public
storefront filters are not enabled by draft creation.

Frontend must follow deployment of these backend endpoints. For a browser rehearsal,
start disposable Mongo on 27018 and run from the sibling frontend checkout:
`yarn test:e2e --config playwright.categories.config.ts`. The backend fixture uses the
real controllers, service, journal and Mongo in `fillando-test-category-workspace-browser`,
with role-header authentication, loopback-only HTTP and a fixed local CORS origin.
It never connects to DATABASE_URL or to the restored production dump.


## Typed definitions and filter preview — 2026-10-25

GET `/categories/:id/admin/configuration` is ADMIN/no-store and returns one verified
revision: category_id/kind/status/definitions plus controls.fields/filters/specs/variant_axes.
Legacy v1 is not inferred from labels; 409 upgrade required. Missing/busy control or
a read that changed mid-flight returns 503.

PATCH `/categories/:id/draft-definitions` replaces up to 100 definitions, each with up
to 200 options. Required expected_revision and UUID Idempotency-Key; rollout flag
checked before acquisition and under the gate. Existing key/option IDs must belong
to the category/definition. Additions omit identities; server derives them from operation
UUID + position, making retries deterministic. Changing label never changes the key.
The journal patches only attribute_definitions; URLs, legacy attributes and unrelated
metadata remain intact. Active/v1/group writes are rejected. Invalid types/operators/
foreign IDs are 400; dependency/revision conflicts 409; disabled/busy/recovery 503.

*(Superseded 2026-10-29: the exact per-key usage below — «Editing published categories».)*
Until typed product/landing writers land, ANY referenced product/SKU/landing marks
the category in use. Existing definitions/options cannot be removed, nor type/unit/
multiple/semantic/required/filter behavior changed; labels/order/spec visibility and
optional additions are allowed. This conservative check protects pins too, but can
block removal of an actually unused key; exact per-key dependency resolution is pending.
Copy reads the source configuration, strips all key/option IDs and saves independently
under the target's expected revision. It does not link categories or modify the source.

POST `/categories/:id/admin/filter-preview` is a read-only ADMIN/no-store endpoint
(200). Body `{attributes:[{key,values:[scalar]}|{key,min?,max?}]}`; limits 50 dimensions,
100 values per dimension, 16 KiB JSON. Only enabled category attributes; no price,
brand, stock, group/global or pinned-filter contract yet. Empty selections are removed.
Booleans/numbers remain typed; comma-containing strings remain single values. OR
inside values, AND between keys; range bounds inclusive. Filtered SKU counts and
self-excluding facet counts operate on the same row and never cross-match sibling SKU.
The engine indexes each row once and tracks failed dimensions, avoiding a full filter
re-evaluation per facet. This is not the future paginated Mongo aggregation public API.

Preview reads at most 5 001 products / 20 001 SKU to enforce bounds of 5 000/20 000
without returning partial success. Only active/draft SKU of the selected product
category; archived SKU excluded. Product attributes_v2 and axis/variant_value are
validated; absent/malformed typed data returns 503 CATALOG_PREVIEW_DATA_UNAVAILABLE.
Over-limit returns 400 PREVIEW_LIMIT_EXCEEDED. A gate stamp brackets the entire
read/compute; configuration must have the same revision. Response contains revision,
category_id, total_variants, total_products, <=50 sample_variant_ids and attribute facets.
The endpoint never writes, publishes, initializes control or enables draft writes.

The browser rehearsal now seeds a disposable typed AVR category with 16/32/63 A SKU,
a boolean field and an enum. It verifies numeric + false filtering, self-excluding
range, copy to an empty draft with new keys/option IDs, persistence after reload,
and the earlier category-move/acknowledgement-loss scenario. Auth remains a fixture.

## Typed product draft editing (local, opt-in)

The separate `TypedProductController` exposes ADMIN/no-store
`GET /products/admin/typed-drafts?category_id=...&cursor=...` (25 rows; cursor
bound to category, revision and epoch; or `page=N` — the products screen numbers its pages, owner
2026-11-03 — with `total` in every answer; `q` narrows by name over the whole category, literally and
case-insensitively, so a search on page 1 finds a product on page 3; `typed-product.int-spec.ts`) and GET/PATCH
`/products/:id/admin/typed-draft`. It does not inherit the legacy controller's
interceptor. Reads use the shared gate stamp; writes require the existing
`admin_draft_writes_enabled` flag and journal, without bootstrapping control.

PATCH requires a UUID `Idempotency-Key`, expected_revision and the complete
editable payload: name, attributes_v2, variant_axis, variants[{id,variant_value}].
Runtime validation uses a strict Zod object on the raw body, so global DTO
whitelisting cannot silently strip unknown fields. There is no numeric/boolean
coercion. Category must be a v2 product draft, all existing SKU must be draft,
1–100 siblings and exactly the same IDs. No-axis means one null-valued SKU;
axis values must be unique, typed and present. Required non-axis attributes
may be absent in a draft. Existing v2 data must already be prepared; color_id
requires a future explicit dictionary adapter and returns 409 meanwhile.

The journal allowlist now also permits product/variant `name`. Product edits
patch only name/attributes_v2/variant_axis and variant name/variant_value;
commerce, timestamps, images, SKU and slug are never included in these patches.
Names append enum display labels, numbers plus units, Так/Ні, or string text.
Rollback preserves concurrent price/stock writes. Failures after execution keep
the gate closed for explicit recovery. Completed replay returns one receipt.
PATCH does not change membership or publish products. Creation is a separate operation below; public v2 consumers remain pending.

### Product data, not category rules (owner, 2026-11-05)

What belongs to a product lives in the product; the category is navigation, the Google category and
the list of characteristics. No rule of the category writes or decides a product's name, notice or
brand, and no shared code knows filament keys for v2.

- **Name.** The page prints the product name as written, then the variation (`<title>` of a v1 page
  keeps the category name before the variation until the last v1 category is migrated). The category
  name suffix (`presentation.product_name_suffix`) is gone. «Філамент (пластик для 3D-друку)» is
  written into each filament product and SKU name once, by the migration (`product_name_addition`:
  «Kingroon PLA — Філамент (пластик для 3D-друку) — Чорний (Black)»; a SKU name that is not
  «product — variation» stops the plan, `VARIANT_NAME_NOT_PRODUCT_NAME`).
- **Purchase notice.** `products.purchase_notice: {title, text, badge|null} | null` — the warning above
  «В кошик» and the text on the photo, of this product only. Edited with the typed product's details
  (`details.purchase_notice`: omitted keeps it, `null` clears; plain text; title ≤120, text ≤1000,
  badge ≤40; journal profile `draft-product-details`); the v2 page answers it as `attribute_notice`.
  The migration writes it onto the products the mapping's `product_notices` match (the refill).
  The category value notices (`presentation.attribute_notes`) and «Помітні значення»
  (`emphasised_values`) are gone.
- **One order, one visibility switch.** The table on the page is the definitions in their `order`,
  without those with `visible_in_specs: false`. `visible_in_specs` decides the page's table only: the
  partner API, the price sheet and the PDF export every characteristic, as they always exported
  «Матеріал» and «Виробник» (there is no «internal note» characteristic any more). The category's
  `spec_order` / `hidden_spec_keys` and the per-key usage `settings` are gone; the migration sets
  `order` (`definition_order`) and `visible_in_specs` (`hidden_keys`) instead. The same order places
  the storefront's colour filter (owner, 2026-11-07: one order for the table, the filters and the price
  lists); the filament mapping puts «Колір» first.
- **Brand and material are marked, never guessed.** `semantic: 'brand'` (at most one per category,
  text or enum) is where a product without a brand entity takes its brand — page `manufacturer`,
  `g:brand`, price sheet, PDF, and hidden from the table or not; `semantic: 'material'` gives the
  page's JSON-LD `material` and `g:material`. No v2 path matches «Виробник» or reads `polymer`. The
  filament migration marks `vyrobnyk` brand and `polymer` material (`semantics`).
- **Feed.** `title` is the SKU name; v2 highlights are the table's characteristics — `MERCHANT_FEED.md`.
- **Removed characteristics.** The mapping's `removed_keys` are not carried over at all — no
  definition, no value on any product; the report counts `removed_attributes`, a misspelt key stops
  the plan (`MAPPING_UNKNOWN_KEY`). Filament: the free-text «Матеріал» (`material`, «PLA Silk
  Rainbow») repeated «Тип пластику», «Ефект», «Армування» and «Серія» (owner, 2026-11-06); its values
  stay in the legacy `attributes` only, and the partner card's «Колір» row keeps its place after the
  nearest earlier row the card still has (`withAxisColourRow`).
- **Price lists by category** (owner, 2026-11-06): the public price sheet and the admin PDF show each
  category with the columns `priceColumnsOf` gives — the definitions with a filter and the colour —
  `PRICE_SHEET.md`, `PRICE_LIST_PDF.md`.
- **Merged values.** The mapping's `value_aliases` (`{ key: { from: to } }`) merge two spellings of
  one property on products and landing pins — filament `finish`: «Glow» → «Luminous» (owner, 2026-11-05:
  Bambu Lab, the only «Glow», will not be supplied again). Legacy `attributes` keep the old value as
  the rollback image; the report counts `merged_values`.
- **Value labels are category data.** `enum_labels` (`{ key: { value: label } }`) turn filament's
  `polymer`, `finish`, `reinforcement`, `series` into enums: every value a product holds or a landing
  pins becomes an option, id = the stored value (products, pins, facets keep it), label from the
  mapping («Шовковий (Silk)», «Вуглеволокно (CF)», «TPU (Flex)») or the value itself; options by value.
  These labels were the v1 storefront's `filter-labels.ts`; v2 filters, the page's table, the partner
  export and `g:material` print them (owner, 2026-11-05). A number key refuses (`ENUM_REQUIRES_TEXT`).
- **One colour.** A product with one SKU that never got a dictionary colour takes its colour-axis value
  from its product «Колір» (`single_sku_color_key: kolir`, matched by `name_uk`/`name_en`, `color_aliases`
  where they differ — «Матова веселка» → Rainbow; no single match stops the plan,
  `COLOR_NOT_IN_DICTIONARY`). The SKU gets `variant_value` and the legacy `color_id`/`color_family`/
  `v_value` (only where they were empty), its name ends with the colour, and a dropped key no product
  keeps is not created as a definition — so filament has one «Колір», the axis (owner, 2026-11-05;
  dump 02.11: 5 SKUs, `colored_skus` in the report). A single SKU with no colour anywhere takes the one
  the owner named in `sku_colors` (SKU code → dictionary `name_uk`/`name_en`, winning over the
  product «Колір»; a code that is not a single colourless SKU of the category stops the plan,
  `MAPPING_UNKNOWN_SKU` / `SKU_COLOR_NOT_APPLICABLE`): FL-000224 «Натуральне дерево (Natural Wood)»,
  FL-000180 and FL-000248 «Чорний (Black)» (owner, 2026-11-06) — every filament product then has the
  colour axis (backup 05.11: 8 `colored_skus`, 0 products without an axis).


## Typed product creation (2026-10-26, local opt-in)

`POST /products/admin/typed-drafts` uses the same ADMIN guard, explicit write flag,
UUID Idempotency-Key, expected_revision, no-store response and strict raw-body Zod
validation as editing. Body: category_id, vendor_id, name, attributes_v2,
variant_axis and variants[{variant_value,price,stock}]. Category must be a v2
product draft and vendor must exist. 1–100 variants, unique typed axis values;
no axis requires one null value. Required non-axis fields may be absent in drafts.
Finite nonnegative price ≤ 1e9 and nonnegative safe integer stock are required.
A created variant is a draft unless `status: 'active'` is sent; publication is separate.

**A whole product at creation; a draft unless complete (owner, 2026-11-15).** The body may also
carry what the edit screen has: `description` (`{html, json}`, sanitised and stored as a details
save stores it; omitted or `null` — none), `purchase_notice` (the details schema's; omitted or
`null` — none) and per variant `weight_g` (positive integer grams or `null`; omitted — unknown)
beside `images`. `status` defaults to `draft` in a published category too (it was `active` there
since 27.10). A variant may be sent `active` only in a published category and only when the
product is complete by `productReadiness` — the rule publication and the editor's readiness
panel use: a description, every required characteristic, and for each variant going active a
positive price, a valid stock and a photo; an unknown weight stays a warning. Otherwise
`409 PRODUCT_NOT_READY` with `details.issues` (`[{code, field, variant_id?}]`), before any SKU
number is reserved; nothing is written. A missing required characteristic of an active product
is reported there (`REQUIRED_ATTRIBUTE`), no longer as a separate `400 REQUIRED_VALUE`.

**Photos at creation (owner, 2026-11-15).** A variant may carry `images` — the same rule a details
save applies (`imagesSchema` in `typed-product.ts`: public http(s) URLs ≤ 2048 characters, at most
30, in display order; the host is not checked, as in a details save). Omitted is `[]`. The form
uploads first through the ordinary presign → PUT → confirm flow and sends the public URLs; the
product does not exist yet, so the files go under `products/<an id the form generates>/…` — a
SKU stores full URLs, uploads are deleted by key, and nothing reads the folder name as a product
id. The photos are part of the command's hash: a repeat of the same operation with the same
photos answers the first receipt, other photos under the same key are `409 IDEMPOTENCY_KEY_REUSED`.

Product and variant IDs derive deterministically from the operation UUID. The
existing singleton `numbers.sku` counter is atomically reserved once; it must
already be valid. Counter reservations are never rolled back: gaps are allowed,
reusing reserved numbers is not. Unique nonpartial indexes on variant SKU and
slug are required before creating. The endpoint does not initialize the counter
or indexes. Missing preparation returns a conflict and leaves no product.

Slugs are generated once from base name plus typed variant display name, without
category presentation copy. Existing variant slugs and catalog_routes paths are
reserved; collision adds the allocated SKU, and another conflict fails closed.
Existing URLs are not regenerated by creation or subsequent name edits.

Journal creation supports products/product_variants: preflight all targets,
insert product then variants, verify all images, publish receipt. Completed
replay returns the same product ID/revision without reserving more SKUs.
Failure after execution retains the closed gate for explicit recovery. Rollback
removes variants before product and requires exact created images. A later
price/stock change or known cart/order/route reference prevents removal;
recovery must resolve that conflict instead of deleting someone else's work.
Counter reservation remains consumed even after successful rollback.

Verification: 14 creation integration cases plus 100 related integration tests;
40 admin component/schema tests and 4 real API/Mongo browser scenarios. Browser
creation covers lost response recovery, generated URLs/SKU and mobile layout.
No production migration or storefront publication is implied by these checks.


### Draft details editing (2026-10-26, local)

GET typed-draft now returns `details`: snapshot token, description (HTML/JSON or
null), variants[{id,price,stock,weight_g,images}]. PATCH accepts the optional same
object. Creation excludes details except each SKU's photos (above); for the rest first create
the product, then open its details.
The rich-text/media/commerce section saves separately from typed attributes.
Existing typed-only requests still preserve all detail fields.

The token hashes the raw description and each variant's media/commerce fields
and price/stock timestamps. Stale details return 409 PRODUCT_DETAILS_CHANGED;
reload the tree and reopen the product before trying again. This complements
the catalog revision, since commerce may change without a catalog revision.
Membership must match exactly. Price is finite ≥0 and ≤1e9, stock is a safe
nonnegative integer, weight is null (unknown) or a positive integer ≤1e9 grams.
Images are ordered HTTP(S) URLs, max 30 per variant. Description HTML is sanitized
with the existing server helper. HTML and JSON are each bounded to 100k characters.

Only changed detail fields enter journal patches; the explicit
`draft-product-details` journal profile permits these fields while the default
profile continues rejecting commerce writes. Changed price/stock get their own
timestamps. Before/after-image comparisons refuse overwriting concurrent changes,
including during rollback. IDs, SKU, slug and promotion fields remain unchanged.

The UI reuses DescriptionBlock and ImageDropzone: first image is primary,
dragging changes order, removing detaches the URL without deleting storage files.
Existing presign/PUT/confirm upload runs before the mutation; any upload failure
blocks the mutation. Successfully uploaded items stay reusable on retry; uploads
that never become attached may leave unattached storage files; this change does not automatically delete them.
External S3 upload itself is not part of the isolated Mongo/browser acceptance.
Publication and adding/archiving already saved variants remain separate work.

## Typed draft SKU lifecycle and readiness (2026-10-27)

The existing typed PATCH accepts optional `variant_action`:
`add` (variant_value, price, stock, weight_g), `archive` (id), or `restore` (id).
The regular variants array still names exactly the existing siblings. Create does
not accept this action. Read/edit accepts draft and archived siblings, but refuses
active or legacy color-linked products. Unique axis values include archived SKU.
A product may have all siblings archived and remain readable/restorable.

Add uses deterministic operation-derived ObjectId and the shared identity allocator
with typed creation: monotonic FL counter, required unique indexes, reserved routes,
slug from base name + variant once. Counter gaps after rollback are intentional.
Archive/restore is a status-only journal change; identity, commerce and references
remain intact. Restore targets draft. Wrong current status yields 409
VARIANT_STATUS_CONFLICT. All operations use the existing gate, journal, durable
receipt and exact request replay. The details journal profile additionally permits
status; default profile remains restrictive. Interrupted additions roll back only
the inserted SKU when its before/after reference checks permit safe rollback.

GET includes `readiness` with data_ready/issues/warnings. Required attributes,
nonempty sanitized description, at least one draft SKU, positive finite price,
nonnegative integer stock and an HTTP(S) image are checked. Unknown shipping weight
is a warning. Archived SKU do not affect data completeness; false/zero attributes
are present values. The report does not publish data or certify Google compliance.

## Public category and catalog readers (2026-10-27)

CategoryService public reads delegate to CategoryPublicReadService: explicit
allowlist, visible ancestor chain, revision, ancestors, typed definitions and SEO.
The old category list shape stays an array of product nodes; group details use
ID/slug. Legacy fields are preserved; v2 never fabricates required_attributes.
Only adapted GET handlers bypass the old shape check. Missing control for nonlegacy
data, maintenance and changed revision/epoch still fail closed, with HTTP retry/no-store.

PublicCatalogController registers GET /products/catalog/v2 before wildcard product
routes. Strict JSON filter query; category/group/global scope; active SKU only,
matching product/category IDs; Mongo aggregation combines product typed values with
that exact SKU's axis value. Facets exclude their own dimension and deduplicate
SKU/value pairs. Promotions use the shared price expressions. All output is an
allowlist, including nested attribute entries. Sort ties use _id; limit <= 100;
query max 16 KiB; aggregate maxTimeMS 15000. No unbounded in-process SKU loading.

Local attributes require a v2 product category. Color-family filters are explicitly
unavailable until the dictionary adapter. Brand facets read active brand documents,
not vendors; CRUD/migration remains separate. Large data acceptance and frontend
consumers remain pending. Existing product/feed/checkout barriers are not lifted.
Tests: category-public-read.int-spec.ts, public-catalog.int-spec.ts and
legacy-catalog-write.int-spec.ts; real Mongo and anonymous HTTP contract are covered.

## Storefront adapters and publication (2026-10-27, local)

Adapted readers (`@CatalogAdaptedRead`) now resolve visibility through
`CategoryPublicReadService` — an active product category whose every ancestor is
active — instead of failing on any v2/draft row. Revision/epoch and maintenance
checks stay before and after each read; unadapted handlers keep the old barrier.

| Read | Rule |
|---|---|
| `GET /products/by-slug/:slug` (`PublicProductService`) | 404 unless the SKU's category is public. v1 keeps its payload; v2 answers the same shape with specs formatted from definitions (enum label, Так/Ні, unit separate), `v_value` = axis label with unit, `color: null`, `manufacturer` from an active brand entity, `category_presentation` without any name suffix. Both add root-first `category_path`. |
| `GET /products/catalog` (legacy) | Only a visible **v1 product** category; v2 → 409 `ATTRIBUTE_CONTRACT_UPGRADE_REQUIRED`; group/hidden/unknown id → 404 `CATEGORY_NOT_FOUND` (an unknown id used to answer an empty catalogue). |
| `GET /products/search` | Results restricted to visible categories of both contracts. |
| `GET /landings`, `/landings/slugs`, `/landings/slug/:c/:l` | Landings of visible v1 categories only; typed landings are not implemented. |
| `GET /colors`, `/colors/:id` | Dictionary is tree-independent. |
| `GET /catalog/sitemap` (index) + `GET /catalog/sitemap/part` | SKUs of visible product categories; categories/groups with ≥1 active SKU below them (known empty listings stay out); landings of visible v1 categories. Split into parts since 29.10 (see «Large catalogue II»). |
| Checkout (`OrderService.loadOrderableVariants`) | Adapted read; an active SKU of a hidden branch is refused as `VARIANT_UNAVAILABLE` before any number/coupon/order write. |
| Feed (`FeedService`) | Adapted read; only SKUs of public categories; v2 rows go through `feed-typed-adapter.ts` (typed specs, axis label, no colour, brand from the active brand entity — without one the builder excludes the SKU as `missing_brand`). |

`POST /categories/:id/admin/publication` (ADMIN, `Idempotency-Key` UUID,
`{action: publish|unpublish, expected_revision}`) is `CategoryPublicationWriter`: the
same gate, journal (profile `publication`, `status` field only) and replay as the tree
writers, behind `admin_draft_writes_enabled`. Publish needs a public parent (or root);
for a product category the draft SKUs of products passing `productReadiness` become
active in the same plan, the rest stay drafts and are listed in `skipped_products`.
Unpublish needs no active children and returns active SKUs to draft. Archived SKUs,
slugs, SKU codes and prices are untouched. Categories/products storefront caches are
revalidated after success. Tests: `category-publication.int-spec.ts`,
`public-storefront.int-spec.ts`, `catalog-sitemap.int-spec.ts`,
`catalog-checkout.int-spec.ts`, `catalog-exports.int-spec.ts`.

## Colour axis, typed landings and the v1→v2 migration (2026-10-27, local)

- **Colour axis** — a definition with `semantic: 'color'` (string, filter disabled). The
  SKU's `variant_value` is the dictionary `colors._id` as a string; `color_id`/`color_family`
  stay on the SKU. `GET /products/catalog/v2` accepts `color_families` only in a product
  category with such an axis (unknown family → 400 `INVALID_COLOR_FILTER`), returns
  `facets.colors` (`family`, self-excluding `count`, swatch `hex_stops` of the family's
  lowest-`order` colour — the legacy rule) and a `color` object on each item. The product
  page keeps the legacy colour object and `v_value` (swatches, «Чорний (Black)») and prints
  the axis row from the dictionary, never the id; the feed adapter does the same.
- **Manufacturer**: a linked brand entity if any, otherwise the characteristic marked
  `semantic: brand` (filament keeps `vyrobnyk` as a characteristic, owner 2026-10-27; marked brand
  by the migration, 2026-11-05).
- **v2 product page** reads the definitions (order, `visible_in_specs`) and the product's own
  `purchase_notice` — no category presentation (2026-11-05).
- **Typed landings** — `filters_v2` (catalogue filters object) + `contract_version: 2` on
  the landing (schema fields, legacy `filters` kept). Under a v2 category a landing is
  public only with them (list, slugs, detail, sitemap, feed `product_type`).
- **Price sheet** (`GET /products/price-sheet`) is an adapted read over visible categories.
- **Migration** — `buildV2MigrationPlan` (`catalog-v2-migration.ts`, unit-tested) +
  `scripts/catalog-v2-migrate.cjs`. One category per run, additive v2 fields only, stops on
  anything the explicit mapping does not cover (mixed axis, unknown brand, non-numeric
  number key, landing key that is not a filter, existing different v2 value). A product-level
  copy of the axis is dropped only on products with an axis; without an axis it is kept.
- Published (active) v2 products are not editable by the typed draft editor yet, and the
  legacy admin is fenced after bootstrap: «active edits» is the next writer to build.

## Editing published products (2026-10-27, local; owner decisions)

`GET/PATCH /products/:id/admin/typed-draft` and the typed list/create now also accept a
**published** (active) v2 product category; an archived one is refused. The read adds
`published` and `color_axis`; SKU `status` may be `active`.

- Names, description, photos, prices/stock/weight (as before; Prom sync still owns price),
  characteristics and axis values are editable. A published product must keep every
  required characteristic (`validateAttributes(active: true)`), a draft may be incomplete.
- `variant_action`: `add` takes an optional `status` (`draft` by default since 2026-11-15, in
  a published category too; `active` in a draft category is a 409) and, since the same day,
  `images` (the shared `imagesSchema`) beside price, stock, weight and the supplier ids;
  `archive` (draft|active → archived), `restore` (→ active when published, draft otherwise),
  and `status` `{id, status}` for any change; the same status is a 409.
- **A SKU becomes active only in a complete product (owner, 2026-11-15).** Wherever a save turns
  a SKU active — `add` with `status: 'active'`, `status` → active, `restore` in a published
  category — the product is judged as that save leaves it (`assertReady` in `typed-product.ts`
  over `productReadiness`): its description and required characteristics, and that SKU's price,
  stock and photos, with the values the same save writes when it carries `details`. Gaps are
  `409 PRODUCT_NOT_READY` with `details.issues`. Only the transition is judged: a sibling's gaps
  do not count, and a save of a SKU that is already active — a migrated one without a photo, a
  price edit — passes exactly as before. Category publication keeps its own rule (it skips
  unready products).
- Colour axis: values are dictionary ids picked from `GET /colors/admin` (adapted read now);
  a new or recoloured SKU also gets `color_id`, `color_family`, `v_value` (name_en) and the
  name «<product> — Чорний (Black)», exactly as the legacy `variantName`. An unknown id is a
  400 `UNKNOWN_COLOR`. URLs and SKU codes never change.
- Every successful create/edit purges the storefront `products` cache and signals the feed.
- Journal: a created SKU may be `draft` or `active`; the product-details profile may also write
  `color_id`, `color_family`, `v_value`. Tests: `typed-product-published.int-spec.ts`.

## Last legacy-shaped consumers and catalogue cost (2026-10-28, local)

- **B11.** Partner API (all five reads), the admin price list PDF and the public price sheet are
  adapted reads over the public category projection; a v2 product answers in the frozen v1 shape
  through `product/typed-legacy-shape.ts` (`legacyShapeOf`: typed values as text, definition labels,
  every characteristic — `visible_in_specs` is the page's table only since 2026-11-05 — brand entity
  first, `manufacturer` named explicitly, colour axis as v1 `kolir` + `name_en`).
  The Prom sync stays outside the gate with its narrow patch but defers writes while
  `catalog_control.phase` is not `idle`; the typed editor edits `prom_id` / `vendor_product_sku`
  (journal profile `draft-product-details` may write both). Details: `PARTNER_API.md`,
  `PRICE_LIST_PDF.md`, `PRICE_SHEET.md`, `PROM_AVAILABILITY_SYNC.md`; tests:
  `catalog-legacy-exports.int-spec.ts`, `typed-legacy-shape.spec.ts`,
  `typed-product-published.int-spec.ts`.
- **`/catalog/v2` cost.** Measured on the 27.10 dump (301 SKUs, 16 parallel requests) the typed
  catalogue first ran at ~14 rps against ~21 rps of the legacy one. The product join now projects
  only `category_id/attributes_v2/variant_axis/brand_id` (it pulled whole products, descriptions
  included, onto every SKU), the item colour is looked up for the page only, and the colour facet
  looks the dictionary up once per distinct colour: ~20 rps (legacy 20–21), filters ~21.5 rps
  (legacy ~33), one request ~53–58 ms (legacy 34–49 ms). No large-catalogue acceptance yet.
- **Zero-count facet values.** While anything narrows the listing, an attribute value another
  dimension brings to zero stays listed with `count: 0` (an unfiltered scope branch per
  multi-select definition), as the legacy catalogue does (TD-0008): facets of 6 filter combinations
  on the migrated dump are identical to the legacy ones.

## Release tooling and stable characteristic order (2026-10-28, local)

- **Production mode of the migration CLI** (`--production`, `scripts/catalog-cli-target.cjs`): URI
  only from `CATALOG_MIGRATION_URI` in the process environment, database `fillando-prod` only, a
  typed `--confirm=<command>:fillando-prod:<op-id>` per write, and `apply` only with a manifest of a
  restore-checked backup whose catalogue snapshot equals the live catalogue byte for byte
  (`backup-manifest` command). Local mode is unchanged. `scripts/catalog-admin-writes.cjs` switches
  `catalog_control.admin_draft_writes_enabled` (idempotent; `enable` only with control present and
  `phase: idle`). Details: `scripts/README.md`; release order: meta `docs/runbooks/catalog-v2-release.md`.
- **A refused plan never keeps the gate closed.** The CLI used to leave `phase: writing` when
  `journal.prepare` refused a plan (e.g. a target changed after the plan was built); the
  storefront would then answer maintenance until a recovery that had nothing to recover. It now
  calls `abortBeforeWrites` like the HTTP writers, reports the changed targets
  (`collection:id:field`), and `rollback` releases an operation claimed without a stored plan.
- **The typed editor keeps the stored characteristic order** (`keepStoredOrder` in
  `typed-product-writer.ts`): only new keys are appended. Re-sorting into definition order on every
  save made an unchanged migrated product differ from its stored image and moved the partner card
  rows.
- Tests: `catalog-release-cli.int-spec.ts`, `scripts/catalog-cli-target.test.cjs`,
  `typed-product-writer.order.spec.ts`, `typed-product-published.int-spec.ts` (unchanged save).


## Moving a product between categories; deleting and converting drafts over HTTP (2026-10-28, local)

- **Product transfer** (`typed-product-transfer.ts`, Plan-0010 F04). `GET /products/:id/admin/transfer?target_category_id=`
  (read-only) runs `planTransfer`: each characteristic goes to the target definition with the same key,
  or — a copied category gets new keys — the same normalised label and a compatible type (never into a
  dictionary-colour definition); values are converted only without guessing (same type and unit; enum
  options by id, then label; enum ↔ text by label). The variant axis maps the same way, preferring the
  definition of the same semantic (filament has a text «Колір» beside the colour axis); a colour axis
  keeps its dictionary ids. The answer lists `mapped`, `dropped` (with `value_label` and a reason),
  the target's `missing_required`, `axis_problem`, `variants_to_draft` and a ready `proposal`.
  `POST /products/:id/admin/transfer` (Idempotency-Key, `expected_revision`, the proposal in target
  terms plus `confirm_dropped`) rebuilds the plan under the gate: a different set of lost keys is
  `409 TRANSFER_PLAN_CHANGED`, an axis the target cannot hold `409 TRANSFER_AXIS_INCOMPATIBLE`; the
  values are validated with the target rules (all required ones for a published target, `400
  REQUIRED_VALUE`). One journal plan (profile `draft-product-details`) writes the product
  `category_id/attributes_v2/variant_axis` and every SKU's `category_id` (+ name if the axis label
  differs, + `status: draft` for an active SKU moved into a draft category). Slugs, SKU codes, IDs,
  prices, stock, legacy fields never change. Storefront categories/products caches and the feed are
  signalled. Tests: `typed-product-transfer.spec.ts`, `typed-product-transfer.int-spec.ts`.
- **Draft deletion / conversion** (B02). `POST /categories/:id/admin/deletion` `{expected_revision}` and
  `POST /categories/:id/admin/conversion` `{kind, expected_revision}` (ADMIN, Idempotency-Key, behind
  `admin_draft_writes_enabled`) expose `CategoryTreeWriter.deleteDraft` / `convertDraft`: v2 drafts
  only, refused while there are subcategories, products, SKUs, landings, route reservations or
  storefront references (`409 CATEGORY_IN_USE`), never cascading; product → group drops the definitions
  (kept in the journal before-image), group → product starts with the default brand. A new product
  category (creation or group → product) starts with one characteristic, «Виробник» (`vyrobnyk`, text,
  `semantic: brand`, required, filtered, in the table — `defaultProductDefinitions`, owner 2026-11-08): without
  a brand none of its products enters Google Merchant (`missing_brand`); from then on it is an ordinary
  characteristic the admin renames, changes or removes. A published category is never
  deleted this way (`409 CATEGORY_DELETE_REQUIRES_DRAFT`): its indexed URL is a redirect decision (B07).
  The atomic conversion plan with product assignments of TD-0013 §5 is **not** implemented — a populated
  category is emptied explicitly first (product transfer, moving subcategories). Tests:
  `category-draft-placement.int-spec.ts`.

## Typed landings (2026-10-28, local; Plan-0010 F07)

After the migration the legacy landing writes are closed by the interlock, so landings of a v2
product category have their own journal-backed controller (`landing/typed-landing.controller.ts`,
writer `typed-landing-writer.ts`, ADMIN, behind `admin_draft_writes_enabled`):

| Endpoint | Rule |
|---|---|
| `GET /landings/admin/typed?category_id=` | every landing of the category (drafts too) with `product_count` and the gate revision; 409 for a non-v2/group category |
| `POST /landings/admin/typed` | `{expected_revision, category_id, slug, h1, title, meta_description, intro_html, bottom_html, faq, filters_v2, image, order, status}` + Idempotency-Key |
| `PATCH /landings/:id/admin/typed` | the same full editable payload; only changed fields are written (+ `updatedAt`); `409 LANDING_UNCHANGED` otherwise |
| `POST /landings/:id/admin/deletion` | drafts only (`409 LANDING_DELETE_REQUIRES_DRAFT`) |

Checks under the gate: the category is a v2 product category (draft/active); `filters_v2` is a
catalogue filters object whose attribute pins are filterable keys with valid values, colour families
only under a colour axis, brand ids of active brands, no `category_ids`/`in_stock`; at least one pin
(`LANDING_PINS_REQUIRED` — without one the page duplicates the category); no other landing of the
category with the same canonical pins (`LANDING_FILTERS_DUPLICATE`) or slug (`LANDING_SLUG_TAKEN`); a
published landing keeps its slug (`LANDING_SLUG_LOCKED` — an address change is B07); publishing needs at
least one matching active SKU (`LANDING_HAS_NO_PRODUCTS`). Copy is sanitized (rich text / plain text).
The journal profile `landing` allows exactly the landing's own fields, landing creation (contract 2 with
`filters_v2`) and draft deletion; recovery of a deleted landing checks `category_id + slug`, and a
landing referenced by storefront collections is `LANDING_IN_USE`. The `landings` storefront cache is
revalidated after each write.

**Counts.** `PublicCatalogService.countTypedLandings` counts the active SKUs of a category matching each
landing's `filters_v2` in one `$facet`, with the same conditions and SKU stages as
`GET /products/catalog/v2` (refactored into `conditionsOf` / `skuStages`, behaviour unchanged). It reads
the category directly (the writer counts inside its own gate operation, where the public read barrier
would answer «busy»). `LandingService` uses it for typed landings in the public list and the legacy
admin list; legacy landings keep `countVariantsForLandings`. On the stand the 14 migrated filament
landings count exactly what the legacy counter did. Tests: `typed-landing.int-spec.ts`.

## Managed SEO and storefront settings (2026-10-28, local; B09/F05)

Category SEO copy (`PATCH /categories/:id/admin/seo`, journal profile `seo`) and the storefront settings
document (`PATCH /storefront-settings`, journal profile `settings`) — details in `STOREFRONT_SETTINGS.md`.
The journal now knows the `storefront_settings` collection (fields and creation only through `settings`).

## Redirect-backed slug changes (2026-10-28, local; B07)

`catalog_routes` now holds the aliases left by explicit slug changes of SKUs, categories (with their
landings) and typed landings; `GET /routes/resolve` answers one 301 to the entity's current public
address. Journal profile `routes`. Details: `CATALOG_ROUTES.md`.

## The product card (2026-10-28, local; F08)

- **No typed relations.** The `alternative_configuration` relation (B08: the refill ↔ spool
  link, its admin editor `GET|PUT /products/:id/admin/relations`, journal profile `relations`, the
  `alternative_label` and the «на котушці — X ₴» line) was removed by the owner on 2026-11-04.
  Leftover stored fields are ignored: `DATA_MODELS.md`.
- **No category presentation** (removed 2026-11-05 with its endpoint `…/admin/presentation` and
  journal profile `presentation`; the journal still allows the field so converting a category that
  stores it to a group can unset it). See «Product data, not category rules».
- **Product page (v2)** answers `attribute_notice` — the product's own `purchase_notice` or `null`.
  The storefront has no built-in filament notes for v2: the migration writes the refill note onto
  the refill product (mapping `product_notices`), the admin edits it per product.
- **Structured data inputs (F09)** — the v2 product page also answers `product.variant_type.semantic`
  (drives the page's `ProductGroup.variesBy`; `generic` is never a variant property) and
  `semantic_values: { size, material }` — `semanticValue()`, shared with the feed adapter (`g:size`,
  `g:material`); only a characteristic marked with that meaning, never a key or a label.

## Large catalogue: what the public reads do at 10 000 categories / 100 000 SKUs (2026-10-28, local; B05/B06)

Measured on a synthetic fixture (`fillando-meta/scripts/catalog-rehearsal/large-fixture.cjs`); details and
numbers in the Plan-0010 M0 evidence.

- **Parsed tree memo.** `CategoryPublicReadService` and `CategoryTreeReadService` reuse the parsed /
  projected tree while the catalogue stamp and `categoryFingerprint()` hold — the count plus the sum of
  `$toHashedIndexKey` of every category document, computed by MongoDB in one pass, so any write
  (journal, legacy Mongoose, a raw script) invalidates it; at most `CATEGORY_MEMO_MS` (60 s) in any case.
  (Superseded 30.10: the fingerprint is now the O(1) `$collStats` write mark — `$merge` is seen only after
  60 s — and this hash pass is its fallback; see «O(1) category fingerprint» below.)
  A server without the operator disables the memo. Callers get shared objects and must not mutate them.
  A catalogue request reads the tree once (`findVisibleTree`), not twice.
- **Joined path** (`skuStages`, product categories with definitions, brand filters, branded scopes):
  aggregated on `products` with a plain `localField`/`foreignField` lookup of each product's SKUs (fast
  engine) instead of one sub-pipeline per SKU into `products` — 5.3 s → 2.0 s on 100 000 SKUs.
- **Variant-only path** (`variantStages`, groups / the whole catalogue without brands): no product join;
  the page's 24 items get their product fields after `$limit`. The SKU/product category guard of the
  joined path becomes a side query over (product, category) pairs compared inside MongoDB
  (`driftedPairs`; only drifted pairs reach the API) whose result, with «any branded product in scope»,
  is shared by concurrent requests and reused for `SCOPE_FACTS_MS` (30 s) per scope and category
  fingerprint. So a SKU whose product moved or vanished may stay listed for up to 30 s more.
- **Category facet** counts every product category in scope only up to `CATEGORY_FACET_LIMIT` (100);
  beyond that, only the selected ones (for their chips) — 9 800 rows / 700 KB on the fixture before.
- **Known limits at that size (28.10):** the whole-catalogue listing still scanned every SKU per request
  (≈0.5 s alone, multi-second p95 at 10 concurrent whole-catalogue reads); `/catalog/sitemap` and the
  storefront sitemap were single documents. Both closed on 29.10 — see «Large catalogue II» below.

## Release rehearsal findings (2026-10-29, second session)

The full D08 §3.7 verify in production mode (meta `scripts/catalog-rehearsal/release-check.cjs`) found two
differences between the legacy filament and the migrated one, both fixed:

- **Listing order.** The legacy `findCatalogItems` sorts sold-out SKUs last under every order
  (`_outOfStock`); `/products/catalog/v2` sorted by `_id`/price only, so the migrated filament's first page
  mixed sold-out spools in. The items branch now adds `_out_of_stock` and sorts it first (never projected).
  Test: `public-catalog.int-spec.ts` «lists in-stock SKUs first under every order».
- **Feed after a CLI write.** A stale generation stamp now queues a rebuild (`MERCHANT_FEED.md`).

## Editing published categories: exact per-key usage (2026-10-29, local; release blocker)

After the migration the filament is a **published** v2 category and the legacy category writes are
interlocked, so a characteristic or the name could no longer change anywhere (`CATEGORY_EDIT_REQUIRES_DRAFT`).
The draft-only endpoints are replaced (they were never deployed):

| Endpoint | Rule |
|---|---|
| `PATCH /categories/:id/admin/definitions` (was `draft-definitions`) | draft **or published** v2 product category; archived → `409 CATEGORY_ARCHIVED` |
| `PATCH /categories/:id/admin/details` (was `draft-details`) | `{name, image?, expected_revision}` — name (unique) and the tile image (`null` removes, absent keeps); slug/kind/placement never change; nothing new → `409 CATEGORY_DETAILS_UNCHANGED` |
| `GET /categories/:id/admin/definition-usage` | ADMIN/no-store, one verified snapshot: per key `products`, `variants` (axis), `landings` (attribute pins; colour-family pins count for the colour axis), `pins`, `missing` (products without a value), per enum option usage (`settings` removed with the category presentation, 2026-11-05) |
| `PATCH /categories/:id/draft-placement` | also the **order** of a published category among its siblings (the old admin's «Порядок»); its parent still changes only in a draft branch |

`category-definition-change.ts` judges a change against that usage (read under the gate), the same on drafts and
published categories:

- **allowed**: renames (keys never change), new optional characteristics, label, order, the unit of a key no product
  or SKU holds a value of, spec visibility, filter flags of a key no landing pins, enum options added,
  renamed, reordered, an unused option or an unused key removed, any change of a key nothing holds;
- **refused (409, `details: {code, key, label, option?, usage: {products, variants, landings, settings}}`)**:
  `DEFINITION_IN_USE` (removal of a key something holds, pins or the card/feed settings name),
  `DEFINITION_TYPE_LOCKED` (value type, «кілька значень» of a used key, or its meaning into or out of the
  colour — the meaning «Бренд»/«Матеріал»/«Розмір»/generic only says where the page, the feed and the exports
  read a value, so a used key may change it, owner 2026-11-08), `DEFINITION_UNIT_LOCKED` (the
  unit of a key a product or SKU holds a value of — values are never converted; owner decision 31.10, replacing the
  29.10 «unit allowed, the editor warns»), `OPTION_IN_USE`,
  `FILTER_PINNED` (filter flag/type of a pinned key), `REQUIRED_VALUES_MISSING` (published only: a new required
  characteristic, or optional → required, while products lack it — a draft may be incomplete, publication checks
  readiness), and the last-resort `DEFINITION_CHANGE_INVALIDATES_DATA` (`assertDataStaysValid`: nothing valid before
  may become invalid; rows invalid already do not block unrelated edits).

The journal writes only `attribute_definitions` (resp. `name`/`image`; `image` joined the category allowlist). A
save without a change is byte-identical (zod output order). A published category purges
`categories`, `products` and `landings` and signals the feed. The admin tree now carries `image`.
Tests: `category-definition-change.spec.ts`, `category-definitions-published.int-spec.ts`,
`category-draft-placement.int-spec.ts`, `category-tree-read.int-spec.ts`.

## Admin parity with the old admin (2026-10-29, local)

What the old admin could do and the interlocked legacy writes no longer allow, now in the new admin (all journal-backed):

- **Colour dictionary** — `modules/color/color-admin.ts` (profile `colors`): create, update with the SKUs that
  denormalize the colour in one plan (≤ 499 SKUs per colour, else `COLOR_PLAN_TOO_LARGE`), delete only an unused
  colour (`COLOR_IN_USE` + count). The journal knows `colors` (creation/deletion; a re-insert checks slug/name_en).
- **Promotions** — `details.variants[].promo_percent/promo_ends_at` of the typed editor (TD-0012 rules through
  `resolvePromoPatch`; values sent back unchanged are no change, so an ended promotion's past date never blocks a
  save; `PROMO_ENDS_IN_PAST`/`PROMO_PERCENT_REQUIRED` → 400). The read adds them to `details` and
  `variants[].supplier_price` (below-cost warning). «Акція на весь товар» is the same field on every SKU.
- **Supplier** — `vendor_id` (optional) in the typed edit; unknown → `404 VENDOR_NOT_FOUND`; the read answers `vendor_id`.
- **Removal** — `variant_action: {type: 'archive_all'}` archives every SKU in one plan; `{type: 'delete', id}` removes
  a draft/archived SKU no order, cart, relation or old address points at (the product keeps one,
  `PRODUCT_NEEDS_A_VARIANT`); `POST /products/:id/admin/deletion` removes such a product with all its SKUs when none
  is active (`PRODUCT_DELETE_REQUIRES_INACTIVE`, `PRODUCT_IN_USE`, `VARIANT_IN_USE`). Journal deletion of products/SKUs
  (profile `draft-product-details`) keeps exact before-images; SKUs removed by the same plan do not count as usage of
  their product. The legacy delete had none of these checks.
- **Re-publication** — publishing skipped every SKU with a `color_id` (`COLOR_ADAPTER_REQUIRED`), so unpublishing and
  republishing the migrated filament left it all in draft; a colour-axis SKU whose `variant_value` is its `color_id`
  now publishes (mismatch → `COLOR_AXIS_MISMATCH`).

Tests: `color-admin.int-spec.ts`, `typed-product-published.int-spec.ts` (promotion, supplier, archive/delete),
`category-publication.int-spec.ts` (republish of a colour axis).

## Moving published branches; product category → group by plan (2026-10-29, local; B02/F02)

- **Placement** (`PATCH /categories/:id/draft-placement`): a draft branch moves anywhere as before; a
  **published** category now moves too — only under a published group or to the root (an active node always has an
  active parent chain), else `409 CATEGORY_PARENT_NOT_PUBLIC`; archived — `CATEGORY_ARCHIVED`. Category, landing and
  product URLs never depend on the tree (`/{slug}`, `/{category}/{landing}`, `/products/{slug}`), so a move changes
  menus and breadcrumbs only; a published move purges `categories/products/landings`. The old
  `CATEGORY_MOVE_REQUIRES_DRAFT_BRANCH` is gone.
- **Conversion with a distribution** (TD-0013 mutations §5, `category-conversion.ts`):
  `POST /categories/:id/admin/conversion-plan` (ADMIN, read-only, `{target_kind: 'group', assignments:
  [{product_id, target_category_id}], landing_assignments: [{landing_id, target_category_id}], adopt_targets}`)
  checks a draft or published v2 product category: every product and landing exactly once (`400
  CONVERSION_ASSIGNMENTS_INVALID` with `missing/unknown/duplicate`), targets are other draft/published v2 product
  categories (`409 CONVERSION_TARGET_INVALID`). Each product is planned like a transfer (`planTransfer`): nothing may be
  lost (`CONVERSION_PRODUCT_LOSES_VALUES` with the values), the axis must fit (`CONVERSION_PRODUCT_AXIS`), a published
  target needs its required values (`CONVERSION_PRODUCT_MISSING_REQUIRED`); each landing's pins are carried into the
  target's keys by `remapPins` (same key/label matching; another unit or a colour pin without a colour axis —
  `CONVERSION_LANDING_PINS`), its slug and pins must be unique there, and a published landing's old address
  `/{category}/{landing}` becomes an alias (`ROUTE_PATH_TAKEN` if someone else owns it). Warnings: active SKUs going into
  a draft target, a published landing hidden or without products, card/feed settings not carried. An executable plan
  is stored in `catalog_conversion_plans` for that revision and answered with `plan_id`.
  `POST /categories/:id/admin/conversion` `{kind: 'group', plan_id, expected_revision}` + Idempotency-Key rebuilds the
  plan under the gate (`CONVERSION_PLAN_STALE` for another revision, `CONVERSION_PLAN_CHANGED` when the writes differ
  from the checked ones, `CONVERSION_PLAN_BLOCKED`) and executes **one** journal plan (profile `conversion`, ≤ 500
  patches): the category becomes a group (`attribute_definitions: []`; `presentation`,
  `google_product_category` removed — all in before-images), products and every SKU move (`category_id`, values in the
  target's keys; active SKUs into a draft target become drafts), landings move with remapped pins, aliases are created,
  collections showing a moved landing follow it, and with `adopt_targets` the targets move under the new group. Verify
  before publication: nothing left in the category, kind is `group`, every image applied. Slugs, SKU codes, IDs, prices,
  stock never change. A SKU/product mismatch in the category stops the plan before any write
  (`CONVERSION_DATA_INCONSISTENT`). Group → product with children is still: move the children out, then convert the
  empty node.
- Tests: `category-conversion.int-spec.ts` (refusals, lost values, full conversion of a published category, stale and
  changed plans, a published target kept out of a draft group), `category-conversion.spec.ts` (`remapPins`),
  `category-draft-placement.int-spec.ts`, `category-definitions-published.int-spec.ts` (published moves).

## Large catalogue II: whole catalogue, memory, sitemap parts, moves (2026-10-29, third session; B05/D06)

Measured on the same synthetic fixture (now with 2 % of SKUs on promotion: open-ended, dated and ended) on
macOS and in a Linux container (`node:24-alpine`, the image's builder stage); numbers in the Plan-0010 M0
evidence. What changed:

- **Whole catalogue and big groups — split listing** (`PublicCatalogService.splitListing`, variant-only path, no
  curated `product_ids`). The `$facet` aggregation sorted and counted every SKU in scope on each request.
  Now:
  - **totals and facets** (`total`, price bounds, stock and category counts) are that same aggregation without
    its `items` branch, cached per scope + filters (`statsOf`). An entry is reused only while all of these hold:
    the **SKU write mark** (`variantWriteMark`: `$collStats` latency counters of `product_variants` — every
    insert/update/delete from any client, ~0.7 ms — plus its count), the tree key (stamp + category fingerprint),
    the scope facts, the **earliest promotion end in scope** (measured on the server clock) and 60 s. The mark is
    read before the computation, so a write the client saw acknowledged is never answered from older totals.
    Concurrent requests share one computation. Responses are not cached; no server without `$collStats`
    latency stats → the single aggregation as before;
  - **the page** keeps «in stock first» (`pageSegments`: the in-stock run, then the sold-out run) and is read by
    an index walk: `_id` descending for «newest»; for a price order `{status, promo_percent, price}` — SKUs
    without a promotion in price order (their effective price is the price; ties at the edge read whole) merged
    with the run's promoted SKUs sorted by effective price (same index, `promo_percent ≠ null`). Explain on
    100 000 SKUs: 1 100–2 300 documents per page instead of 100 000. When the walk would examine more than half
    of what sorting the scope does (a small scope, a deep page) the page is the old `items` branch alone; a
    missing price index falls back the same way.
  - Parity: `public-catalog-split.int-spec.ts` compares the split listing (forced walk and chosen plan) with the
    single aggregation on ~1 000 queries over a mixed tree (v1/v2, nested and hidden groups, drafts, archives,
    drifted and orphaned SKUs, promotions incl. ended and rounding to nothing, zero/negative/missing stock, equal
    prices), plus invalidation by raw writes, by a promotion ending, sharing, and the fallbacks.
- **Category fingerprint, once.** `categoryFingerprint` is shared by concurrent callers, but only a pass that
  started after the call (a caller arriving mid-pass waits for the next one); a catalogue request uses the key
  its tree read was built under (`CategoryPublicReadService.keyOf`) instead of hashing the categories a second
  time (~70 ms per request at 10 000 categories).
- **Parsed tree: one per connection, one parse at a time, streamed.** The memo is shared by every
  `CategoryPublicReadService` instance (Nest creates three) and by concurrent requests that miss it (when it
  expired under 10 concurrent reads each request parsed its own copy and the API ran out of a 400 MB heap).
  The parse reads the topology of every category, then the content of the visible ones in batches of 1 000 (a
  placement changed between the two passes → 503 `CATALOG_READ_CHANGED`, retry). `ancestors` is computed when
  first read (eagerly it is O(nodes × depth)). The admin/public tree projection (`CategoryTreeReadService`) is
  single-flight too. `PublicCatalogService` keeps the scope (ids, ObjectIds, node index) per tree read instead
  of rebuilding maps of 10 000 categories per request — the largest allocator under load (~3 GB/min).
- **Journal writes on a large tree.** `CategoryTreeWriter.snapshot` streams the categories, validates each and
  keeps only identity/placement fields of all but the target category: two full copies per operation
  (~100 MiB each at 10 000 categories) ran moves out of a 400 MB heap after ~56 operations. Moves, draft and
  published, p95 0.8–1.0 s (target ≤ 2 s).
- **Sitemap in parts** (`catalog-safety/catalog-sitemap.ts`): `GET /catalog/sitemap` is now the **index**
  `{initialized, revision, epoch, parts: [{from, to, urls}]}`; `GET /catalog/sitemap/part?revision&epoch[&from]
  [&to]` returns one part in the old shape `{initialized, revision, epoch, variants, categories, landings}`. The
  first part (`from` absent) carries every category and landing and the first SKUs by slug; the others are
  consecutive SKU slug ranges `[from, to)` — a range, not an offset, so a SKU created between the index and a
  part read lands in exactly one part. Parts are planned below 45 000 URLs and 1.5 MiB
  (`SITEMAP_PART_PLAN`); a part read checks the index's revision/epoch (409 `SITEMAP_REVISION_CHANGED`) and the
  hard limits 50 000 URLs / 2 MiB (409 `SITEMAP_PART_TOO_LARGE`) — re-read the index. Concatenated in index
  order the parts are byte-for-byte the former single export; the current catalogue is one part. 110 020 URLs of
  the fixture: 5 parts of ≤ 1.5 MiB (index 1.1 s, a part 0.2–0.3 s) instead of one 7.1 MB document.
- **Index added:** `product_variants {status, promo_percent, price}` (the price walk; explain above). Nothing
  else changed in the schema.
- **Stress (TD-0013 §6), measured 29.10:** chain 20 000 — every tree read paginated and ≤ 2 MiB (the deepest
  category/product detail embeds 19 999 ancestors: 1.76 MiB with short names); wide 150 000 — tree and children
  pages ≤ 226 KiB, details, listings and sitemap ≤ 2 MiB.
- **Known limits at that size (not changed):** the Google feed generation (bootstrap, hourly, on signals) keeps
  the whole working set and the XML in memory — 518 MiB peak at 100 000 SKUs on its own (`MERCHANT_FEED.md`);
  `GET /categories` (the legacy list of every product category with definitions) has no pagination — 17.7 MB at
  10 000, 247 MB at 150 000 (the storefront home no longer reads it; admin forms do); the parsed public tree holds
  every visible category (~730 MiB live at 150 000) and the category fingerprint is a full pass per request
  (~1 s at 150 000); ancestors are embedded whole (no separate paginated read); the whole-catalogue category facet
  stops at 100 product categories, which the storefront header counts its branches from.

## Large catalogue III: the D06 remainder (2026-10-30, local; Plan-0010 D06.1–D06.5)

Same synthetic catalogue, now with photos and longer descriptions (so every SKU is a real feed item); numbers in the
Plan-0010 M0 evidence (30.10). Responses, sitemap and feed for shoppers and Merchant are unchanged — performance,
memory and the shape of reads changed.

- **Google feed streamed** — `MERCHANT_FEED.md`, «Memory at 100 000 SKUs».
- **`GET /categories/options`** (public, `CategoryTreeReadService.readOptions`): the visible product categories of the
  legacy list, in its order (order, then ID), without content — `{_id, name, slug, kind, attribute_contract_version,
  order, image, attribute_count}` (`attribute_count`: v1 `required_attributes` / v2 `attribute_definitions`, counted
  by the server; a non-array counts 0). Paged like the tree (`limit` ≤ 1000, cursor bound to revision, epoch, scope
  and a snapshot of the option list — a changed option restarts with 409). A page of 1 000 is ~200 KB. The new admin
  reads its selects from it and one category's characteristics from `GET /categories/:id`; the rehearsal scripts
  find filament by `GET /categories/slug/filament`.
- **`GET /categories` (the legacy list) is unchanged** for the storefront released before Plan-0010 and stays until
  R04: every visible product category with its full public projection, unpaginated. It is now parsed per call (not
  memoised) and is the one read that still needs every category's content — 17.7 MB at 10 000 categories; at
  150 000 it does not fit a 400 MB heap and is out of the stress acceptance (the new FE never reads it).
- **One shared topology** (`category-topology.ts`, `categoryTopology(connection, stamp)`): one streamed read of the
  placement fields of every category per connection, keyed by the stamp and the O(1) fingerprint, reused at most
  `CATEGORY_MEMO_MS`, single-flight. `TopologyBuilder` applies the checks of `projectCategoryTree` (metadata, ids,
  order, duplicate ids, unknown or non-group parents, cycles) and its visibility rule row by row — no `toArray()`, no
  `CategoryTree` copies — and keeps one `TopologyNode` per category (the parent's own `_id` string as `parent_id`).
  Every tree reader is a view of it: the public and admin tree pages and `/categories/options`
  (`CategoryTreeReadService`, items shaped per page, snapshots hashed item by item) and the public reader. At 150 000
  categories three separate copies, the raw rows and the validation copies ran a 400 MB heap out of memory (a
  rebuild alone peaked ~450 MiB above the live heap). `category-topology.spec.ts` pins acceptance/refusal and order to
  `projectCategoryTree`; the parity spec checks that the reader, both tree audiences and the options read the
  categories once.
- **Light public tree** (`CategoryPublicReadService`): the memo holds only the visible tree's topology and identity
  — `PublicCategoryNode` = the shared `TopologyNode` (the tree item + `revision` + `attribute_contract_version`) — with
  indexes by id and slug.
  Content (definitions, SEO, image, timestamps) is read **per category on demand**: `findById` /
  `findBySlug` / `findVisibleById` / `contentOf(ids)` parse the missing categories in one `$in` batch, check their
  placement against the memo's tree (moved/renamed/hidden since → 503 `CATALOG_READ_CHANGED`) and keep at most
  `CATEGORY_CONTENT_CACHE` (500) parsed categories per memo, least recently used out first. `contentOf(…, { of })`
  reads against the tree a caller already holds (only that list's members) inside the caller's barrier;
  `cache: false` is for bulk passes (the feed, the admin price list, the legacy list). Readers moved accordingly:
  visibility and ids from `productCategories()` (order, partner API, landings, search, legacy catalogue), the
  selected v2 category's definitions from `contentOf` (whole catalogue/group listing), the page's categories only
  (price sheet, partner lookup, admin PDF), the home tiles' images (storefront settings); a group's scope is its
  subtree walked down from it (the light nodes carry no ancestors) — same set, same order. The detail objects are
  byte for byte the former ones (`category-public-read-parity.int-spec.ts` against a frozen copy of the former
  reader, `__former__/category-public-read.former.ts`).
  **Deliberate change in an error path:** a category whose content no longer parses fails the reads that need *that*
  category (503 `CATALOG_CATEGORY_DATA_UNAVAILABLE`) instead of every catalogue read; the legacy list, which parses
  them all, still fails closed.
- **O(1) category fingerprint** (`category-fingerprint.ts`): `collectionWriteMark(connection, 'categories')` —
  `$collStats` latency write counters + count, the collection UUID (`listCollections`) and the server process
  (`hello` → `topologyVersion.processId`), three small commands in parallel, ~1 ms. Every memo of the tree (public
  reader, tree pages, catalogue) keys on it. Measured on MongoDB 7 and 8: it changes after insert, update (also no-op
  and unmatched), replace, findAndModify, bulkWrite, delete, drop + re-create, rename over and `$out`, from any
  client. **`$merge` into `categories` reaches no counter** — such a write is seen once the memo expires
  (`CATEGORY_MEMO_MS`, 60 s); the same holds for the SKU write mark of the listing totals. The full
  `$toHashedIndexKey` pass (`hashFingerprint`) remains the fallback for a server without the counters. Tests: one
  per kind of write (journal, legacy Mongoose, a CLI/raw script on its own client — each command above, and `$merge`
  within the memo's lifetime).
- **Sitemap without a `$in` of the visible tree**: the index and parts read SKU slugs by range and keep those of
  visible product categories (the same order and shape), count non-empty categories by grouping all active SKUs and
  intersecting with the visible set, read `updatedAt` for the listed (non-empty) categories only, and match landings
  to the visible v1/v2 sets after the lookup — ~600 000 ObjectIds per index at 150 000 categories before. Exports
  unchanged: `catalog-sitemap.int-spec.ts` (drift into a group, orphan and hidden SKUs, typed/untyped/legacy landings)
  and the stand before/after.
- **Navigation counts** (D06.5): `GET /products/catalog/v2/category-counts` — active SKUs per visible product category
  over the whole catalogue, `{revision, categories: [{id, count}], next_cursor}`, non-empty only, by id. It is the
  category facet of the unfiltered whole-catalogue listing (the same scope, drifted pairs and joined path) without the
  facet's 100-category limit, outside the listing; kept per tree key and SKU write mark for at most 60 s (without a
  mark — an older server — for 60 s); paged by id (`limit` ≤ 20 000, ~1 MB), the cursor bound to that computation
  (409 `CATEGORY_COUNTS_CHANGED`). The storefront prunes empty navigation branches and builds the catalogue tiles
  with it (FE `docs/general-catalog.md`, «Large catalogue III»). Parity with the facet:
  `public-catalog-split.int-spec.ts`.
- **Ancestors** (D06.4): a detail (`GET /categories/:id`, `/slug/:slug`, the product's `category_path`) embeds the
  path whole up to `ANCESTORS_EMBED_BYTES` (1 MiB of JSON — ~2 000 levels with 200-character names) and is then byte
  for byte as before. Past that it never cuts the path silently: the category answers `ancestors: []`,
  `ancestors_paged: true`, `ancestors_total`; the product answers `category_path` = the category alone,
  `category_path_paged: true`, `category_path_total`. **`GET /categories/:id/ancestors`** (public) pages the path root
  first — `{revision, total, items: [{_id, name, slug}], next_cursor}`, `limit` ≤ 1000 (default 200); the cursor is
  bound to revision, epoch and a hash of the path (a renamed ancestor or a new revision → 409 restart). The FE reads
  the whole path on the server (`loadCategoryAncestors`) for the trail and `BreadcrumbList`. Stress: a chain of 20 000
  levels with 200-character names — the detail ≤ 2 MiB with the marker, 20 pages of ≤ 2 MiB whose concatenation is
  the path the former reader embedded (~9 MB).

## Audit 31.10.2026: failure path, operator recovery, free addresses (local)

- **A writer that fails** calls `CatalogWriteGate.afterFailedWrite(token, executionStarted)` (all 15 journal
  writers). Before `execute` it is `abortBeforeWrites`, as before. After `execute` started the gate is still
  released when no domain write happened (`writes_started: false` — `execute` refused on its pre-check, e.g.
  Prom sync's check-then-write changed a target after the plan was stored); before the audit such a refusal
  left `catalog_control` in `writing` and every catalogue read and checkout answered 503 until manual repair.
  After a domain write the operation is marked `recovery_required` and stays closed.
- **Operator recovery** — `scripts/catalog-recover.cjs inspect|resume|rollback <db> <operation-id>` (local
  allowlist, or `--production` with `CATALOG_MIGRATION_URI`, `--writers-stopped` and
  `--confirm=<command>:fillando-prod:<operation-id>`, as the migration CLI): `inspect` (no token printed),
  nothing written → the gate is released, a crash after publishing → bookkeeping finished, otherwise
  `claimRecovery → adoptRecovery → finishRecovery → execute(apply|rollback)`, every target verified at the
  chosen image (and the tree when categories changed) before `publishVerified` / `finishRolledBack`.
  Migration and staging runs are refused (their own CLIs check the legacy fingerprint). Tests:
  `catalog-recover-cli.int-spec.ts` (production mode end to end), `catalog-mutation-journal.int-spec.ts`
  («a writer that fails»), `typed-product-published.int-spec.ts` (a write outside the gate between prepare and
  execute releases the catalogue), `scripts/catalog-cli-target.test.cjs` (invocation).
- **Every finished operation asks for the Merchant feed rebuild** (`finishPublication` → `feedRefresh`):
  a completed one moves the revision the feed is served under (503 `CATALOG_FEED_STALE` until its next GET or the
  hourly run), and any outcome discards a generation it overlapped. An aborted or rolled-back operation moves the
  epoch alone and no longer makes the served feed stale (audit 11.11).
- **Free addresses on creation (B07).** A new category refuses a storefront-reserved slug
  (`ROUTE_PATH_RESERVED`, the same `reservedCategorySlug` as a slug change) and the old address of another
  entity (`ROUTE_PATH_TAKEN`) — a live page there would silently end that address's 301. A typed landing refuses a
  new `/{category}/{slug}` held as an old address by another entity (`LANDING_SLUG_TAKEN`); its own old address is
  allowed, an unchanged address is not re-judged. Tests: `category-tree-writer.int-spec.ts`, `typed-landing.int-spec.ts`.
- **A product listed in a curated storefront collection** is refused at deletion as 409 `PRODUCT_IN_USE` by the
  writer's own check (it reached the journal's last check and surfaced as 503 before).
- **OpenAPI**: 39 operations changed by Plan-0010 had lost their 2xx response (an error decorator suppresses
  Nest's default) — restored; the cursor reads document 400/404/409/503.


## Pre-release fixes 02.11.2026 (local; Plan-0010 §8, owner decision «fix everything before the release»)

- **P01** — a name or address taken by another category is a 409 `CATEGORY_IDENTITY_CONFLICT` carrying
  `details.conflict { field, category { id, name, slug } }` (`CategoryIdentityConflict` in
  `category-tree-writer.ts`); the admin names the category and what clashed.
- **P02** — the sitemap lists a landing only while it has an active SKU, counted as its page counts it
  (`countTypedLandings` / `countVariantsForLandings`).
- **P05** — `@CatalogConsistentRead()` puts the legacy read barrier on non-legacy handlers: `/routes/resolve`
  and the public `/storefront-settings` answer 503 `CATALOG_MAINTENANCE` / `CATALOG_READ_CHANGED` with
  `Retry-After: 5` and `no-store` during a catalogue write.
- **P06** — admin v2 routes document 400/404/409/503; the admin typed-landing list stops at
  `TYPED_LANDING_LIST_MAX` (500) with `truncated: true`; slug `ancestors` is reserved.
- **P08** — shared limits: `CATEGORY_PAGE` (dto/category-tree.dto.ts), `STOREFRONT_LIMITS`
  (storefront/storefront-limits.ts), the journal's `PLAN_MAX_TARGETS` / `PLAN_MAX_BYTES` (conversion, colours,
  the rehearsal stage script); `scripts/catalog-presentation.mapping.json` replaced by the migration's own
  `presentation`.
- **P11** — rate limits and refresh-token IPs key on `clientIp` (`common/guards/client-ip.util.ts`): see
  API_AND_SWAGGER.md §4a.
- **P12/P15** — storefront purges go through the `storefront_purges` outbox until a 2xx, then echo once after
  10 s: see STOREFRONT_REVALIDATION.md.
- **P13** — publishing a category above the journal's 500-target limit runs in parts: SKU batches as their
  own operations, the category last under the request's key (`category-publication.ts`); a stop between
  parts leaves the category a draft and a new publish finishes; 409 `PUBLICATION_CHANGED` replaces
  `PUBLICATION_TOO_LARGE`.
- **P14** — the sitemap URL set is built once per catalogue state (revision, epoch, write marks of
  `categories` / `products` / `product_variants` / `landings`, at most 10 min) and parts are cut from it.
- **P16/P18** — `tsc --noEmit` and `eslint` over `src` and `test` are clean (P18: 344 errors and 20 warnings
  fixed by typing, not by disabling rules — list of the few justified disables in Plan-0010 §8).
- **Target of the release CLIs** (owner decision 02.11.2026): `catalog-v2-migrate.cjs`, `catalog-admin-writes.cjs`
  and `catalog-recover.cjs` connect to the backend's `DATABASE_URL` (environment, else `.env`) — no
  `CATALOG_MIGRATION_URI`, no allowlist of local names. The database named in the command must be the URI's; a
  loopback server is a local run, a remote one needs `--production` (database `fillando-prod`, typed confirmation,
  backup manifest). Tests: `scripts/catalog-cli-target.test.cjs`, `catalog-release-cli.int-spec.ts`,
  `catalog-recover-cli.int-spec.ts`.

## `on_sale` — SKUs on a live promotion (Plan-0010 P20, 2026-11-03, local)

`GET /products/catalog/v2` takes `filters.on_sale: true` (only `true`; `false` is a 400): SKUs whose
promotion gives a saving right now — the same `salePriceExpr` the response's `sale_price` comes from, so
an ended promotion or a percent that rounds to no saving is not «on sale» (TD-0012). It is one more
listing condition (key `promo`), expressed on the stored fields, so it also holds for the split
listing's index walk, which reads SKUs before `_price` exists. The storefront's catalogue hub
(`/catalog`, groups) fetches it for its «Акції» strip; it is not a visitor URL parameter, and a typed
landing cannot pin it (`LANDING_FILTERS_INVALID`).
`public-catalog.int-spec.ts` pins a category and the whole catalogue.

## Audit 11.11.2026 (local, before the push to `dev`)

- **One protocol for the plan-only writers.** Route changes, «Вітрина», typed landings, category SEO and
  export run through `runCatalogOperation` (`database/mongoose/repositories/catalog-operation.ts`): admin
  writes enabled → stored operation (reused key / completed receipt / already registered) → `beforeAcquire` →
  gate → enabled again → `build` → `prepare` → `execute` → optional after-image check → `publishVerified`;
  a failure before `execute` releases the gate, after it keeps it for recovery. The request hash is the same
  BSON as before, field for field. The tree, publication and conversion keep their own steps.
- **One read barrier per request.** `LegacyCatalogWriteInterceptor` runs a guarded read inside an
  `AsyncLocalStorage` scope; a service's `beginRead` / `finishRead` inside it (`PublicCatalogService.read`,
  `CategoryPublicReadService.withMemo`, …) reuse the request's stamp — a stricter (non-adapted) one inside an
  adapted request still reads its own. The request verifies once when the handler answers, and the scope
  closes before that check, so a timer or stream outliving the request verifies on its own.
  `/products/catalog/v2` read `catalog_control` 6–8 times; now twice. Test: `legacy-catalog-write.int-spec.ts`.
- **Feed staleness is the revision** (`FeedService.getVerifiedXml`): see MERCHANT_FEED.md.
- **`sitemap` is a reserved first segment** (`RESERVED_ROOTS`): the storefront's `/sitemap/<part>` would answer
  404 for every landing of a category with that slug.
- **`GET /categories/:id` reads an id in upper case** as the same id (it answered 200 through the Mongoose cast
  before the memo).
- **A slug change with a wrong body** (no `expected_revision`, a stray field) is 400 `INVALID_ROUTE_FIELDS`, no
  longer `INVALID_SLUG`.
- **«Вітрина» buttons refuse a backslash** (`INTERNAL_HREF_REQUIRED`): a browser reads `/\host` as `//host`.
- **The 503 texts in Swagger** come from `CATALOG_UNAVAILABLE` (`common/constants/docs`), one per kind of
  handler — the pasted copies had drifted (colours, tree-independent, documented `CATALOG_READ_UPGRADE_REQUIRED`).

## Product strip — one card per product (2026-11-14, local)

`GET /products/catalog/v2/strip?category_id=&limit=&filters=` (`PublicCatalogService.strip`) answers the
storefront's strips — «Новинки», «Акції», a «Вітрина» collection. A product arrives with all its colours at
once, so the first page of the SKU listing was one product seven times, and with the colour at the end of the
name the cards read as copies (owner, 2026-11-14; 302 SKUs are 45 products on the 08.11 dump).

- **Same scope, filters and guards as the listing.** `scopeOfQuery` is the head of `listing` (the body of
  `read`: tree, selected node, scope, definitions, `conditionsOf`), shared by both; the query takes
  `category_id`, `limit` (≤ 24, default 8) and the listing's strict `filters` — no `page`, no `sort` (400).
- **Which products.** The listing itself is walked in its «newest» order (in stock first, newest first, a
  curated `product_ids` list in the admin's order), 100 SKUs a step, 5 steps at most (`STRIP_WALK`): each
  product is taken once, by its first SKU there. Past 500 SKUs a strip may be shorter than `limit`.
- **A step reads the page alone** (2026-11-15): `listing(query, plain)` takes the already parsed query (nothing
  is serialised and parsed again) and sends the listing's own `items` stages without a `$facet` — the single
  aggregation as one plain pipeline, the split listing as its index walk over two counts of its own (total and
  in stock, plain pipelines cached like the listing's totals, under a separate key). No facet, no price bounds
  and, on the single aggregation, no total: a page shorter than 100 ends the walk. Before, every step ran the
  whole public listing — each facet counted over the scope and thrown away — and a product list
  (`product_ids`) passed every SKU of the catalogue through `$facet` on each step.
- **The card** is that SKU's listing item (byte-identical projection) plus `group`, one aggregation over the
  chosen products only — the joined path (`skuStages`) narrowed by `_id`, then the same conditions:
  `name` (the product's), `count`, `in_stock` and `on_sale` (its SKUs under the scope and filters — an «Акції»
  group is the SKUs on sale, not the whole product; `on_sale` lets a card print «−N %» only when every SKU of
  the group is discounted), `price_min` / `price_max` (effective price over the in-stock
  SKUs; over all of them when none is in stock — never a price nobody can pay today), `colors_count` and up
  to 12 `colors` (`family`, `hex_stops`, `in_stock`; distinct dictionary colours, in-stock first — a sold-out
  colour is marked, not hidden, so the card can fade it).
- **No total, no facets.** A strip is not a listing; `{revision, items}`.
- **Cost.** At most five page reads plus the group aggregation and two small reads. Throttled like the
  listing (120/min, internal token exempt). Measured 2026-11-15 on the synthetic catalogue (100 000 SKUs,
  10 020 categories, `large-fixture.cjs`, plus one category of 20 products × 30 colours for the five-step
  walk), old and new code side by side on one database, one request at a time, median of 8 warm answers,
  before → after:
  - a product list of 24: 375–407 → 38–52 ms; over five steps 1 609 → 156 ms;
  - a product category of 1 025 SKUs: 110 → 80 ms; over five steps (the 20 × 30 category) 340 → 214 ms —
    what remains is the product join of that path, not facets;
  - the whole catalogue and groups (the split listing): 47–95 ms warm, their «Акції» about 170 ms, unchanged —
    their counts were cached already; the first, uncached answer (single samples) 1.26 → 0.94 s for the whole
    catalogue, 0.67 → 0.32 s for its «Акції», about 0.5 s for a group either way;
  - 10 readers for 60 s over the five strip scenarios of `load-large.mjs`: 604 → 3 178 answers, a product
    list p50 3 246 → 155 ms and p95 6 672 → 229 ms, «Акції» p95 3 154 → 577 ms, no status but 200.
  The cards of every measured strip and 48 public listing answers are byte for byte what they were. On the
  whole catalogue each pipeline still carries the scope as an `$in` of every product category (~30 ms at
  9 800 of them).

Tests: `public-catalog.int-spec.ts` (one card per product, the group under `on_sale`, a curated order, the walk
past a 120-colour product, the five-step cap — a strip shorter than `limit` on both paths, the HTTP contract,
503 `CATALOG_MAINTENANCE` on the strip route, a database that was never migrated — no `catalog_control`, a flat
v1 category — answering grouped cards), `public-catalog-split.int-spec.ts` («product strip»: the strip equals
the public listing grouped by product for 31 scopes and filters × 3 limits on every path — index walk, sorted
page, no write mark, product join; no pipeline a strip sends carries `$facet`, and a step on the product join
is one pipeline), `product.controller.throttle.spec.ts`.

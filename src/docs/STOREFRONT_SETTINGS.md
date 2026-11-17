# Storefront settings and managed category SEO (Plan-0010 B09/F05, local)

Both are content the storefront already knew how to render; until now nothing wrote them.

## Category SEO — `GET/PATCH /categories/:id/admin/seo` (ADMIN)

`category-seo.ts`. Draft or published **v2** category (group or product), never archived/v1
(`409 CATEGORY_SEO_UNAVAILABLE`). Body `{expected_revision, seo: {title, description, h1, intro_html,
bottom_html}}` + `Idempotency-Key`; every field nullable, blank → `null`; plain text sanitized as text,
rich text with `sanitizeRichText` (an editor's leftover `<p><br></p>` is `null`). An unchanged payload is
`409 SEO_UNCHANGED`. Written through the catalogue gate and journal (profile `seo`: the `seo` object and
`updatedAt` of a category only) — a content edit, so it is allowed on a published category. The
storefront `categories` cache is revalidated. The storefront reads `category.seo` (typed listing title,
description, H1, text above/below) with its own fallbacks (`«<name> — купити у Fillando»`, a generic
description, the category name).

## Storefront settings — `/storefront-settings`

`storefront/storefront-settings.ts`, one document (`_id` `00000000000000000000aa01`) in
`storefront_settings`:

| Field | Meaning |
|---|---|
| `strip` | up to 4 short lines (≤ 60) of the strip above the header; `[]` — no strip (TD-0015) |
| `banner` | `{eyebrow, title, accent, text, button_label, button_href}` — the home page's banner; `title` (1–80) is the page's H1, `accent` a part of it shown highlighted (may be empty) |
| `side_promo` | `{title, text, button_label, action: 'wholesale-form' \| 'link', button_href}` — the card beside the banner: the wholesale inquiry form, or a link (`button_href` only with `link`) |
| `band` | `{title, text, button_label, button_href}` or `null` — the band between the strips |
| `collections[]` | ≤ 12 product strips: `{id, title, category_id, landing_id|null}` — a category or one of its typed landings — or `{id, title, category_id: null, landing_id: null, product_ids}` — an explicit list of ≤ 24 products in the admin's order (Plan-0010 B09, 29.10.2026; `product_ids` is stored only on such a collection) |

The text above `/catalog` is not a setting: it is the storefront's own copy in `fillando-fe` (owner,
2026-11-03), so a `catalog_intro_html` in the body is an unknown field (`400`).

**The home page's copy (TD-0015, owner 2026-11-09).** No product or category is written into the storefront's
code: the strip, the banner, the side card and the band are settings. Until a part is saved, the reads answer
its default (`STOREFRONT_CONTENT_DEFAULTS` — the sketch's copy, generic, never a category), so no data step is
needed; the admin edits it like any value. Every text is plain text (`sanitizePlainText`, markup removed), every
button a path on this site (`/…`, never a scheme or `//host` — `400`), and `accent` must be a part of `title`.
The home page's category tiles (`home_category_ids`) are gone — its menu is the public category tree: the field
is an unknown one in the body (`400`), and a save of a document that still holds it removes it (so a stale
reference never blocks a category deletion).

- `PATCH /storefront-settings` (ADMIN, `Idempotency-Key`, `expected_revision`): references must be
  non-archived v2 categories and typed landings of the same category (`409 SETTINGS_CATEGORY_INVALID`,
  `SETTINGS_LANDING_INVALID`, `SETTINGS_DUPLICATE_CATEGORY`); a collection has exactly one source — a
  category (optionally a landing) or a non-empty product list (else `400`); listed products must exist in a
  non-archived v2 category, once per collection (`409 SETTINGS_PRODUCT_INVALID`,
  `SETTINGS_DUPLICATE_PRODUCT`); collections keep their ids; an unchanged
  payload is `409 SETTINGS_UNCHANGED`. Journal profile `settings` (the document's fields, its creation).
  Category deletion already refuses a category the settings reference (`CATEGORY_IN_USE`), and the journal
  refuses deleting a listed product (`PRODUCT_IN_USE`). Revalidates the
  storefront `categories` tag, which the storefront uses for the settings read.
- `GET /storefront-settings/admin` (ADMIN): stored ids + the gate revision.
- `GET /storefront-settings` (public): the copy (stored or default) and collections of visible
  categories; a collection whose landing is not active/typed points at its category (`path`), with the
  landing's `filters_v2` when it is one, so the storefront can query `/products/catalog/v2`. A product list
  answers `category_id: null`, `path: null` and `filters: {product_ids}` with only the products of visible
  categories (none visible — no strip); `/products/catalog/v2` takes `product_ids` as a filter (SKUs of those
  products, visible categories only) and, under the default sort, keeps the list's order (in-stock SKUs first).
  The storefront reads every strip — a collection, «Новинки», «Акції» — from
  `GET /products/catalog/v2/strip` with the same `category_id` and `filters`: one card per product
  (CATEGORY_TREE.md, «Product strip»).

Out of scope (owner decision 2026-10-29): `featured_brand_ids` and brands on the home page — «Виробник» stays a
characteristic. Tests: `category-seo.int-spec.ts`, `storefront-settings.int-spec.ts` (product list),
`public-catalog.int-spec.ts` (`product_ids` filter and order).

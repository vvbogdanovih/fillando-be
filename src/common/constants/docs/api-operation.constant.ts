/**
 * Swagger/OpenAPI operation metadata (summary, description) for API endpoints.
 * Used with @ApiOperation() in controllers to keep docs in one place.
 */
export const API_OPERATION = {
	CATALOG_OPERATIONS: {
		STATUS: {
			summary: 'Стан операції каталогу',
			description:
				'ADMIN-only diagnostic receipt. Pending does not distinguish a live writer from a stopped process; no automatic retry/takeover.'
		}
	},
	CATALOG_EXPORT: {
		SITEMAP: {
			summary: 'Індекс частин sitemap',
			description:
				'Public. The parts of the storefront URL set (SKUs of visible product categories, non-empty visible categories, public landings) under one revision/epoch read barrier: the first part carries every category and landing, the rest are consecutive SKU slug ranges; each part stays below 50 000 URLs and 2 MiB. Read every part with this revision/epoch. Deploy before the corresponding frontend.'
		},
		SITEMAP_PART: {
			summary: 'Частина sitemap',
			description:
				'Public. One part of the index — SKU slugs in [from, to), plus every category and landing when `from` is absent — under the revision/epoch the index was read with (409 SITEMAP_REVISION_CHANGED otherwise; 409 SITEMAP_PART_TOO_LARGE if the part outgrew 50 000 URLs or 2 MiB since). Same entries and order as the single export before the split.'
		}
	},
	PARTNER_API: {
		SKUS_BODY: {
			summary: 'Артикули категорії або всього каталогу (JSON body)',
			description:
				'Передайте category_id, cursor та limit у JSON-тілі. Для першої сторінки cursor не потрібен. Порожній об’єкт {} повертає перші 100 артикулів усього каталогу. Сортування за SKU; next_cursor=null означає кінець. Курсор прив’язаний до категорії.'
		},
		CATEGORIES: {
			summary: 'Категорії з кількістю активних артикулів',
			description: 'Плоский список, parent_id завжди null; порожні категорії включено.'
		},
		LOOKUP: {
			summary: 'Картки товарів за артикулами',
			description:
				'До 100 артикулів; лише активні доступні товари. Повтори об’єднуються, порядок першої появи зберігається. Формат {items, not_found}, завжди 200 для валідного запиту. Повертає поточну роздрібну ціну price у гривнях і currency=UAH.'
		},
		BULK_AVAILABILITY: {
			summary: 'Отримати наявність за списком артикулів',
			description:
				'Від 1 до 100 артикулів. Повтори об’єднуються; порядок у кожному списку відповідає першій появі у запиті. Невідомі та неактивні товари — у not_found. Завжди 200 для валідного запиту, навіть якщо жодного товару не знайдено.'
		},
		AVAILABILITY: { summary: 'Отримати наявність товару за артикулом' },
		LIST_TOKENS: { summary: 'Список API-токенів' },
		CREATE_TOKEN: { summary: 'Створити API-токен' },
		REVOKE_TOKEN: { summary: 'Відкликати API-токен' }
	},
	AUTH: {
		ME: {
			summary: 'Get me',
			description: 'Get user'
		},
		LOGIN: {
			summary: 'Login',
			description: 'Login user'
		},
		REGISTER: {
			summary: 'Register',
			description: 'Register user'
		},
		REFRESH: {
			summary: 'Refresh access token',
			description: 'Refresh access token'
		},
		GOOGLE: {
			summary: 'Google login',
			description: 'Google login'
		},
		GOOGLE_CALLBACK: {
			summary: 'Google callback',
			description: 'Google callback'
		},
		LOGOUT: {
			summary: 'Logout',
			description: 'Logout user'
		}
	},
	USERS: {
		GET_ALL: {
			summary: 'Get all users',
			description: 'Paginated list of all users with optional role filter. Admin only.'
		},
		ME: {
			summary: 'Get my profile',
			description: 'Returns the profile of the authenticated user'
		},
		UPDATE_ME: {
			summary: 'Update my profile',
			description: 'Updates name, phone, or profile picture for the authenticated user'
		}
	},
	COLORS: {
		ADMIN_ENTRIES: {
			summary: 'Словник кольорів для нової адмінки',
			description:
				'ADMIN, no-store; one verified snapshot with the catalogue revision and how many SKUs use each colour.'
		},
		ADMIN_CREATE: {
			summary: 'Додати колір у словник',
			description:
				'ADMIN; gate + journal (profile `colors`), Idempotency-Key and expected revision. Unique name_en and slug (derived from name_en if omitted).'
		},
		ADMIN_UPDATE: {
			summary: 'Змінити колір словника',
			description:
				'ADMIN; one journal plan: the colour plus the SKUs that denormalize it (color_family, the «товар — Чорний (Black)» name, only where they drift). v_value and slugs never change. Revalidates products/categories and signals the feed.'
		},
		ADMIN_DELETE: {
			summary: 'Видалити невикористаний колір',
			description:
				'ADMIN; refused with COLOR_IN_USE (details.count) while any SKU points at it.'
		},
		GET_ALL: {
			summary: 'Get the colour dictionary',
			description:
				'Public. Every colour, ordered by `order` then `name_en`. Drives the catalogue swatch filter and the "Чорний (Black)" labels.'
		},
		GET_ADMIN_ALL: {
			summary: 'Get the colour dictionary with usage counts',
			description:
				'Admin only. The same rows as `GET /colors`, each carrying `variant_count` — how many product variants point at that colour, in every status. The count matches the guard that refuses `DELETE /colors/:id`.'
		},
		GET_BY_ID: {
			summary: 'Get colour by id',
			description: 'Public. A single colour dictionary entry.'
		},
		CREATE: {
			summary: 'Create colour',
			description: 'Admin only. `name_en` and `slug` must be unique.'
		},
		UPDATE: {
			summary: 'Update colour',
			description:
				'Admin only. Changing `family` also rewrites `color_family` on every variant of this colour, so the catalogue filter stays consistent with the dictionary.'
		},
		DELETE: {
			summary: 'Delete colour',
			description:
				'Admin only. Refused while variants still reference the colour — clear or repoint them first.'
		}
	},
	CATALOG_ROUTES: {
		RESOLVE: {
			summary: 'Resolve an old catalogue address',
			description:
				'Public. An alias left by a slug change → `{kind: redirect, target_path, status: 301}` to the entity’s current public address (never a chain). 404 for an unknown path or a target that is not public.'
		},
		VARIANT_SLUG: {
			summary: 'Change a SKU address (with a redirect)',
			description:
				'ADMIN, Idempotency-Key, expected_revision. Writes the slug and keeps `/products/{old}` as an alias of the SKU (journal profile `routes`); an own alias at the new address is reclaimed; an address of another entity is 409 ROUTE_PATH_TAKEN.'
		},
		CATEGORY_SLUG: {
			summary: 'Change a category address (with redirects)',
			description:
				'ADMIN; v2 draft/published category. `/{old}` and every `/{old}/{landing}` stay aliases; reserved roots are refused (ROUTE_PATH_RESERVED).'
		},
		LANDING_SLUG: {
			summary: 'Change a typed landing address (with a redirect)',
			description: 'ADMIN. `/{category}/{old}` stays an alias of the landing.'
		}
	},
	STOREFRONT_SETTINGS: {
		PUBLIC: {
			summary: 'Storefront settings (public projection)',
			description:
				'Home categories, collections and the /catalog intro — visible categories and active typed landings only; a collection whose landing is no longer public points at its category.'
		},
		ADMIN_READ: {
			summary: 'Storefront settings (admin)',
			description: 'The stored settings with the catalogue gate revision.'
		},
		WRITE: {
			summary: 'Save storefront settings',
			description:
				'ADMIN, Idempotency-Key, expected_revision. References must be non-archived v2 categories and typed landings of their category; the intro is sanitized. Journal-backed (profile `settings`); revalidates the storefront categories cache.'
		}
	},
	LANDINGS: {
		TYPED_ADMIN_LIST: {
			summary: 'List the landings of a v2 product category (admin)',
			description:
				'Drafts included; each with `product_count` — the active SKUs its `filters_v2` pins match, counted by the same conditions as `GET /products/catalog/v2`.'
		},
		TYPED_ADMIN_CREATE: {
			summary: 'Create a typed landing',
			description:
				'Journal-backed (gate revision). Pins are checked against the category definitions (filterable keys, valid values, colour only with a colour axis, active brands); at least one pin; no duplicate pins or slug in the category; publishing needs at least one matching product. Copy is sanitized.'
		},
		TYPED_ADMIN_UPDATE: {
			summary: 'Update a typed landing',
			description:
				'Full editable payload (copy, pins, image, order, status); only changed fields are written. The same checks as create; an unchanged payload is 409 LANDING_UNCHANGED.'
		},
		TYPED_ADMIN_DELETE: {
			summary: 'Delete a draft typed landing',
			description:
				'Only drafts: a published landing is an indexed address — unpublish it first; its URL is a redirect decision (B07).'
		},
		GET_ALL: {
			summary: 'Get published landings',
			description:
				'Public. Active landings only, optionally narrowed to one category with `category_id`. Drafts are never returned here. Each row carries `product_count` — the category page shows it on the «Популярні види» tiles.'
		},
		GET_SLUGS: {
			summary: 'Get published landing slugs',
			description:
				'Public. Category slug + landing slug + updatedAt for every active landing — the sitemap builds its URLs from this.'
		},
		GET_ADMIN_ALL: {
			summary: 'Get all landings (admin)',
			description:
				'Admin only. Every landing including drafts, optionally filtered by `category_id`. Each row carries `product_count` — how many ACTIVE catalogue variants its pinned filters match, counted the same way the landing page is filled, and the same number publishing is refused on when it is zero.'
		},
		GET_BY_SLUG: {
			summary: 'Get landing by category and landing slug',
			description:
				'Public. Active landings only; an unknown or draft address is a 404 so the page can render `notFound()`.'
		},
		GET_BY_ID: {
			summary: 'Get landing by id (admin)',
			description: 'Admin only. Returns drafts too — this is what the edit form loads.'
		},
		CREATE: {
			summary: 'Create landing',
			description:
				'Admin only. `slug` is unique within the category. Rich-text fields are sanitized on write. Creating one already `active` whose filters match no product answers 409 — a published landing that matches nothing is an indexed empty page.'
		},
		UPDATE: {
			summary: 'Update landing',
			description:
				'Admin only. Rich-text fields are sanitized on write. Checked against the state the save would leave behind: if the landing ends up `active` and its filters match no product, the request answers 409 — narrowing the filters of an already published landing is refused just like flipping the status.'
		},
		DELETE: {
			summary: 'Delete landing',
			description: 'Admin only.'
		}
	},
	CATEGORIES: {
		ADMIN_FILTER_PREVIEW: {
			summary: 'Перевірити фільтри на даних категорії',
			description:
				'ADMIN read-only bounded preview. Typed v2 data; active/draft SKU, self-excluding facets, no publication.'
		},
		ADMIN_DEFINITIONS: {
			summary: 'Налаштування характеристик категорії',
			description:
				'ADMIN; draft or published v2 product category. Stable server-assigned identities, journal, expected revision. Judged against the exact per-key usage: renames, new optional characteristics, units, order, spec/filter flags of unpinned keys and enum options are allowed; a type change or removal of a used key, removal of a used option, a filter change under landing pins and (published) a requirement products cannot meet are 409 with the counts of products, SKUs and landings.'
		},
		ADMIN_DEFINITION_USAGE: {
			summary: 'Використання характеристик категорії',
			description:
				'ADMIN read-only, one verified snapshot: per key the products, SKUs and landings holding or pinning it, products without a value, card/feed settings naming it, and per enum option usage.'
		},
		ADMIN_CONFIGURATION: {
			summary: 'Конфігурація категорії для редактора',
			description:
				'ADMIN v2 configuration and derived form/filter controls, one verified snapshot.'
		},
		DRAFT_CREATE: {
			summary: 'Створити чернетку категорії',
			description:
				'ADMIN; explicit draft rollout flag, expected revision and idempotency key required. Empty definitions; no publication.'
		},
		ADMIN_DETAILS: {
			summary: 'Назва й зображення категорії',
			description:
				'ADMIN; draft or published v2 category. Name (unique) and optional tile image URL; slug, kind and placement unchanged. Journal-backed; a published category purges the storefront caches and signals the feed.'
		},
		ADMIN_CAPABILITIES: {
			summary: 'Доступність редактора дерева',
			description: 'ADMIN advisory state. Does not initialize or enable writes.'
		},
		ADMIN_PUBLICATION: {
			summary: 'Опублікувати або зняти з публікації v2-категорію',
			description:
				'Explicit rollout flag required. Journal-backed status change of a v2 category and of the SKUs of its ready products; parent must be public; unpublish requires no active children. Same-key replay; URLs, SKUs and prices unchanged.'
		},
		ADMIN_SEO_READ: {
			summary: 'Read the managed SEO copy of a v2 category',
			description:
				'ADMIN; draft or published v2 category (group or product). With the gate revision.'
		},
		ADMIN_SEO_WRITE: {
			summary: 'Save the managed SEO copy of a v2 category',
			description:
				'ADMIN; title, description, H1, text above/below the listing (rich text sanitized, empty → null). A content edit: allowed on published categories, journal-backed (profile `seo`, the `seo` object only), revalidates the storefront categories cache. Unchanged → 409 SEO_UNCHANGED.'
		},
		ADMIN_EXPORT_READ: {
			summary: 'Read the Google taxonomy of a v2 product category',
			description:
				'ADMIN. The `google_product_category` the feed sends for the category items.'
		},
		ADMIN_EXPORT_WRITE: {
			summary: 'Save the Google taxonomy of a v2 product category',
			description:
				'ADMIN, Idempotency-Key, expected_revision. `{id, path}` or null; the path is an admin note, only the id is sent. Journal profile `export`; requests an early feed rebuild. Unchanged → 409 EXPORT_UNCHANGED.'
		},
		DRAFT_DELETION: {
			summary: 'Видалити порожню чернетку категорії',
			description:
				'ADMIN; v2 draft only. Refused while it has subcategories, products, SKUs, landings, route reservations or storefront references; never cascades. Journal-backed with an exact before-image; same-key replay. A published category must be unpublished first; its indexed URL is a redirect decision (B07), not a deletion.'
		},
		DRAFT_CONVERSION: {
			summary: 'Змінити тип категорії (група ↔ товарна категорія)',
			description:
				'ADMIN. Without plan_id: an empty v2 draft only (no subcategories, products, SKUs or landings); product → group drops the definitions (kept in the journal before-image), group → product starts with none. With plan_id (from conversion-plan): a draft or published v2 product category becomes a group and every product (with all its SKUs) and landing moves as the stored plan says — one journal plan; category/product URLs, SKU codes, prices and stock unchanged; old landing addresses become aliases. The plan is valid for its revision only (CONVERSION_PLAN_STALE) and must still describe the same writes (CONVERSION_PLAN_CHANGED).'
		},
		CONVERSION_PLAN: {
			summary: 'Перевірити план перетворення товарної категорії на групу',
			description:
				'ADMIN, read-only check of an explicit distribution (TD-0013 mutations §5): every product and landing of the category assigned to another v2 product category, exactly once (else 400 CONVERSION_ASSIGNMENTS_INVALID). Answers per-product and per-landing results, problems (values that would be lost, axis, missing required values for a published target, pins that do not fit, slug/pin duplicates, taken addresses, plan size) and warnings (SKUs that become drafts, landings hidden or without products, card/feed settings not carried). An executable plan is stored for this revision and returned with plan_id; otherwise plan_id is null.'
		},
		DRAFT_PLACEMENT: {
			summary: 'Перемістити категорію або змінити її порядок',
			description:
				'Explicit rollout flag required. Journal-backed placement: a draft branch moves anywhere; a published category moves only under a public group or to the root (CATEGORY_PARENT_NOT_PUBLIC) — category, landing and product URLs never depend on the tree; archived — CATEGORY_ARCHIVED. Same-key replay.'
		},
		CHILDREN: {
			summary: 'Read visible category children',
			description:
				'Direct children ordered by order and ID; omit parent_id for roots. Hidden or absent parent returns 404.'
		},
		TREE: {
			summary: 'Read public category tree',
			description:
				'Flat paginated tree; hidden ancestor branches are excluded. Restart on revision conflict.'
		},
		ADMIN_TREE: {
			summary: 'Read complete category tree (ADMIN)',
			description: 'Includes draft and archived nodes; revision-bound pagination.'
		},
		OPTIONS: {
			summary: 'Read product categories for selects',
			description:
				'The visible product categories of GET /categories, in its order (order, then ID), without their content: ID, name, slug, kind, attribute contract version, order, tile image and the number of characteristics. Paginated (limit ≤ 1000, ≤ 2 MiB per page), cursor bound to the catalogue revision — restart on CATEGORY_REVISION_CONFLICT. Characteristics of one category: GET /categories/:id.'
		},
		ANCESTORS: {
			summary: 'Read a category path, page by page',
			description:
				'Ancestors of a visible category (group or product), root first: {revision, total, items: [{_id, name, slug}], next_cursor}. A detail embeds them whole up to 1 MiB of JSON; past that it answers ancestors: [] with ancestors_paged: true and ancestors_total (a product: category_path_paged), and the path is read here. limit ≤ 1000 (default 200); the cursor is bound to the catalogue revision and to the path — CATEGORY_REVISION_CONFLICT means restart. Hidden or unknown category: 404.'
		},
		GET_ALL: {
			summary: 'Get all categories (legacy list)',
			description:
				'Every visible product category with its full public projection, unpaginated. Kept unchanged for the storefront released before Plan-0010 until its retirement (R04); new readers use GET /categories/options and GET /categories/:id.'
		},
		GET_BY_SLUG: {
			summary: 'Get category by slug',
			description: 'Get a single category (with its filter attributes) by slug'
		},
		GET_BY_ID: {
			summary: 'Get category by id',
			description: 'Get a single category by id'
		},
		CREATE: {
			summary: 'Create category',
			description: 'Create a new category'
		},
		UPDATE: {
			summary: 'Update category',
			description: 'Update an existing category'
		},
		DELETE: {
			summary: 'Delete category',
			description: 'Delete a category'
		},
		REPLACE: {
			summary: 'Replace category',
			description: 'Fully replace a category (all fields required)'
		}
	},
	VENDORS: {
		GET_ALL: {
			summary: 'Get all vendors (admin)',
			description:
				'Admin-only; a vendor is a supplier, so the list never leaves through a public route.'
		},
		GET_BY_ID: {
			summary: 'Get vendor by id (admin)',
			description: 'Admin-only; returns a single supplier record.'
		},
		CREATE: {
			summary: 'Create vendor',
			description: 'Create a new vendor'
		},
		UPDATE: {
			summary: 'Update vendor',
			description: 'Update an existing vendor'
		},
		DELETE: {
			summary: 'Delete vendor',
			description: 'Delete a vendor'
		},
		CHECK_AVAILABILITY: {
			summary: 'Check vendor availability (admin)',
			description:
				'Admin-only; checks if a vendor name or slug is available (not taken). Used by the admin vendor form — answering it publicly would confirm which suppliers exist.'
		}
	},
	PRODUCTS: {
		TYPED_DRAFT_CREATE: {
			summary: 'Create a typed product with its variants',
			description:
				'ADMIN, opt-in. Atomic visibility through shared gate and journal. Idempotent UUID, typed values, reserved SKU and stable initial URLs. Carries the whole product: description, purchase notice, each variant’s price, stock, weight and photos. Variants are drafts by default; an active one is accepted only for a complete product (409 PRODUCT_NOT_READY with the gaps).'
		},
		TYPED_DRAFT_LIST: {
			summary: 'List products in a v2 draft category',
			description:
				'ADMIN, no-store. category_id required; optional opaque cursor bound to category, revision and epoch, or a 1-based page number (not both); optional q narrows by name over the whole category (literal, case-insensitive). 25 products per page; total counts the matching products.'
		},
		TYPED_DRAFT_READ: {
			summary: 'Read a prepared typed product draft',
			description: 'ADMIN, revision-consistent, no-store; no legacy inference.'
		},
		TYPED_TRANSFER_PREVIEW: {
			summary: 'Preview moving a typed product to another category',
			description:
				'Read-only. Proposes the characteristics carried over (same key, or same label and a compatible type), lists the ones lost, the required values the target still needs and whether the variant axis fits.'
		},
		TYPED_DELETION: {
			summary: 'Видалити товар, якого ще не продавали',
			description:
				'ADMIN, journalled. The product and all its SKUs, only when no SKU is active and nothing points at them (orders, carts, old-address aliases). A single never-sold draft/archived SKU is removed with `variant_action: {type: "delete"}`; `{type: "archive_all"}` archives every SKU at once.'
		},
		TYPED_TRANSFER: {
			summary: 'Move a typed product to another category',
			description:
				'Journalled. The product and all its SKUs change category in one plan; values are checked against the target definitions (all required ones for a published target); `confirm_dropped` must equal the lost keys. URLs, SKU codes, IDs, prices and stock never change; active SKUs moved into a draft category become drafts.'
		},
		TYPED_DRAFT_EDIT: {
			summary: 'Edit typed draft attributes and variant axis',
			description:
				'Opt-in journalled update. Complete editable payload, fixed SKU membership, stable URLs and independent commerce fields.'
		},
		GET_ALL: {
			summary: 'List all products (admin)',
			description:
				'Admin-only, unpaginated list of every product for the admin catalogue screen. Public storefront must use /products/catalog.'
		},
		GET_BY_ID: {
			summary: 'Get product by id (admin)',
			description:
				'Admin-only; returns the raw product document including `vendor_id` — which supplier the product is bought from. The storefront uses /products/by-slug/:slug.'
		},
		CREATE: {
			summary: 'Create product',
			description: 'Create a new product'
		},
		UPDATE: {
			summary: 'Update product',
			description: 'Update an existing product'
		},
		DELETE: {
			summary: 'Delete product',
			description: 'Delete a product'
		},
		VALIDATE: {
			summary: 'Validate slugs and SKUs',
			description:
				'Check which slugs and SKUs are already taken. Returns arrays of taken values.'
		},
		PATCH_VARIANT_IMAGES: {
			summary: 'Set variant images',
			description: 'Replace the images array on a specific product variant.'
		},
		GET_VARIANTS: {
			summary: 'Get product variants (admin)',
			description:
				'Admin-only; returns the full variant documents of a product including supplier identifiers (vendor_product_sku, prom_id).'
		},
		GET_VARIANT: {
			summary: 'Get variant by id (admin)',
			description:
				'Admin-only; returns the full variant document including supplier identifiers (vendor_product_sku, prom_id).'
		},
		ADD_VARIANT: {
			summary: 'Add variant to product',
			description: 'Create a new variant for an existing product.'
		},
		UPDATE_VARIANT: {
			summary: 'Update variant',
			description:
				"Partially update a product variant (price, stock, status, etc.). `promo_percent` / `promo_ends_at` set or clear the variant's promotion (TD-0012): the sale price is derived, never stored; a date without a percent is 400 PROMO_PERCENT_REQUIRED, a date in the past 400 PROMO_ENDS_IN_PAST. A promo write purges the storefront and rebuilds the Merchant feed."
		},
		SET_PROMOTION: {
			summary: 'Set or clear a promotion on every variant of a product',
			description:
				'Admin only (TD-0012). Writes `promo_percent` / `promo_ends_at` to all variants of the product in one update, whatever their status (a draft activated later inherits it). `promo_percent: null` clears the promotion on all of them. Answers `{ matched, modified, variants }` with the full admin variant documents; a product with no variants answers matched 0. Purges the storefront and rebuilds the Merchant feed.'
		},
		DELETE_VARIANT: {
			summary: 'Delete variant',
			description: 'Delete a specific product variant.'
		},
		CATALOG_V2: {
			summary: 'Public typed catalog',
			description:
				'Published SKU across visible category descendants with strict typed filters, stable pagination and self-excluding SKU facets. Draft/archived SKU and hidden branches are excluded.'
		},
		CATALOG_V2_STRIP: {
			summary: 'Product strip: one card per product',
			description:
				'The first cards of the «newest» typed listing under the same scope and filters, one per product — its first SKU there (in stock first, newest first, a curated product_ids list in its own order) — with `group`: the product name, how many of its SKUs match, how many are in stock and on sale, their price range (in-stock SKUs; all of them when none is) and up to 12 dictionary colours, each marked in stock or not. {revision, items}; no page, total or facets. limit ≤ 24 (default 8). The walk reads at most 500 SKUs of the listing, so a strip may be shorter than limit. The storefront «Новинки», «Акції» and collections (owner, 2026-11-14).'
		},
		CATALOG_V2_CATEGORY_COUNTS: {
			summary: 'Active SKUs per visible product category (navigation)',
			description:
				'The category facet of the unfiltered whole-catalogue listing, without its 100-category limit: {revision, categories: [{id, count}] (non-empty only, by id), next_cursor}. Paged by category id (limit ≤ 20 000, ~1 MB); the cursor is bound to the computation — CATEGORY_COUNTS_CHANGED (409) means restart. Counts are kept per tree key and SKU write mark for at most 60 s. The storefront prunes empty navigation branches with it (Plan-0010 D06.5).'
		},
		CATALOG: {
			summary: 'Get catalog products',
			description:
				"Paginated, filterable product listing for a given category. Besides `items` and `pagination` the response carries `facets` — for every key of the category's `required_attributes`, all values present in the category as `{ value, count }`, where `count` is the number of active variants matching every active filter except that dimension's own (so ticking one value never empties its siblings; values no longer reachable stay with `count: 0`). Values are ordered numerically where numeric, otherwise by the Ukrainian collator. `color_options[].count` follows the same rule; `price_range` is category-wide. `filter_options` is deprecated — the same values without counts — and will be removed after the next release."
		},
		SEARCH: {
			summary: 'Search products',
			description:
				'Full-text search across product names, descriptions, and attributes. Also matches variant SKU prefixes. Returns paginated results.'
		},
		VARIANT_SLUGS: {
			summary: 'Get active variant slugs',
			description:
				'Returns slug and updatedAt of every ACTIVE variant for sitemap generation (draft/archived are excluded).'
		},
		VARIANT_COUNT: {
			summary: 'Get active variants count',
			description:
				'Returns the number of ACTIVE product variants — the same set as /variants/slugs (used as the sitemap cache key).'
		},
		PRICE_SHEET: {
			summary: 'Price sheet (variants by category)',
			description:
				'Public paginated list of ACTIVE product variants for the price-sheet table, one category after another (creation order), in each availability first (in stock first), then name. `categories` lists the page’s categories with their columns — the characteristics the catalogue filters them by, colour included — and each row carries `values` for them. Supports `q` search by product name, SKU or attribute value. Response is a fixed public projection — no supplier identifiers. variant_label displays the variant independently of color; `material` is deprecated.'
		},
		PRICE_LIST_PDF: {
			summary: 'Generate wholesale price list PDF (admin)',
			description:
				'Admin-only. Returns an A4 PDF price list of active variants: one table per category with that category’s columns (the characteristics the catalogue filters it by, colour included), rows grouped by product (the product name and product-level values are merged across its variants) and ordered by brand, then product, then variant. Supports filtering by categories and stock. A stock extract: the base price only — wholesale discounts are agreed with the buyer (owner, 2026-11-06).'
		},
		BY_SLUG: {
			summary: 'Get variant by slug',
			description:
				'Public product page payload: the variant and its ACTIVE siblings in the public projection (PUBLIC_VARIANT_FIELDS — no supplier identifiers), the parent product (with `manufacturer` read from the «Виробник» attribute, and every attribute carrying the `unit` its category defines for that key, `null` when there is none) and category. Draft variants respond 404; archived ones respond 200 with `status: archived` so the storefront can render a discontinued page.'
		}
	},
	UPLOAD: {
		PRESIGN: {
			summary: 'Generate presigned upload URLs',
			description:
				'Returns presigned S3 PUT URLs and public URLs for direct client-side upload. URLs expire in 15 minutes.'
		},
		CONFIRM: {
			summary: 'Confirm uploaded files',
			description:
				'Verifies that files were successfully uploaded to S3 via headObject checks.'
		},
		DELETE: {
			summary: 'Delete files from S3',
			description: 'Permanently deletes one or more files from S3 by their keys.'
		}
	},
	CART: {
		GET: {
			summary: 'Get cart',
			description:
				"Returns the current user's cart with populated variant data. Out-of-stock items are automatically removed and listed in removed_items."
		},
		MERGE: {
			summary: 'Merge cart',
			description:
				'Called after login to sync the client-side cart. If the server cart is empty, client items are validated against stock and set. If the server cart already has items, it is returned as-is and the client-side cart is discarded.'
		},
		ADD_ITEM: {
			summary: 'Add item to cart',
			description:
				'Add a variant to the cart. If the variant is already present, its quantity is incremented by the given amount. Stock is validated.'
		},
		UPDATE_ITEM: {
			summary: 'Update cart item quantity',
			description: 'Set the absolute quantity for a specific cart item. Stock is validated.'
		},
		REMOVE_ITEM: {
			summary: 'Remove item from cart',
			description: 'Remove a specific variant from the cart.'
		},
		CLEAR: {
			summary: 'Clear cart',
			description: 'Remove all items from the cart.'
		}
	},
	NOVA_POST: {
		SYNC: {
			summary: 'Sync Nova Post data',
			description:
				'Fetches all cities and warehouses from the Nova Post API and upserts them into the local database. Admin only. Returns counts of processed records.'
		},
		CITIES: {
			summary: 'Search cities',
			description: 'Case-insensitive search for Nova Post cities/settlements by name.'
		},
		WAREHOUSES: {
			summary: 'Get warehouses by city',
			description:
				'Returns Nova Post warehouses for the given city ref. Optional `type` filter: PARCEL_LOCKER (поштомат), BRANCH (відділення — поштові й вантажні разом), POST (лише поштові), CARGO (лише вантажні). Ordered by branch number. Optional `q` (same idea as on `/nova-post/cities`): when non-empty after trim, returns only branches where the substring appears in the warehouse number (string form), `description`, or `shortAddress` — case-insensitive for text, with whitespace normalized in the query and flexible matching between words. When `q` is omitted or only whitespace, returns the full list for `cityRef` + `type` as before.'
		}
	},
	PROM: {
		SYNC_AVAILABILITY: {
			summary: 'Sync product availability and price from Prom',
			description:
				'SSE stream. For each product variant that has a `prom_id`, fetches the product from the Prom public API and updates `stock` from `presence` / `quantity_in_stock`, and `price` as the discounted Prom price plus a fixed tiered markup. Prom withholds the discount for out-of-stock listings, so those variants are repriced from the last discount recorded for them rather than from the bare pre-discount price. A price rise above 15% on a payload with no discount at all is rejected and counted in `priceSkipped`. Emits progress events and a final summary. Admin only.'
		}
	},
	FEEDS: {
		GOOGLE_SHOPPING_XML: {
			summary: 'Google Shopping product feed (public XML)',
			description:
				'RSS 2.0 feed with `g:` attributes for every ACTIVE variant: id (SKU), item_group_id (product), title, description, link, images, availability (`in_stock` / `out_of_stock`), price in UAH, brand from the «Виробник» attribute, google_product_category from the category, product_type refined by the matching landing, colour, material, shipping weight and four custom labels. Excludes variants without images, price or brand. Regenerated on startup and hourly; served from memory. Until the first generation of a process it answers 503 with `Retry-After`, never an empty channel. Register this URL in Merchant Center.'
		},
		GOOGLE_SHOPPING_REGENERATE: {
			summary: 'Regenerate the Google Shopping feed (admin)',
			description:
				'Admin-only, synchronous. Rebuilds the feed from the current catalogue and returns the generation summary: item counts, the excluded variants with their reason, and the soft warnings (missing google_product_category, description, weight, required attribute). 409 while another generation is running.'
		},
		GOOGLE_SHOPPING_STATUS: {
			summary: 'Google Shopping feed status (admin)',
			description:
				'Admin-only. The last generation summary without regenerating, plus whether the XML is ready, whether a generation is running, whether the hourly job is scheduled in this process, the public feed path and the last error if any.'
		}
	},
	ORDERS: {
		CREATE: {
			summary: 'Create order',
			description:
				'Place a new order. Validates stock for each variant, snapshots prices, and can apply a discount coupon by code. User can be authenticated or guest. A stock shortfall answers 409 with a structured body — `code: INSUFFICIENT_STOCK`, `variant_id`, `sku`, `available`, `requested` and a Ukrainian `message` — so the storefront can pin the error to the cart line it is about.'
		},
		MY: {
			summary: 'Get my orders',
			description:
				'Paginated list of orders for the authenticated user with optional filters by order_status and payment_status.'
		},
		MY_BY_ID: {
			summary: 'Get my order by id',
			description:
				'Get full details of a single order that belongs to the authenticated user.'
		},
		LOOKUP: {
			summary: 'Public payment-status lookup',
			description:
				'Returns payment status of an order by its number. Requires the HMAC access token issued with the order (LiqPay result_url / create response). Public endpoint; a wrong token yields 404 so order numbers cannot be probed. Besides the payment fields the response carries `order_status`, `delivery_method` and `can_change_payment_method` — true while the payment is PENDING or FAILED and the order has not shipped (NEW, PROCESSING or CONFIRMED — no TTN yet) — so the storefront can offer the payment-method change without mirroring the rule.'
		},
		LOOKUP_PAYMENT_METHOD: {
			summary: 'Change payment method (public, token)',
			description:
				'Lets the buyer switch an unpaid order (payment PENDING or FAILED, order not yet shipped: NEW, PROCESSING or CONFIRMED) from LiqPay to COD, IBAN or CASH. Same HMAC token as the lookup; a wrong token yields 404. The delivery compatibility rule applies (COD only with NOVA_POST/COURIER, CASH only with PICKUP → 400). A FAILED card payment becomes PENDING. Same method again is a 200 no-op. Locked states answer 409 `code: PAYMENT_METHOD_LOCKED`. Sends the customer the confirmation for the new method and a service email. Rate-limited to 5 requests per minute per IP.'
		},
		MY_PAYMENT_METHOD: {
			summary: 'Change payment method (my order)',
			description:
				'The authenticated counterpart of the public payment-method change for an order that belongs to the current user: same rules, same 409 `PAYMENT_METHOD_LOCKED`, returns the customer order shape.'
		},
		GET_ALL: {
			summary: 'Get all orders',
			description:
				'Paginated list of all orders with optional filters by order_status and payment_status. Admin only.'
		},
		GET_BY_ID: {
			summary: 'Get order by id',
			description:
				'Get full order details by MongoDB id, with `status_history` and `allowed_status_transitions` — the statuses PATCH /orders/:id/status accepts from the current one (TD-0011). Admin only.'
		},
		UPDATE: {
			summary: 'Update order',
			description:
				'Update editable order fields (items, customer, delivery, payment method, comment, manual discount). `items` is a full replacement of the lines: a line that stays keeps its snapshot (unit price, name, SKU) and only follows the new quantity, a new line is priced from the current catalogue; totals and the coupon are recalculated and a `status_history` entry with `field: items` records the change (and, for a paid order, the sum to collect or return). Allowed on a paid order; refused with 409 LIQPAY_SESSION_ACTIVE while a card session is open. Admin only.'
		},
		UPDATE_ORDER_STATUS: {
			summary: 'Update order status',
			description:
				'Change the fulfillment status of an order (TD-0011). Only the transitions listed in `allowed_status_transitions` are accepted; anything else is 409 `INVALID_STATUS_TRANSITION` with `from`, `to` and `allowed`. Before shipping NEW, PROCESSING (buyer contacted, confirmation awaited) and CONFIRMED move freely among themselves. `COMPLETED` is never set by hand (400) — a DELIVERED order becomes COMPLETED once paid; `SHIPPED` is set by the TTN (400 here). Cancelling, or receiving back (`RETURNED`), an unpaid order voids its payment; reopening a cancelled order (`CANCELLED → NEW`) expects payment again. The write is pinned on the statuses read: a concurrent change answers 409 `ORDER_STATUS_CHANGED`. Every change is appended to `status_history` with the admin id. Returns the admin order shape. Admin only.'
		},
		UPDATE_PAYMENT_STATUS: {
			summary: 'Update payment status',
			description:
				'Change the payment status of an order. Optionally record the payment transaction id. Marking a DELIVERED order PAID makes it COMPLETED in the same write; taking PAID away from a COMPLETED order makes it DELIVERED again (TD-0011). Pinned like the status change (409 `ORDER_STATUS_CHANGED`), recorded in `status_history`. Returns the admin order shape. Admin only.'
		},
		SET_TTN: {
			summary: 'Set Nova Post TTN',
			description:
				'Attach the Nova Post tracking number (ТТН) to an order. For an order that has not shipped yet (NEW, PROCESSING, CONFIRMED) — whatever its delivery method, a pickup order with a TTN was posted after all — the same write sets `order_status = SHIPPED` and records it in `status_history` (TD-0011); an order past shipping keeps its status. Resets the tracker fields. Returns the admin order shape. Admin only.'
		},
		GENERATE_INVOICE: {
			summary: 'Generate order invoice PDF',
			description:
				'Generates and returns a PDF invoice for an order. Accepts an optional admin comment and an audience: `internal` (default) includes the supplier article, `customer` omits it. Admin only.'
		},
		SEND_VENDOR_EMAIL: {
			summary: 'Send email to vendor',
			description: 'Sends an email to a vendor regarding an order. Admin only.'
		},
		GENERATE_REPORT: {
			summary: 'Generate sales report',
			description:
				'Generates the finance sales report for a date range with optional status filters: goods sold over the period aggregated by SKU, the register of the orders they came from, and the reconciliation totals (paid vs awaited, breakdowns by payment and delivery, sales per day). Landscape PDF. The date range is read as Kyiv calendar days. Admin only.'
		},
		STATS: {
			summary: 'Orders dashboard statistics',
			description:
				"Figures for the admin dashboard over a period of Kyiv calendar days (`date_from`/`date_to`, default the last 30 days, at most 366): totals and the same for the period of equal length just before it, every day of the period (zero days included), the weekday profile with its per-weekday averages, orders per hour and a weekday × hour heatmap, breakdowns by payment method, delivery method, order status and payment status, and the top 10 variants by revenue and by quantity. `cancelled` is CANCELLED / RETURNING / RETURNED or payment VOIDED / REFUNDED — such an order is counted in `orders` and in the hour/heatmap figures (it was placed) but contributes no revenue and no units. Sale date is the order's `createdAt`. Admin only."
		}
	},
	PAYMENT_DETAILS: {
		GET_ALL: {
			summary: 'Get all payment details',
			description: 'Get all payment details records'
		},
		GET_BY_ID: {
			summary: 'Get payment details by id',
			description: 'Get a single payment details record by id'
		},
		CREATE: {
			summary: 'Create payment details',
			description: 'Create a new payment details record'
		},
		UPDATE: {
			summary: 'Update payment details',
			description: 'Update an existing payment details record'
		},
		DELETE: {
			summary: 'Delete payment details',
			description: 'Delete a payment details record'
		},
		GET_ACTIVE: {
			summary: 'Get active payment details',
			description: 'Returns the currently active payment details record'
		},
		ACTIVATE: {
			summary: 'Activate payment details',
			description:
				'Sets the given record as active and deactivates all others. Only one record can be active at a time.'
		}
	},
	PAYMENT_PROVIDERS: {
		GET_ALL: {
			summary: 'Get all payment providers',
			description:
				'List online payment provider credentials (LiqPay/MonoPay). Private keys are never returned. Admin only.'
		},
		GET_ACTIVE: {
			summary: 'Get active payment provider',
			description:
				'Public endpoint. Returns the active credential set for a provider (without secrets) or null. Used to gate the checkout payment options.'
		},
		GET_BY_ID: {
			summary: 'Get payment provider by id',
			description: 'Get a single payment provider record (without secrets). Admin only.'
		},
		CREATE: {
			summary: 'Create payment provider',
			description:
				'Create a payment provider credential set. The private key is encrypted at rest. Admin only.'
		},
		UPDATE: {
			summary: 'Update payment provider',
			description:
				'Update a payment provider. Provide private_key only when rotating it. Admin only.'
		},
		DELETE: {
			summary: 'Delete payment provider',
			description: 'Delete a payment provider credential set. Admin only.'
		},
		ACTIVATE: {
			summary: 'Activate payment provider',
			description:
				'Sets the record active and deactivates other records of the same provider. Admin only.'
		}
	},
	LIQPAY: {
		CHECKOUT: {
			summary: 'Init LiqPay checkout',
			description:
				'Builds the signed LiqPay checkout payload (data + signature) for an existing LiqPay order whose payment is PENDING or FAILED. Public endpoint. While the payment is PENDING, a second call within 15 minutes of the previous one answers 409 `code: LIQPAY_SESSION_ACTIVE` with `retry_after_seconds` — the first session may still complete, and two live sessions is how a buyer is charged twice. A FAILED payment may be retried at once.'
		},
		CALLBACK: {
			summary: 'LiqPay server callback',
			description:
				'Server-to-server payment callback from LiqPay. Verifies the signature and updates the order payment status. Public endpoint.'
		}
	},
	WHOLESALE_INQUIRIES: {
		CREATE: {
			summary: 'Submit wholesale inquiry',
			description:
				'Submit a wholesale/bulk purchase inquiry form. Public endpoint — no authentication required.'
		},
		GET_ALL: {
			summary: 'Get all wholesale inquiries',
			description:
				'Paginated list of wholesale inquiries with optional status filter. Admin only.'
		},
		UPDATE_STATUS: {
			summary: 'Update wholesale inquiry status',
			description: 'Update the processing status of a wholesale inquiry. Admin only.'
		}
	},
	DISCOUNT_COUPONS: {
		GET_ALL: {
			summary: 'Get all discount coupons',
			description:
				'Get paginated discount coupons with optional filters by active flag and code search query. Admin only.'
		},
		GET_BY_ID: {
			summary: 'Get discount coupon by id',
			description: 'Get discount coupon details by MongoDB id. Admin only.'
		},
		CREATE: {
			summary: 'Create discount coupon',
			description:
				'Create a discount coupon with internal number in DIS-0000123 format and random 10-character code (A-Z, 0-9). Admin only.'
		},
		VALIDATE: {
			summary: 'Validate discount coupon',
			description:
				'Validate coupon code for checkout. Returns validity, and for valid coupons returns discount details.'
		},
		UPDATE: {
			summary: 'Update discount coupon',
			description:
				'Update discount coupon fields (discount percent, expiration, active flag). Admin only.'
		},
		DELETE: {
			summary: 'Delete discount coupon',
			description: 'Delete discount coupon by id. Admin only.'
		}
	}
} as const

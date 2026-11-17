# Partner API — каталог і наявність

Реалізовано локально; перед передачею партнерам потрібен деплой BE + FE.

Адмінка: `/admin/api-tokens`. Вкажіть назву партнера, створіть токен,
скопіюйте його та передайте захищеним каналом. Токен відображається один раз;
у базі зберігається лише SHA-256. Список містить префікс і дату використання
(оновлюється з точністю до хвилини). Відкликання незворотне: для поновлення
доступу створіть новий токен. Для ротації створіть новий, переведіть інтеграцію,
після цього відкличте попередній.

Публічний Swagger: `<PUBLIC_API_URL>/partner-docs`.
OpenAPI JSON: `<PUBLIC_API_URL>/partner-openapi.json`.
`PUBLIC_API_URL` — повна зовнішня адреса backend із proxy-префіксом, якщо він є.
Swagger використовує саме її для Try it out; локально, наприклад,
`http://localhost:3000/partner-docs`. В адмінці є пряме посилання на Swagger.
У документі лише партнерські ендпойнти; внутрішній `/swagger` лишається окремим.

```bash
# Локальний приклад; для продакшену замініть адресу на PUBLIC_API_URL.
export FILLANDO_API_URL='http://localhost:3000'
# FILLANDO_API_TOKEN задайте зі сховища секретів інтеграції.
curl --fail-with-body "$FILLANDO_API_URL/partner/v1/products/FL-000123/availability" \
  -H "Authorization: Bearer $FILLANDO_API_TOKEN"
```

```json
{
  "sku": "FL-000123",
  "in_stock": true,
  "quantity": 12,
  "stock_updated_at": "2026-09-12T00:00:00.000Z"
}
```

Артикул — точний, чутливий до регістру внутрішній SKU Fillando (не артикул
постачальника). Кодуйте його як URL path segment. `quantity` — кількість одиниць,
мінімум 0; `in_stock` дорівнює `quantity > 0`. `stock_updated_at` — остання
відома дата оновлення залишку або null, не час поточного запиту. Залишки
довідкові: API не резервує товар і не гарантує кількість на момент замовлення.
Ціни не входять у відповіді наявності; роздрібна ціна доступна в lookup. Дані постачальника та внутрішні ідентифікатори товарів не експортуються.

| HTTP | Значення |
|---|---|
| 200 | Знайдено активний товар, включно з нульовим залишком |
| 400 | Артикул порожній або довший за 100 символів |
| 401 | Токен відсутній, некоректний або відкликаний |
| 404 | Артикул не існує або товар неактивний |
| 429 | Перевищено ліміт; повторити через `Retry-After` секунд |

Спільний для всіх партнерських ендпойнтів ліміт 60 запитів/хв на токен, додатково 300/хв на IP (разом із невдалими
спробами авторизації). Заголовки `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset`; `Retry-After` на 429. Ліміти in-memory на один процес:
при масштабуванні потрібно спільне сховище. Відповідь має `Cache-Control: no-store`.

Токен призначений для серверних інтеграцій, зберігайте його як секрет і
використовуйте HTTPS у production. Cookie магазину не замінюють токен.
У межах v1 поля можуть додаватися; видалення чи зміна значення існуючих полів
потребує нової версії. Клієнтам слід ігнорувати невідомі поля.

Адмінські API (JWT-cookie + ADMIN): GET/POST `/admin/api-tokens`,
DELETE `/admin/api-tokens/:id` (ідемпотентне відкликання, 204).
Партнерський токен не дає доступу до них. Нова колекція створюється Mongoose;
для `token_hash` потрібен unique index (перевірити, якщо autoIndex вимкнено).
`yarn spec:export` експортує `openapi.json` і `openapi-partner.json`
без підключення до бази через Nest preview mode.

## Пакетна перевірка

`POST /partner/v1/products/availability`, той самий Bearer-токен.

```bash
curl --fail-with-body "$FILLANDO_API_URL/partner/v1/products/availability" \
  -H "Authorization: Bearer $FILLANDO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"skus":["FL-000123","FL-000124","FL-UNKNOWN"]}'
```

```json
{
  "items": [
    {"sku":"FL-000123","in_stock":true,"quantity":12,"stock_updated_at":"2026-09-12T00:00:00.000Z"},
    {"sku":"FL-000124","in_stock":false,"quantity":0,"stock_updated_at":null}
  ],
  "not_found": ["FL-UNKNOWN"]
}
```

`skus` — обов'язковий масив від 1 до 100 рядків, кожен від 1 до 100 символів.
Ліміт перевіряється до об'єднання повторів. Некоректне тіло → 400.
Артикули порівнюються точно, з урахуванням регістру, без обрізання пробілів.
Повтори повертаються лише один раз; порядок у кожному списку відповідає
першій появі артикулу в запиті. Невідомі, draft та archived варіанти — у
`not_found`. Активний товар із нульовим залишком залишається в `items`.
Валідний запит повертає **200**, навіть якщо `items` порожній. Відповідь
побудована одним запитом до бази; поля кожного item такі самі, як у GET.
Пакет рахується як один запит у спільному ліміті, незалежно від кількості SKU.
401/429 та Cache-Control: no-store діють так само, як для одиничної перевірки.

## Початкове завантаження каталогу

Усі три ендпойнти використовують той самий Bearer-токен, спільні ліміти
60/хв/токен і 300/хв/IP та `Cache-Control: no-store`.

### 1. Категорії

`POST /partner/v1/categories` із JSON-тілом `{}` → 200, масив:

```json
[
  {"id":"000000000000000000000001","name":"Філамент","slug":"filament","parent_id":null,"sku_count":125}
]
```

Категорії плоскі, `parent_id` наразі завжди null. Порожні категорії включено
зі `sku_count: 0`. Кількість означає артикули/варіанти, а не батьківські товари.
Порядок відповідає налаштуванню категорій магазину (зі стабільним ID як другим
ключем сортування). Кількість — поточна, вона може змінитися до вивантаження.

### 2. Артикули

`POST /partner/v1/products/skus` із JSON-тілом:

```json
{"category_id":null,"cursor":null,"limit":100}
```

Цей приклад працює без підстановок після Authorize у Swagger: null означає всі категорії та першу сторінку. Для фільтрації візьміть справжній id з відповіді категорій. Також можна передати `{"limit":100}` або `{}`. Для наступної сторінки додайте
`"cursor":"<next_cursor з попередньої відповіді>"`, зберігши category_id.
`limit` у JSON має бути числом, не рядком. Авторизація — той самий Bearer-токен.
Категорії та список артикулів доступні лише через POST із JSON body; GET-маршрути видалено.

Відповідь:

```json
{"items":["FL-000123","FL-000124"],"next_cursor":null}
```

- `category_id` необов'язковий: без нього — весь доступний каталог.
  Некоректний ID → 400, неіснуюча категорія → 404, порожня категорія → 200.
- `limit`: ціле число 1–100, типово 100.
- Якщо `next_cursor` не null, передайте його наступним запитом як `cursor`,
  зберігши той самий `category_id` (або його відсутність).
  Курсор непрозорий, не змінюйте й не декодуйте його у клієнті.
  Некоректний або використаний з іншою категорією курсор → 400.
- Сортування лексикографічне за SKU, із врахуванням регістру. Підкатегорій немає.
- `next_cursor: null` означає завершення. Це не зафіксований знімок: зміни
  асортименту під час обходу можуть потребувати повторної повної синхронізації.

### 3. Картки товарів

`POST /partner/v1/products/lookup` з тілом `{"skus":["FL-000123","FL-UNKNOWN"]}`.
Ті самі правила списку, що для пакетної наявності: 1–100 рядків по 1–100 символів,
точний регістр, повтори об'єднуються, порядок першої появи зберігається.

```json
{
  "items": [{
    "sku":"FL-000123",
    "name":"PLA — Чорний (Black)",
    "price":599.5,
    "sale_price":null,
    "currency":"UAH",
    "description_html":"<p>Філамент для 3D-друку.</p>",
    "category":{"id":"000000000000000000000001","name":"Філамент","slug":"filament"},
    "attributes":[{"key":"polymer","label":"Тип пластику","value":"PLA"}],
    "variant":{"key":"color","label":"Колір","value":"Black"},
    "images":["https://example.invalid/product.jpg"],
    "url":"https://fillando.com/products/pla-black",
    "weight_g":1200,
    "availability":{"sku":"FL-000123","in_stock":true,"quantity":12,"stock_updated_at":null}
  }],
  "not_found":["FL-UNKNOWN"]
}
```

`description_html`, `variant`, `weight_g` можуть бути null. Вага — для доставки
в грамах; непозитивна/невідома вага → null. `attributes` і `images` можуть бути
порожніми. Значення характеристики зберігає тип string/number/boolean; наприклад
false не перетворюється на порожній рядок. `variant` описує саме запитаний варіант.
`url` будується на базі налаштованого `FRONTEND_URL`.
Дані постачальника, Prom, редакторський JSON та внутрішні ID товарів
не входять у відповідь. ID категорії публічний і потрібний для фільтрації.

Категорійні лічильники, список SKU та lookup використовують однакові критерії:
active-варіант, наявні товар і категорія, категорія варіанта збігається з категорією
товару. Пошкоджені зв'язки не включаються у вивантаження. У lookup недоступні,
неактивні та невідомі артикули повертаються в `not_found`. Навіть якщо всі артикули
не знайдено — 200 із порожнім items. Картки завантажуються одним агрегатним запитом.

Рекомендований цикл: отримати категорії → пройти сторінки SKU → викликати lookup
пакетами → надалі оновлювати наявність пакетним endpoint. Для нового або зміненого
асортименту повторювати обхід каталогу; incremental-синхронізації карток поки немає.

Кожна картка lookup містить `price` — поточну роздрібну ціну одиниці
з ProductVariant.price, у гривнях (не копійках), та `currency: "UAH"`. Поруч — `sale_price`:
ціна за акцією магазину, якщо вона зараз діє (TD-0012), інакше `null`; `price` при цьому лишається
регулярною ціною.
Дробова частина зберігається; це довідкова ціна без фіксації на період.
Індивідуальні дилерські знижки не застосовуються.

## Local Plan-0010 catalog read barrier

All five public catalog/availability handlers now use the catalog read barrier,
including read-only POST requests. Existing token/IP/token-quota guards execute
first; token administration endpoints are unaffected. A busy/changed catalog or
incompatible v2 data returns JSON 503 with `details.code`, `Retry-After: 5` and
`Cache-Control: no-store`. Successful payloads retain their existing contract.

This brackets one HTTP request, not a complete paginated export. Revision-bound
partner cursors and v2 definitions/visibility adapters remain pending. Direct
service calls do not inherit the HTTP interceptor. After a transition, restart
pagination; this version does not add automatic revision negotiation to clients.

## Adapted reads across the catalogue transition (local Plan-0010 B11, 2026-10-28)

The five handlers are now adapted reads (`@CatalogAdaptedRead`): the maintenance/revision/epoch
barrier above stays, but v2 data no longer answers `CATALOG_READ_UPGRADE_REQUIRED`. What a partner
sees is decided by the public category projection (`CategoryPublicReadService`) — an active product
category whose every ancestor is active:

| Read | Rule |
|---|---|
| `POST /categories` | Visible **product** categories only, still flat (`parent_id: null`); a group holds no SKUs and is not listed. Same `(order, _id)` order, counts of exportable active SKUs. |
| `POST /products/skus` | SKUs of visible categories; a group, hidden or unknown `category_id` is 404. |
| `POST /products/lookup` | SKUs of visible categories; a draft/hidden SKU is in `not_found`. |
| `POST /products/availability`, `GET /products/:sku/availability` | SKUs of visible categories only (hidden → `not_found` / 404). |

A v2 product answers in the frozen v1 card shape through `legacyShapeOf`
(`modules/product/typed-legacy-shape.ts`, shared with the PDF and the price sheet):

- `attributes` — every characteristic in its stored order, the definition's label, the value as text
  (enum option label, «Так»/«Ні», a number as written, e.g. `"1.75"`). Nothing is hidden: the export
  never hid «Матеріал»/«Виробник», and `visible_in_specs` decides only the product page's table (one
  visibility switch, owner 2026-11-05 — there is no «internal note» characteristic). A linked active
  brand entity comes first as `{ key: 'brand', label: 'Виробник' }`.
- `variant` — a colour axis keeps the v1 identity: key `kolir` (derived from its label, the v2 key
  `color` is internal), value = dictionary `name_en` from `v_value` («Black»). Any other axis keeps
  its own key and formatted value («63 А»); it is never sent as a colour.

- **«Колір» row of a colour-axis SKU** (owner decision 2026-10-28, `withAxisColourRow`): the
  legacy cards carried a product-level «Колір» characteristic — one stale copy for every SKU of
  the product. The migration does not carry that copy over; the partner card instead lists the
  SKU's **own** dictionary colour (`name_uk`) as `{ key: 'kolir', label: 'Колір' }`, at the place the
  legacy rollback image had it (after the same preceding characteristic; last for a product created
  in the new admin). Any stored row with that key is replaced. The PDF and the price sheet never
  printed this row and are unaffected.

Rehearsal on the 27.10 production dump (all 301 filament SKUs, before vs after the migration):
categories, SKU enumeration and availability byte-identical; 31 cards identical (8 without an axis,
23 whose legacy copy already named the SKU's own colour); 270 cards differ only by the value of the
«Колір» row — keys, labels, order and `variant` unchanged, and in every one the new value is the
colour in the SKU's own name (legacy: 267 named a sibling's colour, 3 an English/short spelling such
as «Candy», «TR-1»). The format for the two active partner integrations does not change.

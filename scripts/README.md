# Скрипти обслуговування

## Поточні інструменти

| Скрипт | Призначення | Запуск |
| --- | --- | --- |
| `export-spec.ts` | Експорт контракту API після зміни DTO/endpoint | `yarn spec:export` |
| `catalog-recover.cjs` | Відновлення перерваної операції нової адмінки (каталог закритий, читання й checkout — 503): `inspect` / `resume` / `rollback` за журналом | Розділ «Відновлення перерваної операції» нижче |
| `local-catalog-workspace.cjs` | Лише локально: робоча v2-копія для стенда й вхід адміна (пароль у `.local/`, gitignored) | meta `docs/runbooks/local-mongodb.md` |
| `catalog-audit.cjs` | Read-only інвентаризація TD-0013: ключі, зв’язки, дублікати та кандидати URL | `node scripts/catalog-audit.cjs --local` або `--input snapshot.json` |
| `shipping-rates.js` | Оновлення тарифів Нової пошти; результат у `shipping-rates.json` | `yarn shipping:rates` |
| `scraper/scraper.js` | Завантаження фотографій через Prom API за списком `scraper/articles.txt` | `yarn scrape` |
| `migrations/category-attribute-requiredness.js` | Повна перевірка `is_required`, журнал і відкат останньої міграції | [Інструкція](migrations/category-attribute-requiredness.md) |
| `migrations/generate-image-derivatives.js` | Створення та перевірка розмірів зображень у S3 перед увімкненням image loader | [Файли й зображення](../src/docs/FILE_UPLOAD.md) |
| `migrations/convert-s3-images-to-webp.js` | Конвертація історичних JPEG/PNG у WebP | Прапорці описані на початку скрипту |
| `migrations/backfill-prom-discount-ratio.js` | Виправлення історичних цін і початкових discount ratio | Порядок і dry-run описані на початку скрипту |
| `migrations/backfill-voided-payment-status.js` | Виправлення платіжного статусу історичних скасованих замовлень | Спочатку `node scripts/migrations/backfill-voided-payment-status.js --dry-run` |

Збережені міграції не є командою «запустити все»: кожна має окрему ціль і порядок застосування.

### Аудит перед універсальним каталогом

`catalog-audit.cjs` нічого не змінює й не читає `.env`. `--local` підключається
лише до `mongodb://127.0.0.1:27019/fillando`; довільного URI або production-режиму немає.
Під час локального запуску зупиніть редагування каталогу: послідовні read-запити
не є транзакційним snapshot. `--input` читає один JSON-об’єкт із п’ятьма масивами
`categories`, `products`, `product_variants`, `landings`, `colors`; підтримує
рядкові ID та Extended JSON `{ "$oid": "…" }`. Це не BSON-дамп.

Звіт у stdout містить counts, findings та **кандидати** перенаправлень. Він не
підтверджує індексацію, не включає query/зовнішні URL і не запускає міграцію.
Локальні результати зберігайте у `.local/` або `/tmp`, не комітьте дані магазину.
Коди завершення: `0` — перевірені правила без findings, `2` — потрібний розбір
findings (зокрема порожня база), `1` — некоректний snapshot або помилка читання.
Unregistered attributes та коми можуть бути допустимими історичними даними;
скрипт їх не виправляє. Перевірка не є повною валідацією кожного поля товару.

Тести: `node --test scripts/catalog-audit.test.cjs` (без БД й зовнішніх API).
Підтвердження завершення всіх міграцій зображень, цін та історичних замовлень відсутнє, тому їх збережено.
`category-attribute-requiredness` лишається потрібною для перевірки й відкату вже виконаної міграції.

Photo scraper завантажує файли, а не синхронізує ціни/наявність і не пише в базу.
Перед запуском перевірити `articles.txt` і `OUTPUT_DIR` у скрипті: каталог призначення налаштовано вручну.
`report.json` — локальний результат, виключений із Git.

## Видалені одноразові інструменти

2026-09-11 прибрано:

- `scripts/fillando_v_2/` повністю: завершений перехід каталогу, словники міграції, runner, rehearsal і перевірки старого стану. Тести, які перевіряли лише ці скрипти, також видалено. Поточний каталог і його словники зберігаються у MongoDB; для нової бази використовувати актуальний дамп.
- `scripts/AvailabilityCheck/`: старі HTML-скрапери наявності, цін і одноразове визначення Prom ID. Синхронізацію виконує [модуль Prom](../src/docs/PROM_AVAILABILITY_SYNC.md), `prom_id` задається у формі варіанта.
- `migrations/flatten-categories.js` і `migrations/add-variant-timestamps.js`: завершені переходи до поточної моделі.
- Згенерований `scraper/report.json` та команди `yarn migrate*`, що викликали старий каталог скриптів.

Історичний код і тести доступні в Git бекенду на коміті
`c091e43dcabab0e287f0079545e3ab133a6da5f2` (до очищення), наприклад:

```sh
git show c091e43dcabab0e287f0079545e3ab133a6da5f2:scripts/fillando_v_2/README.md
```

Потреба відновити дуже старий дамп — окремий процес у відокремленій копії цього коміту.
Не запускати старий ланцюжок поверх актуальної production-бази: він містить фіксовані
назви, SKU й правила перехідного каталогу та не враховує новий контракт `is_required`.

Локальні звіти та журнали попередніх запусків збережено в
`.local/migration-archives/2026-09-11-script-retirement/`. Це локальні файли, не частина Git;
резервні копії в БД і production-дані під час очищення не змінювалися.

### General catalogue staging (local rehearsal only)

`node scripts/catalog-stage.cjs dry-run fillando_rehearsal_work_YYYYMMDD OPERATION_ID`
prints plan counts/hash. `apply` requires the same arguments and `--writers-stopped`;
`inspect` is read-only. `resume` / `rollback` continue an unfinished journal operation
and require `--writers-stopped`. Stop/isolate all writers before any write command.
The CLI fixes Mongo to localhost:27019, rejects baseline/production database names,
and never loads dotenv or starts application jobs. The presentation it stages is the v1 part of
the migration's own (`catalog-v2-migration.filament.json` → `presentation`), so the two cannot drift.
It stages definitions/values with contract version 1,
verifies fingerprints of all original collections, and does not activate v2 or routes.
Maximum 500 targets/8 MiB; do not use as a production migration command.


Category workspace browser rehearsal: see `src/docs/CATEGORY_TREE.md`.
`test/category-workspace-server.ts` is a loopback-only fixture launched by the sibling
frontend's `playwright.categories.config.ts`, not a production service or migration.

### Міграція категорії v1 → v2 і випуск (Plan-0010 B04, D08)

`catalog-v2-migrate.cjs` переводить одну плоску v1 товарну категорію на v2 на місці
через writer gate і журнал (профіль `migration`); без dotenv і jobs.
Mapping — явний файл (`catalog-v2-migration.filament.json`): необов’язковий ключ виробника →
brand-сутність (`brand_key`; для філаменту `null` — «Виробник» лишається характеристикою за
рішенням власника), числові ключі, вісь кольору
(`semantic: color`, значення = id словника), копії осі на рівні товару, presentation —
разом із попередженнями за значенням (`attribute_notes`: для філаменту — рефіл, з позначкою
«Без котушки»), щоб попередження рефілу після міграції лишилось на картці (Plan-0010 F08). Ключ
попередження, якого немає серед визначень, зупиняє план (`PRESENTATION_UNKNOWN_KEY`). Зв’язок
«рефіл ↔ на котушці» прибрано (власник, 04.11.2026): legacy `spooled_product_id` міграція не
читає й `relations` не пише.

**Ціль — `DATABASE_URL` бекенду** (рішення власника 02.11.2026): з оточення, інакше з `fillando-be/.env`,
як читає сам застосунок. Назва бази в команді має збігатися з базою в URI. Локальний сервер
(`127.0.0.1` / `localhost`) — локальний режим, будь-яка база, зокрема ваша `fillando-prod` на 27019; віддалений —
лише з `--production`.

```bash
node scripts/catalog-v2-migrate.cjs dry-run fillando_catalog_local_v2 <op-id>
node scripts/catalog-v2-migrate.cjs apply   fillando_catalog_local_v2 <op-id> --writers-stopped
node scripts/catalog-v2-migrate.cjs inspect fillando_catalog_local_v2 <op-id>
node scripts/catalog-v2-migrate.cjs resume|rollback fillando_catalog_local_v2 <op-id> --writers-stopped
```

**Production-режим** (`--production`, спільний захист — `catalog-cli-target.cjs`; обов'язковий для
віддаленого сервера, на локальному — репетиція того самого шляху): база лише `fillando-prod`, кожен запис — з `--confirm=<команда>:fillando-prod:<op-id>`,
`apply` — з `--backup-manifest=` перевіреного backup, `resume/rollback` — з маніфестом того
самого архіву, що записаний у `catalog_stage_runs`. Маніфест створює read-only команда
`backup-manifest` з відновленої в локальну базу копії:

```bash
node scripts/catalog-v2-migrate.cjs backup-manifest fillando_release_check_YYYYMMDD --archive=<path>
node scripts/catalog-v2-migrate.cjs apply fillando-prod <op-id> --production \
  --writers-stopped --confirm=apply:fillando-prod:<op-id> --backup-manifest=<path>.manifest.json
```

Маніфест (0600): шлях, розмір і SHA-256 архіву, час перевірки restore (для `apply` — не старше
24 год), кількості документів і знімок (`count` + SHA-256 BSON усіх документів) колекцій
каталогу. `apply` вимагає, щоб знімок живої бази побайтово збігався зі знімком backup — інакше
`BACKUP_DOES_NOT_MATCH_CATALOG` (writer ще працює або backup інший), і нічого не пишеться.

Пише лише additive v2-поля; legacy `required_attributes`, `attributes`, `variant_type`,
`v_value`, `color_id/color_family`, landing `filters`, назви, slug, SKU, ціни й залишки
не змінюються (fingerprint до/після). Якщо план відмовлено до запису (`RECOVERY_CONFLICT` з
переліком цілей), gate звільняється (`abortBeforeWrites`). Захоплену операцію без збереженого плану
звільняє `rollback <op-id>` (`aborted_before_writes`). Відкату завершеної міграції на місці немає
(`revert` прибрано, рішення власника 06.11.2026): невдалий реліз відкочується відновленням каталогу
з бекапу релізу (meta `docs/runbooks/catalog-v2-release.md` §5).
Після apply очистити кеші вітрини (categories, products, landings): CLI їх не чистить.

`catalog-admin-writes.cjs status|enable|disable <база> [--production --confirm=<команда>:fillando-prod]`
вмикає записи нової адмінки (`catalog_control.admin_draft_writes_enabled`) після міграції:
ідемпотентно, стан до/після, `enable` лише за наявного `catalog_control` і `phase: idle`.

Тести: `node --test scripts/catalog-cli-target.test.cjs` (без БД: режими, підтвердження,
маніфест); `src/modules/catalog-safety/catalog-release-cli.int-spec.ts` (обидва CLI як дочірні
процеси в production-режимі на тестовій Mongo: dry-run, відмова за розбіжності/старого backup,
apply, перемикач, відновлення лише з маніфестом бекапу, записаного в операції).

Репетиції на копії дампу 27.10 (історія; команду `revert`, яку вони перевіряли, прибрано 06.11.2026):
28.10.2026 — apply 2,7 с локально / 4,9 с у production-режимі
(окремий тимчасовий MongoDB з копією під назвою `fillando-prod`), revert 2,4–2,5 с; після revert
усі колекції дампу побайтово збігаються з еталоном. 29.10.2026 повторено в production-режимі з mapping
28.10 (зв’язок рефілу, попередження й «на котушці»): dry-run 360 цілей, зв’язки 1/1/0; apply 2,5 с;
правка опублікованого філаменту новою адмінкою (підпис і назва) → `revert` відмовив з
`categories:<id>:attribute_definitions` і звільненим gate → значення повернуто → `revert-2` 2,2 с →
19 колекцій / 67 002 документи побайтово = еталону. Рунбук випуску — meta
`docs/runbooks/catalog-v2-release.md`.

### Відновлення перерваної операції нової адмінки (аудит 31.10.2026)

Writer, що впав після першого доменного запису (або процес, що зупинився посеред збереження), лишає
`catalog_control` закритим (`writing` / `recovery_required` / `recovering` / `published`): усі
читання каталогу й checkout відповідають 503. Відмова до першого запису звільняє gate сама
(`afterFailedWrite`). Решту завершує `catalog-recover.cjs` — для будь-якої операції HTTP-адмінки
(категорії, товари, лендінги, кольори, адреси, вітрина); міграцію й staging — їхні власні CLI.
Спершу зупинити всіх writers (API, cron, Prom sync): відновлення перебирає операцію і не
огороджує живий процес.

```bash
node scripts/catalog-recover.cjs inspect fillando_catalog_local_v2            # стан gate + журнал поточної операції
node scripts/catalog-recover.cjs rollback fillando_catalog_local_v2 <op-id> --writers-stopped
node scripts/catalog-recover.cjs inspect fillando-prod --production
node scripts/catalog-recover.cjs rollback fillando-prod <op-id> --production \
  --writers-stopped --confirm=rollback:fillando-prod:<op-id>
```

`rollback` повертає кожну ціль до before-image журналу, `resume` доводить збереження до after-image;
gate відкривається лише після перевірки всіх цілей (і дерева, якщо змінювались категорії). Нічого не
записано → gate звільняється (`aborted_before_writes`); збій між публікацією й відкриттям →
`publication_reconciled`; завершена операція → `already_finished`. Власника операції (токен) CLI не
друкує. Після відновлення — запустити API (фід перебудовується при старті) й очистити кеші вітрини.
Тести: `src/modules/catalog-safety/catalog-recover-cli.int-spec.ts`, `scripts/catalog-cli-target.test.cjs`.


# Скрипти обслуговування

## Поточні інструменти

| Скрипт | Призначення | Запуск |
| --- | --- | --- |
| `export-spec.ts` | Експорт контракту API після зміни DTO/endpoint | `yarn spec:export` |
| `shipping-rates.js` | Оновлення тарифів Нової пошти; результат у `shipping-rates.json` | `yarn shipping:rates` |
| `scraper/scraper.js` | Завантаження фотографій через Prom API за списком `scraper/articles.txt` | `yarn scrape` |
| `migrations/category-attribute-requiredness.js` | Повна перевірка `is_required`, журнал і відкат останньої міграції | [Інструкція](migrations/category-attribute-requiredness.md) |
| `migrations/generate-image-derivatives.js` | Створення та перевірка розмірів зображень у S3 перед увімкненням image loader | [Файли й зображення](../src/docs/FILE_UPLOAD.md) |
| `migrations/convert-s3-images-to-webp.js` | Конвертація історичних JPEG/PNG у WebP | Прапорці описані на початку скрипту |
| `migrations/backfill-prom-discount-ratio.js` | Виправлення історичних цін і початкових discount ratio | Порядок і dry-run описані на початку скрипту |
| `migrations/backfill-voided-payment-status.js` | Виправлення платіжного статусу історичних скасованих замовлень | Спочатку `node scripts/migrations/backfill-voided-payment-status.js --dry-run` |

Збережені міграції не є командою «запустити все»: кожна має окрему ціль і порядок застосування.
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

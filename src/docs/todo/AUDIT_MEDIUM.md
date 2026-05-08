# MEDIUM — Аудит якості коду та надійності

## 14. Google OAuth не валідує дані профілю

**Файл:** `src/common/strategies/google.strategy.ts` (рядки 17-26)

**Проблема:**

- `emails?.[0]?.value` може бути `undefined` — користувач створюється без email
- `name` може стати `"undefined undefined"` якщо Google не надає ім'я
- Немає error handling для malformed профілю

**Виправлення:**

```typescript
if (!emails || !emails[0]?.value) {
	throw new UnauthorizedException('Google profile missing email')
}
const fullName = `${name?.givenName ?? ''} ${name?.familyName ?? ''}`.trim() || 'Google User'
```

---

## 15. Відсутні індекси на часті запити

**Файли:** всі schema файли в `src/database/mongoose/schemas/`

**Відсутні індекси:**

| Schema       | Поле                  | Причина                                        |
| ------------ | --------------------- | ---------------------------------------------- |
| User         | `createdAt`           | Сортування за датою                            |
| Product      | `vendor_id`           | Фільтр продуктів за вендором                   |
| Product      | `category_id`         | Фільтр продуктів за категорією                 |
| Product      | `createdAt`           | Сортування за датою                            |
| Order        | `createdAt`           | Сортування замовлень (використовується в repo) |
| Order        | `user_id + createdAt` | Composite для історії замовлень юзера          |
| RefreshToken | `userId`              | Пошук всіх токенів юзера                       |
| RefreshToken | `expiresAt` (TTL)     | Автоочистка expired токенів                    |
| Cart         | `updatedAt`           | Визначення неактивних кошиків                  |

---

## 16. Mongoose Exception Filter — неповний

**Файл:** `src/database/mongoose/mongoose.filter.ts`

**Проблема:**

- Ловить лише `code 11000` (duplicate key)
- Не обробляє: validation errors (121), timeout, connection errors
- Без логування оригінальної помилки
- Інші MongoDB помилки пролітають без обробки

**Виправлення:**

- Додати обробку code 121 (document validation)
- Додати логування через Logger
- Повертати структуровані помилки `{ error, field, message }`

---

## 17. `as any` type casts

**Файли:**

- `src/modules/auth/auth.service.ts:142` — `userId as any`
- `src/modules/product/product.service.ts:95`
- `src/modules/category/category.service.ts:82`
- `src/modules/order/order.service.ts:68-70`
- `src/database/mongoose/repositories/product-variant.repository.ts:30`

**Виправлення:**

- Замінити на proper TypeScript types
- `userId as any` → `new Types.ObjectId(userId)`
- Типізувати filter objects у репозиторіях

---

## 18. Email fire-and-forget без retry

**Файл:** `src/modules/order/order.service.ts` (рядки 249-266)

**Проблема:**

- Email надсилається через `.catch()` без retry/queue
- Якщо Resend API недоступний — клієнт не отримає підтвердження замовлення
- Немає dead letter queue або tracking delivery status

**Виправлення:**

- Використати job queue (Bull/BullMQ) для email delivery
- Додати exponential backoff retry (3 спроби)
- Трекати статус доставки email

---

## 19. S3 key validation відсутня

**Файл:** `src/modules/upload/upload.service.ts`

**Проблема:**

- `deleteFiles()` приймає довільні S3 ключі від клієнта
- Користувач може видалити файли інших користувачів якщо знає/вгадає ключ

**Виправлення:**

- Валідувати що S3 ключ належить сутності поточного користувача
- Перевіряти ownership перед видаленням

---

## 20. Відсутній soft delete

**Проблема:**

- Всі схеми використовують hard delete — дані видаляються назавжди
- Критично для: orders (юридична вимога), users (audit trail), products (історія)

**Виправлення:**

- Додати `deletedAt: Date | null` поле до критичних схем (Order, User, Product)
- Додати `isDeleted: boolean` або використовувати mongoose-delete plugin
- Фільтрувати deleted документи у всіх findAll/findOne запитах

---

## 21. Numbers schema — single point of failure

**Файл:** `src/database/mongoose/schemas/numbers.schema.ts`

**Проблема:**

- Один документ для лічильників SKU/order/discount_coupon
- Якщо видалений випадково — всі лічильники скидаються до 0
- Дублювання ID можливе

**Виправлення:**

- Додати seed/migration що гарантує існування документа
- Або розділити на окремі документи per counter type
- Додати validation в `increment()` що документ існує

---

## 22. Відсутній `@MaxLength()` на string полях DTOs

**Файли:**

- `src/modules/vendor/dto/create-vendor.dto.ts` — `name`, `slug`
- `src/modules/order/dto/create-order.dto.ts` — `comment`
- `src/modules/users/dto/update-me.dto.ts` — `name`, `picture`
- `src/modules/product/dto/create-product.dto.ts` — `name`

**Виправлення:**

- Додати `@MaxLength(255)` на всі string поля
- `comment` — `@MaxLength(1000)`
- `slug` — `@MaxLength(100)`

---

## 23. Cart quantity без верхньої межі

**Файл:** `src/modules/cart/dto/add-cart-item.dto.ts`

**Проблема:**

- `@Min(1)` є, `@Max()` — ні
- `quantity: 999999999` — overflow у total price калькуляціях

**Виправлення:**

- Додати `@Max(9999)` або бізнес-логічний ліміт

---

## 24. Base repository — відсутня валідація та error handling

**Файл:** `src/database/mongoose/repositories/base.repository.ts`

**Проблема:**

- `findById()` не валідує чи `id` — валідний ObjectId
- Всі методи без try-catch — DB помилки propagate unhandled
- Немає `count()`, `exists()`, `updateMany()`, `deleteMany()` методів
- `update()` не перевіряє чи data не порожній

**Виправлення:**

- Додати ObjectId validation перед запитами
- Додати базові утилітарні методи (count, exists)
- Розглянути error handling wrapper

---

## 25. Слабка конфігурація Argon2

**Файл:** `src/modules/auth/auth.service.ts` (рядки 64-66, 91-93)

**Проблема:**

- Використовує дефолтні налаштування Argon2 без explicit options
- Не задані `memoryCost`, `timeCost`, `parallelism`

**Виправлення:**

```typescript
const ARGON2_OPTIONS = {
	memoryCost: 65540, // 64 MiB
	timeCost: 3,
	parallelism: 4
}
```

---

## 26. Inconsistent naming conventions у schema

**Проблема:**

- Більшість полів у snake_case (`category_id`, `product_id`, `order_number`)
- Деякі в camelCase (`userAgent`, `ipAddress`, `cityRef`, `maxWeightAllowed`)
- Непослідовність ускладнює API contracts

**Виправлення:**

- Вибрати один стиль (рекомендовано snake_case для DB, camelCase для JS)
- Використати Mongoose `toJSON` transform для консистентного API output

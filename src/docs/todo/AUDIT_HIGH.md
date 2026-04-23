# HIGH — Аудит безпеки та надійності

## 6. Coupon enumeration attack

**Файл:** `src/modules/discount-coupon/discount-coupon.controller.ts`

**Проблема:**
- `POST /discount-coupons/validate` — публічний ендпоінт без auth та rate limiting
- Атакер може перебрати всі валідні коди знижок (10-символьний `[A-Z0-9]` = обмежений простір)

**Виправлення:**
- Додати rate limiting (max 5 запитів/хв на IP)
- Або вимагати авторизацію (`@UseGuards(JwtAuthGuard)`)
- Або обидва варіанти

---

## 7. NoSQL injection у пошуку купонів

**Файл:** `src/modules/discount-coupon/discount-coupon.service.ts` (рядок 55)

```typescript
if (q?.trim()) filter.code = { $regex: q.trim().toUpperCase(), $options: 'i' }
```

**Проблема:**
- Параметр `q` передається напряму в `$regex` без escaping спецсимволів
- `.*` або `(a+)+$` можуть спричинити ReDoS або непередбачені збіги

**Виправлення:**
- Escape regex спецсимволів: `q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`
- Або використати MongoDB text search / `$text` замість `$regex`

---

## 8. Слабкі вимоги до паролів

**Файли:**
- `src/modules/auth/dto/register.dto.ts`
- `src/common/constants/docs/api-property.constant.ts`

**Проблема:**
- Мінімум 6 символів без вимог до складності
- Дозволяє паролі типу `123456`, `qwerty`, `password`
- Не відповідає OWASP рекомендаціям

**Виправлення:**
- Мінімум 8 символів (краще 12)
- Вимагати мінімум: uppercase + lowercase + digit
- Додати `@Matches()` валідатор з regex

---

## 9. Відсутній rate limiting на auth ендпоінтах

**Файл:** `src/modules/auth/auth.controller.ts` — всі ендпоінти

**Проблема:**
- Login, register, refresh — без обмежень кількості запитів
- Brute force паролів, credential stuffing, token abuse

**Виправлення:**
- Встановити `@nestjs/throttler`
- Login: max 5 спроб / 15 хв на IP
- Register: max 3 / год на IP
- Refresh: max 10 / хв на IP

---

## 10. Безлімітне накопичення refresh токенів

**Файл:** `src/modules/auth/auth.service.ts` (рядки 137-146)

**Проблема:**
- `deleteExpiredForUser()` видаляє лише expired токени
- Користувач може мати необмежену кількість активних сесій
- Немає TTL індексу в MongoDB для автоочистки
- `userId as any` — type safety bypass

**Виправлення:**
- Додати ліміт активних токенів (наприклад, max 5 на користувача)
- Додати TTL index: `RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })`
- Замінити `userId as any` на `new Types.ObjectId(userId)`

---

## 11. Відсутній CSRF захист

**Файли:** всі POST/PATCH/DELETE контролери

**Проблема:**
- Cookie-based auth без CSRF token validation
- `sameSite: lax` (access token) дає часткове покриття, але не повне
- POST ендпоінти вразливі до cross-origin form submissions

**Виправлення:**
- Реалізувати double-submit cookie pattern
- Або додати CSRF token middleware (`csurf` або custom)
- Встановити `sameSite: 'strict'` на всіх auth cookies

---

## 12. Order creation DoS

**Файл:** `src/modules/order/order.controller.ts`

**Проблема:**
- `OptionalJwtAuthGuard` дозволяє анонімні замовлення
- Без rate limiting — атакер може спамити тисячі замовлень
- Кожне замовлення тригерить email, stock validation, DB writes

**Виправлення:**
- Rate limiting: max 5 замовлень / год на IP для анонімних
- Розглянути CAPTCHA для анонімних замовлень
- Або вимагати авторизацію

---

## 13. Відсутній `@Max()` на pagination

**Файли:**
- `src/modules/order/dto/get-orders-query.dto.ts`
- `src/modules/discount-coupon/dto/get-discount-coupons-query.dto.ts`

**Проблема:**
- `limit` має `@Min(1)`, але без `@Max()` — запит `limit=1000000` = memory DoS

**Виправлення:**
- Додати `@Max(100)` або `@Max(50)` на всі pagination limit поля

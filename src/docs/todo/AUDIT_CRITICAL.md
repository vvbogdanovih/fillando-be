# CRITICAL — Аудит безпеки (потребує негайного виправлення)

## 1. Cookie `secure: false` у production

**Файл:** `src/modules/auth/auth.controller.ts` (рядки 24-39)

**Проблема:**

- `secure: false` на обох cookie (access + refresh) — токени передаються через HTTP, вразливість до MITM
- `maxAge` access-токена помилково використовує `RefreshTokenLifetime.ms` замість `AccessTokenLifetime.ms`
- Access token cookie живе довше ніж сам JWT

**Виправлення:**

- `secure: ENV.NODE_ENV === 'production'` або `secure: true`
- `maxAge: AccessTokenLifetime.ms` для access cookie
- Розглянути `sameSite: 'strict'` для обох cookie

---

## 2. Витік банківських даних (IBAN/EDRPOU) без авторизації

**Файл:** `src/modules/payment-details/payment-details.controller.ts`

**Проблема:**

- `findAll()` та `findActive()` — публічні ендпоінти без будь-якої авторизації
- Повертають IBAN та EDRPOU — чутливі банківські дані

**Виправлення:**

- Додати `@UseGuards(JwtAuthGuard, RolesGuard)` та `@Roles(Role.ADMIN)` на обидва ендпоінти
- Або створити окремий публічний ендпоінт що повертає лише замасковані дані

---

## 3. Відсутня перевірка ownership на vendor/product мутаціях

**Файли:**

- `src/modules/vendor/vendor.controller.ts` (update, delete)
- `src/modules/product/product.controller.ts` (create, update, delete, variant operations)

**Проблема:**

- Перевіряється лише `JwtAuthGuard` — будь-який авторизований користувач може:
    - Редагувати/видаляти чужі вендори
    - Створювати/редагувати/видаляти продукти інших вендорів
    - Маніпулювати варіантами чужих продуктів

**Виправлення:**

- Додати ownership guard або middleware
- Перевіряти що `req.user.id` === owner ресурсу перед мутацією
- Або використовувати `@Roles(Role.ADMIN)` для адмін-операцій

---

## 4. Race condition у refresh token rotation

**Файл:** `src/modules/auth/auth.service.ts` (рядки 162-191)

**Проблема:**

- Старий токен видаляється (`deleteById`) ДО верифікації JWT (`verifyRefreshToken`)
- Якщо `saveRefreshToken` впаде після `deleteById` — користувач без валідного токена
- Конкурентні запити з одним refresh token можуть обидва пройти `findByTokenHash`

**Виправлення:**

```
1. Verify JWT first
2. Save new refresh token
3. Delete old refresh token
```

Або використати MongoDB transaction для атомарності.

---

## 5. Відсутня referential integrity (cascade delete)

**Проблема:**
Жоден репозиторій не реалізує cascade delete. Видалення батьківських сутностей залишає orphaned документи:

| Видалення      | Orphaned документи                          |
| -------------- | ------------------------------------------- |
| Category       | Products, ProductVariants                   |
| Product        | ProductVariants, CartItems, OrderItems refs |
| User           | RefreshTokens, Carts, Orders (user_id)      |
| Vendor         | Products                                    |
| ProductVariant | CartItems (variant_id)                      |
| DiscountCoupon | Orders (applied_discount.coupon_id)         |

**Виправлення:**

- Додати cascade delete hooks або middleware в service layer
- Або реалізувати soft delete (`deletedAt`/`isDeleted`) замість hard delete
- Мінімум: перевіряти наявність залежностей перед видаленням та блокувати або каскадити

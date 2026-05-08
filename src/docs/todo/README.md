# Security & Code Quality Audit

Результати повного аудиту проекту fillando-be від 2026-04-16.

## Файли

| Файл                | Кількість | Опис                                                     |
| ------------------- | --------- | -------------------------------------------------------- |
| `AUDIT_CRITICAL.md` | 5 issues  | Критичні вразливості — потребують негайного виправлення  |
| `AUDIT_HIGH.md`     | 8 issues  | Високий пріоритет — безпека та надійність                |
| `AUDIT_MEDIUM.md`   | 13 issues | Середній пріоритет — якість коду, performance, валідація |

**Всього:** 26 зауважень

## Пріоритет виправлення

### Негайно (цього тижня)

1. Cookie `secure: true` + правильний `maxAge` (#1)
2. Закрити payment-details за `@Roles(Role.ADMIN)` (#2)
3. Ownership перевірки на vendor/product мутації (#3)
4. Race condition у refresh token rotation (#4)
5. Rate limiting на auth + order + coupon validate (#9, #12, #6)

### Високий пріоритет (цей спринт)

6. Посилити password requirements (#8)
7. Escape regex у пошуку купонів (#7)
8. `@Max()` на pagination та cart quantity (#13, #23)
9. TTL індекс на refresh tokens (#10)
10. Google OAuth валідація (#14)

### Середній пріоритет (наступний спринт)

11. Додати missing DB індекси (#15)
12. Cascade delete або soft delete (#5, #20)
13. CSRF захист (#11)
14. Email queue з retry (#18)
15. Прибрати `as any` casts (#17)
16. Розширити Mongoose exception filter (#16)

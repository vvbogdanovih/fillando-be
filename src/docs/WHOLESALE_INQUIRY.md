# Wholesale Inquiry — B2B Bulk Purchase Requests

## Overview

Public form on the storefront ("Цікавить оптова закупка?") that lets potential B2B customers
leave a request. Each submission is stored in MongoDB and a notification email is sent to
`SERVICE_EMAIL` via Resend. Admins review and process inquiries in the admin panel.

---

## Data Model

Collection: `wholesale_inquiries` (`src/database/mongoose/schemas/wholesale-inquiry.schema.ts`)

| Field       | Type              | Notes                                       |
| ----------- | ----------------- | ------------------------------------------- |
| `_id`       | string (ObjectId) | MongoDB-generated ID                        |
| `name`      | string            | Contact person full name, required          |
| `phone`     | string            | `+380XXXXXXXXX`, required                   |
| `email`     | string            | Contact email, required                     |
| `quantity`  | string            | Desired plastic quantity, free-form text    |
| `comment`   | string \| null    | Optional details                            |
| `status`    | enum              | `NEW` (default) \| `PROCESSED`              |
| `createdAt` | ISO date string   | Auto-managed                                |
| `updatedAt` | ISO date string   | Auto-managed                                |

`WholesaleInquiryStatus` enum lives in `src/common/types/enums.ts`.

---

## Endpoints

Base path: `/wholesale-inquiries`

### `POST /wholesale-inquiries/`

Public, no auth. Body — `CreateWholesaleInquiryDto`:

```json
{
	"name": "Іван Петренко",
	"phone": "+380991112233",
	"email": "ivan@company.com",
	"quantity": "20 кг на місяць",
	"comment": "Цікавить PETG та PLA"
}
```

Response: `{ "message": "Заявку успішно надіслано", "id": "..." }`

Side effect: fire-and-forget email to `SERVICE_EMAIL`
(`EmailService.sendWholesaleInquiryNotification`). Email failure is logged but never fails
the request — the inquiry is already persisted.

### `GET /wholesale-inquiries/?page=1&limit=20&status=NEW`

Admin only (`JwtAuthGuard` + `RolesGuard`, role `ADMIN`). Paginated list, newest first.
Optional `status` filter. Response: `{ items, total, page, limit }`.

### `PATCH /wholesale-inquiries/:id/status`

Admin only. Body: `{ "status": "PROCESSED" }`. Returns the updated inquiry, 404 if not found.

---

## Module Layout

- `src/modules/wholesale-inquiry/` — controller, service, DTOs, module
- `src/database/mongoose/repositories/wholesale-inquiry.repository.ts` — extends `BaseRepository`
- `src/modules/email/templates/service/wholesale-inquiry.template/` — service email template

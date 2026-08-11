# File Upload — S3 Presigned URL Flow

## Overview

Files are uploaded **directly from the client to S3** using short-lived presigned PUT URLs.
The backend never receives file data — it only orchestrates URL generation, upload confirmation, and deletion.

The bucket is **public-read**. Permanent public URLs are stored in the database as plain strings.

---

## Upload Flow (3 steps)

```
1. POST /api/upload/presign
   Client → Backend: [{ entityType, entityId, contentType }]
   Backend → S3:     generates presigned PUT URL per file
   Backend → Client: { files: [{ key, uploadUrl, publicUrl }] }

2. PUT {presignedUrl}   (client → S3 directly)
   Client must set: Content-Type header matching the requested contentType

3. POST /api/upload/confirm
   Client → Backend: { keys: [...] }
   Backend → S3:     headObject check per key, then download the object once
                     always → write width derivatives -128/-320/-640/-1280 .webp
                     if jpeg/png → also re-encode the original key to WebP
                     if already webp → original key left as-is (derivatives still written)
   Backend → Client: { confirmed: [...], failed: [...] }
   Client then saves the publicUrl(s) via the relevant entity API
```

---

## S3 Key Structure

| Entity  | Key pattern                          |
| ------- | ------------------------------------ |
| product | `products/{productId}/{uuid}.{ext}`  |
| user    | `users/{userId}/avatar/{uuid}.{ext}` |
| vendor  | `vendors/{vendorId}/{uuid}.{ext}`    |

Extension is derived from the requested `contentType`:

- `image/jpeg` → `.jpg`
- `image/png` → `.png`
- `image/webp` → `.webp`

---

## API Reference

### `POST /api/upload/presign`

Requires JWT auth.

**Request body:**

```json
{
	"files": [
		{
			"entityType": "product",
			"entityId": "507f1f77bcf86cd799439011",
			"contentType": "image/webp"
		}
	]
}
```

**Response:**

```json
{
	"files": [
		{
			"key": "products/507f1f77bcf86cd799439011/550e8400-e29b-41d4-a716-446655440000.webp",
			"uploadUrl": "https://bucket.s3.region.amazonaws.com/...",
			"publicUrl": "https://cdn.example.com/products/..."
		}
	]
}
```

### `POST /api/upload/confirm`

Requires JWT auth. Verifies uploaded files exist in S3 via `HeadObject`.

**Request body:**

```json
{ "keys": ["products/507f1f77bcf86cd799439011/550e8400-...webp"] }
```

**Response:**

```json
{ "confirmed": ["products/..."], "failed": [] }
```

### `DELETE /api/upload`

Requires JWT auth. Deletes one or more files from S3.

**Request body:**

```json
{ "keys": ["products/507f1f77bcf86cd799439011/550e8400-...webp"] }
```

---

## Deleting Files From Other Services

`UploadModule` exports `UploadService`. Import the module and inject the service to delete files when an entity is removed:

```typescript
// In your module
imports: [UploadModule]

// In your service
constructor(private readonly uploadService: UploadService) {}

async deleteProduct(id: string) {
  const product = await this.productRepository.findById(id)
  const keys = product.variants.flatMap(v => v.images.map(url => urlToKey(url)))
  await this.uploadService.deleteFiles(keys)
  await this.productRepository.delete(id)
}
```

> **Note:** `urlToKey(url)` strips `AWS_S3_PUBLIC_URL` prefix to get the S3 key from a stored URL.
> This helper is not yet implemented — add it to `UploadService` when needed.

---

## Environment Variables

| Variable                | Description                                        | Example                    |
| ----------------------- | -------------------------------------------------- | -------------------------- |
| `AWS_REGION`            | AWS region where the bucket is hosted              | `eu-central-1`             |
| `AWS_ACCESS_KEY_ID`     | IAM access key with S3 permissions                 | `AKIAIOSFODNN7EXAMPLE`     |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key                                     | `wJalrXUtnFEMI/...`        |
| `AWS_S3_BUCKET_NAME`    | Name of the S3 bucket                              | `fillando-media`           |
| `AWS_S3_PUBLIC_URL`     | Base URL for public file access (S3 or CloudFront) | `https://cdn.fillando.com` |

---

## Constraints

- **Allowed content types:** `image/jpeg`, `image/png`, `image/webp`
- **Auto WebP conversion:** JPEG and PNG files are automatically converted to WebP (quality 80) during the confirm step. The S3 key stays the same — only the content and Content-Type change. Files uploaded as WebP are kept as-is.
- **Width derivatives:** every confirmed image also gets `<key-without-ext>-{128,320,640,1280}.webp`. These back the frontend's custom `next/image` loader, which is why the Next image optimizer is disabled there — it would download and decode the full S3 object on every cache miss and can exhaust a 1–2 GB VPS. Sharp runs here instead, once per upload.
  - Tiers are written **unconditionally**, outside the JPEG/PNG gate: a direct WebP upload needs them too, and `withoutEnlargement` makes a tier wider than the source a copy at the source width. The frontend always emits a `1280w` srcset candidate, so every tier must exist or the browser 404s.
  - `deleteFiles` removes an original's derivatives alongside it.
  - Backfill for pre-existing objects: `scripts/migrations/generate-image-derivatives.js`. Set the `MODE` constant at the top and re-run for each step — `'dry-run'` → `'live'` → `'verify'`. **`'verify'` must exit 0 before the frontend sets `NEXT_PUBLIC_USE_IMAGE_DERIVATIVES=true`.** The script is a one-off; once verify is clean it can be deleted, since new uploads get their derivatives here.
  - `DERIVATIVE_WIDTHS` in `upload.service.ts` is the source of truth; the migration script and the frontend loader/`next.config.ts` all mirror it.
- **Presigned URL TTL:** 15 minutes
- **File size limit:** Not enforced server-side (validate on the frontend before requesting presign)
- **Batch size:** No hard limit; presign accepts an array of files in a single request
- **Auth:** All three endpoints require a valid JWT (`access_token` cookie)

---

## S3 Bucket Policy (recommended)

The bucket should allow public `GetObject` but restrict `PutObject` to the IAM user only:

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Effect": "Allow",
			"Principal": "*",
			"Action": "s3:GetObject",
			"Resource": "arn:aws:s3:::fillando-media/*"
		}
	]
}
```

---

## Future Improvements

- `urlToKey(url)` helper on `UploadService` for key extraction from stored URLs
- S3 Lifecycle rule to auto-delete orphaned temp files after 24h (if a `temp/` prefix is introduced)
- CloudFront signed URLs for private content

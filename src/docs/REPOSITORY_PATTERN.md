# Repository Pattern

This guide describes the data access layer and the full request flow from HTTP to MongoDB.

---

## 1. Request flow

```
HTTP Request
    │
    ▼
Controller  (src/modules/<module>/<module>.controller.ts)
    │  Parses HTTP (body, params, query, cookies). Sets/clears cookies.
    │  Calls service. Returns HTTP response. No business logic.
    │
    ▼
Service  (src/modules/<module>/<module>.service.ts)
    │  Business logic: validation, hashing, token issuance, error throwing.
    │  Calls one or more repositories. No Mongoose models directly.
    │
    ▼
Repository  (src/database/mongoose/repositories/<name>.repository.ts)
    │  Data access only: CRUD against MongoDB via Mongoose.
    │  No business logic, no HTTP concerns.
    │
    ▼
MongoDB (via Mongoose)
```

---

## 2. What is responsible for what

| Layer          | File(s)                                                   | Responsibility                                     |
| -------------- | --------------------------------------------------------- | -------------------------------------------------- |
| **Controller** | `src/modules/<m>/<m>.controller.ts`                       | HTTP in/out, cookies, guards, calls service        |
| **Service**    | `src/modules/<m>/<m>.service.ts`                          | Business logic, validation, calls repositories     |
| **Repository** | `src/database/mongoose/repositories/<name>.repository.ts` | Mongoose queries only, extends `BaseRepository<T>` |
| **Schema**     | `src/database/mongoose/schemas/<name>.schema.ts`          | Mongoose schema + document type definition         |

---

## 3. BaseRepository

`src/database/mongoose/repositories/base.repository.ts`

Abstract generic class. `T` is the plain schema class (e.g. `User`, not `UserDocument`).

```ts
abstract class BaseRepository<T> {
	constructor(protected readonly model: Model<T>) {}
}
```

### Available methods

| Method     | Signature                                        | Returns                       | Notes                                                 |
| ---------- | ------------------------------------------------ | ----------------------------- | ----------------------------------------------------- |
| `create`   | `(data: Partial<T>)`                             | `HydratedDocument<T>`         | Full document — caller needs `.id` etc.               |
| `findById` | `(id: string)`                                   | `HydratedDocument<T> \| null` | Single doc, not lean                                  |
| `findOne`  | `(filter: QueryFilter<T>)`                       | `HydratedDocument<T> \| null` | Single doc, not lean                                  |
| `findAll`  | `(filter?: QueryFilter<T>)`                      | `T[]`                         | **Lean** — no document methods                        |
| `update`   | `(filter: QueryFilter<T>, data: UpdateQuery<T>)` | `HydratedDocument<T> \| null` | `findOneAndUpdate` with `{ returnDocument: 'after' }` |
| `delete`   | `(filter: QueryFilter<T>)`                       | `boolean`                     | `deleteOne`, returns `deletedCount > 0`               |

Single-record reads (`findById`, `findOne`) return hydrated documents so callers can use virtuals like `.id`.
List reads (`findAll`) return lean plain objects for performance.

---

## 4. How to add a new repository

### Step 1: Create the repository file

**`src/database/mongoose/repositories/<name>.repository.ts`**

Extend `BaseRepository<YourSchemaClass>`. Add domain-specific finders as needed — they should delegate to the base methods.

```ts
import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model } from 'mongoose'
import { Product } from '../schemas/product.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class ProductRepository extends BaseRepository<Product> {
	constructor(@InjectModel(Product.name) model: Model<Product>) {
		super(model)
	}

	findBySlug(slug: string): Promise<HydratedDocument<Product> | null> {
		return this.findOne({ slug })
	}
}
```

### Step 2: Register in the module

Add both the `MongooseModule.forFeature` schema registration and the repository to the module's `providers`. Export it if other modules need it.

```ts
@Module({
	imports: [MongooseModule.forFeature([{ name: Product.name, schema: ProductSchema }])],
	providers: [ProductService, ProductRepository],
	controllers: [ProductController]
})
export class ProductModule {}
```

### Step 3: Inject into the service

Services receive the repository via NestJS DI — no `@InjectModel` needed in the service.

```ts
@Injectable()
export class ProductService {
	constructor(private productRepository: ProductRepository) {}

	findOne(id: string) {
		return this.productRepository.findById(id)
	}
}
```

---

## 5. Lean vs. hydrated documents

`findAll` uses `.lean()` — it returns **plain JavaScript objects** (`T[]`), not Mongoose
`HydratedDocument` instances. This means:

- No `.save()`, `.toObject()`, or other Mongoose instance methods are available on the result.
- Virtual fields (e.g. `.id` derived from `._id`) are **not present** — use `._id` directly.
- This is intentional for performance in list queries.

Single-record methods (`findById`, `findOne`, `create`, `update`) return `HydratedDocument<T>`
and do include virtuals like `.id`.

---

## 6. Embedded document mutations

When a schema embeds sub-documents (e.g. `Category` embeds `Subcategory[]`), standard
`BaseRepository.update` is not expressive enough. The concrete repository calls
`this.model.findOneAndUpdate` directly using MongoDB array operators.

### $push — add to array

```ts
addSubcategory(categoryId: string, data: Partial<Subcategory>) {
  return this.model
    .findOneAndUpdate({ _id: categoryId }, { $push: { subcategories: data } }, { returnDocument: 'after' })
    .exec()
}
```

### $pull — remove from array by nested field

```ts
removeSubcategory(categoryId: string, subcategoryId: string) {
  return this.model
    .findOneAndUpdate(
      { _id: categoryId },
      { $pull: { subcategories: { _id: new Types.ObjectId(subcategoryId) } } },
      { returnDocument: 'after' }
    )
    .exec()
}
```

### Positional $set — update a specific array element

The filter must include the array element condition so MongoDB can resolve the `$` positional
operator. The update keys use the `subdoc.$.field` dot-notation:

```ts
updateSubcategory(categoryId: string, subcategoryId: string, data: Partial<Subcategory>) {
  const updateFields: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(data)) {
    updateFields[`subcategories.$.${key}`] = val
  }
  return this.model
    .findOneAndUpdate(
      { _id: categoryId, 'subcategories._id': new Types.ObjectId(subcategoryId) },
      { $set: updateFields },
      { returnDocument: 'after' }
    )
    .exec()
}
```

**Important:** for `$` to resolve, the array field being filtered (`subcategories._id`) must
appear in the query filter, not just in the update.

---

## 7. Global exception filter

`src/database/mongoose/mongoose.filter.ts` — registered globally in `main.ts`.

Catches `MongoServerError` and converts known error codes to NestJS HTTP exceptions:

| MongoDB code | Meaning       | HTTP response                                                             |
| ------------ | ------------- | ------------------------------------------------------------------------- |
| `11000`      | Duplicate key | `400 Bad Request` with message `"Duplicate value for field: <fieldName>"` |

Any other `MongoServerError` is not caught by this filter and will surface as a `500`.

---

## 8. Rules

- **Services never import `@InjectModel` or `Model<T>` directly** — all DB access goes through a repository.
- **Repositories contain no business logic** — no throwing HTTP exceptions, no password hashing, no token signing.
- **Domain-specific finders** belong on the concrete repository class (e.g. `findByEmail`, `findBySlug`), not on the base.
- **Schemas** stay in `src/database/mongoose/schemas/`. Repositories stay in `src/database/mongoose/repositories/`.

# Nova Post Integration

## Overview

Local cache of Nova Post reference data (cities and warehouses) to support delivery address
selection during checkout. All user-facing lookups hit the local MongoDB collections — the Nova
Post API is only called on explicit admin sync.

---

## Collections

### `nova_post_cities`

| Field            | Type   | Description                                     |
| ---------------- | ------ | ----------------------------------------------- |
| `ref`            | string | Nova Post unique settlement identifier (unique) |
| `name`           | string | Settlement display name                         |
| `settlementType` | string | e.g. `'місто'`, `'село'`                        |
| `area`           | string | Oblast/region name                              |

### `nova_post_warehouses`

| Field              | Type   | Description                                    |
| ------------------ | ------ | ---------------------------------------------- |
| `ref`              | string | Nova Post unique warehouse identifier (unique) |
| `description`      | string | Full address description                       |
| `shortAddress`     | string | Short address for display                      |
| `number`           | number | Branch number                                  |
| `cityRef`          | string | Foreign key → `nova_post_cities.ref`           |
| `cityName`         | string | Denormalised city name                         |
| `maxWeightAllowed` | number | Max parcel weight in kg                        |

---

## API Endpoints

### `POST /api/nova-post/sync`

**Auth:** JWT required, `ADMIN` role only.

Fetches all cities and warehouses from the Nova Post API (paginated) and upserts them into the
local collections. Safe to call multiple times — uses `bulkWrite` with `upsert: true` on `ref`.

**Response:**

```json
{ "cities": 2100, "warehouses": 15240 }
```

Sync time is typically 30–90 seconds depending on network latency.

### `GET /api/nova-post/cities?q=<query>`

**Auth:** public.

Case-insensitive search for cities/settlements by name. Returns empty array if `q` is shorter
than 2 characters.

**Response:** array of `NovaPostCity` objects.

### `GET /api/nova-post/warehouses?cityRef=<ref>&type=<optional>&q=<optional>`

**Auth:** public.

Returns warehouses for the given city `ref` (use `ref` from the cities search response). Optional
`type`: `PARCEL_LOCKER` | `POST` | `CARGO` — same as before.

Optional `q` (aligned with `GET /api/nova-post/cities?q=`): when present and non-empty after trim,
the response is filtered to branches that match **at least one** of:

- warehouse **number** — substring match against the numeric № (e.g. `12` matches `12`, `120`, …);
- **`description`** or **`shortAddress`** — case-insensitive substring; the query is trimmed,
  repeated spaces collapsed, and consecutive words in the query may match across flexible spacing in
  the stored text.

When `q` is omitted or blank, behaviour is unchanged: all warehouses for `cityRef` (+ `type` if set).

**Response:** array of `NovaPostWarehouse` objects (same shape as without `q`).

---

## Repositories

`NovaPostCityRepository`

- `findByRef(ref)` — find one city by its NP ref
- `search(q)` — case-insensitive regex search by `name`
- `bulkUpsert(docs)` — upsert array of cities, returns count of affected records

`NovaPostWarehouseRepository`

- `findByRef(ref)` — find one warehouse by its NP ref
- `findByCityRef(cityRef, typeOfWarehouse?, q?)` — warehouses for a city; optional NP warehouse type
  id and optional text/number search query `q`
- `bulkUpsert(docs)` — upsert array of warehouses, returns count of affected records

---

## Nova Post API Details

- Base URL: `https://api.novaposhta.ua/v2.0/json/`
- Cities method: `Address.getCities`, page size 150
- Warehouses method: `AddressGeneral.getWarehouses`, page size 500
- API key configured via `NOVA_POS_API_KEY` env variable

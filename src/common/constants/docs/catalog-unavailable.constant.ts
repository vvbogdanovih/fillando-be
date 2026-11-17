/**
 * The 503 a catalogue handler documents (`ApiServiceUnavailableResponse`), one text per kind of
 * handler behind `LegacyCatalogWriteInterceptor` (audit 11.11: about 30 pasted copies, already
 * disagreeing with the handlers they described). A read's 503 carries `Retry-After: 5` and
 * `no-store` (the interceptor sets both).
 */
export const CATALOG_UNAVAILABLE = {
	/** A legacy write: closed for good once the catalogue control exists. */
	LEGACY_WRITE:
		'CATALOG_LEGACY_WRITES_DISABLED after catalog-control initialization; CATALOG_CONTROL_MISSING for incompatible data without control.',
	/** A legacy read without a visibility adapter: refused once the catalogue holds v2 data. */
	LEGACY_READ:
		'CATALOG_MAINTENANCE, CATALOG_READ_CHANGED, CATALOG_READ_UPGRADE_REQUIRED or CATALOG_CONTROL_MISSING; Retry-After: 5, no-store. Response is discarded if catalog revision/epoch changes.',
	/** An adapted read through the public category projection (`@CatalogAdaptedRead`). */
	ADAPTED_READ:
		'CATALOG_MAINTENANCE, CATALOG_READ_CHANGED, CATALOG_CATEGORY_DATA_UNAVAILABLE or CATALOG_CONTROL_MISSING; Retry-After: 5, no-store. Response is discarded if catalog revision/epoch changes.',
	/** An adapted read independent of the category tree (the colour dictionary). */
	TREE_FREE_READ:
		'CATALOG_MAINTENANCE, CATALOG_READ_CHANGED or CATALOG_CONTROL_MISSING; Retry-After: 5, no-store. Response is discarded if catalog revision/epoch changes.'
} as const

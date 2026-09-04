import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator'

/**
 * `Landing.filters` is `attrKey -> values[]`, and those values travel to the catalogue as a
 * query parameter that `ProductService.getCatalog` splits on commas. A value containing a
 * comma would therefore be unsplittable — TD-0002 §5.2.1 forbids it outright, and a landing is
 * where such a value would be persisted rather than merely typed.
 */
@ValidatorConstraint({ name: 'isLandingFilters', async: false })
export class IsLandingFiltersConstraint implements ValidatorConstraintInterface {
	private reason = 'filters must map an attribute key to an array of values'

	validate(value: unknown): boolean {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			this.reason = 'filters must be an object of attribute key to values'
			return false
		}

		for (const [key, values] of Object.entries(value as Record<string, unknown>)) {
			if (!/^[a-z][a-z0-9_]*$/.test(key)) {
				this.reason = `filter key "${key}" must be a lower-case attribute key`
				return false
			}
			if (!Array.isArray(values) || values.length === 0) {
				this.reason = `filter "${key}" must list at least one value`
				return false
			}
			for (const item of values) {
				if (typeof item !== 'string' || item.trim() === '') {
					this.reason = `filter "${key}" must contain non-empty strings`
					return false
				}
				if (item.includes(',')) {
					this.reason = `filter "${key}" value "${item}" must not contain a comma — the catalogue query splits on it`
					return false
				}
			}
		}
		return true
	}

	defaultMessage(): string {
		return this.reason
	}
}

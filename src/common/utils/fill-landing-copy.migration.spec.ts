import { LandingStatus } from 'src/common/types/enums'

// The migration runs with plain `node`, so it re-declares the sanitizer's tag allowlist and the
// admin form's length limits. This spec is the guard that keeps those copies honest, and it is
// the only thing standing between a typo in the copy module and 14 landings written straight to
// Mongo without going through `sanitizeRichText`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require('../../../scripts/fillando_v_2/fill-landing-copy.js') as {
	validate: (entry: LandingCopy) => string[]
	hasCopy: (doc: Partial<LandingDoc>) => boolean
	isPlaceholderMeta: (doc: Partial<LandingDoc>) => boolean
	ALLOWED_TAGS: Set<string>
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const copyModule = require('../../../scripts/fillando_v_2/landing-copy.js') as {
	LANDING_COPY: LandingCopy[]
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const seed = require('../../../scripts/fillando_v_2/seed-landings.js') as {
	LANDINGS: { slug: string; h1: string; filters: Record<string, string[]> }[]
	defaultsFor: (landing: { h1: string }) => { title: string; meta_description: string }
}

type FaqItem = { q: string; a: string }
type LandingCopy = {
	slug: string
	h1: string
	title: string
	meta_description: string
	intro_html: string
	bottom_html: string
	faq: FaqItem[]
}
type LandingDoc = {
	h1: string
	title: string
	meta_description: string
	intro_html: string
	bottom_html: string
	faq: FaqItem[]
	status: LandingStatus
}

const { validate, hasCopy, isPlaceholderMeta, ALLOWED_TAGS } = migration
const { LANDING_COPY } = copyModule

const VALID: LandingCopy = {
	slug: 'pla',
	h1: 'PLA філамент',
	title: 'PLA філамент для 3D-принтера | Fillando',
	meta_description: 'PLA для 3D-друку: найпростіший у роботі матеріал, друкується без закритої камери.',
	intro_html: '<p>PLA підходить для більшості побутових моделей.</p>',
	bottom_html:
		'<h2>Як друкувати</h2><p>Сопло 200 °C, стіл 60 °C. Для матової поверхні дивіться <a href="/filament/pla-matte">PLA Matte</a>.</p>',
	faq: [{ q: 'Чи потрібен підігрів столу?', a: 'Ні, але з підігрівом адгезія стабільніша.' }]
}

const withCopy = (over: Partial<LandingCopy>): LandingCopy => ({ ...VALID, ...over })

describe('fill-landing-copy migration', () => {
	describe('validate — required fields', () => {
		it('accepts a well-formed entry', () => {
			expect(validate(VALID)).toEqual([])
		})

		it.each(['slug', 'h1', 'title', 'meta_description', 'intro_html', 'bottom_html'] as const)(
			'rejects an empty %s',
			field => {
				expect(validate(withCopy({ [field]: '' }))).toContain(`${field} is empty`)
			}
		)

		it('treats whitespace as empty', () => {
			expect(validate(withCopy({ bottom_html: '   ' }))).toContain('bottom_html is empty')
		})

		it('reports the missing field and stops before the other checks', () => {
			// A 300-char title would also be a problem, but an empty h1 is reported alone so the
			// operator fixes the structural error first.
			const problems = validate(withCopy({ h1: '', title: 'x'.repeat(300) }))
			expect(problems).toEqual(['h1 is empty'])
		})
	})

	describe('validate — length limits', () => {
		it('accepts a title of exactly 60 characters', () => {
			expect(validate(withCopy({ title: 'a'.repeat(60) }))).toEqual([])
		})

		it('rejects a title of 61 characters', () => {
			expect(validate(withCopy({ title: 'a'.repeat(61) }))).toContain(
				'title is 61 chars (limit 60)'
			)
		})

		it('accepts a description of exactly 160 characters', () => {
			expect(validate(withCopy({ meta_description: 'a'.repeat(160) }))).toEqual([])
		})

		it('rejects a description of 161 characters', () => {
			expect(validate(withCopy({ meta_description: 'a'.repeat(161) }))).toContain(
				'meta_description is 161 chars (limit 160)'
			)
		})
	})

	describe('validate — HTML the sanitizer would strip', () => {
		it.each(['script', 'style', 'iframe', 'div', 'span', 'img'])('rejects <%s>', tag => {
			const problems = validate(withCopy({ bottom_html: `<p>текст</p><${tag}>x</${tag}>` }))
			expect(problems).toContain(`bottom_html uses <${tag}>, which the sanitizer strips`)
		})

		it.each(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'br'])(
			'allows <%s>',
			tag => {
				expect(validate(withCopy({ bottom_html: `<${tag}>текст</${tag}>` }))).toEqual([])
			}
		)

		it('checks the intro as well as the body', () => {
			expect(validate(withCopy({ intro_html: '<div>текст</div>' }))).toContain(
				'intro_html uses <div>, which the sanitizer strips'
			)
		})

		it('catches a closing tag whose opener was never there', () => {
			expect(validate(withCopy({ bottom_html: '<p>текст</section>' }))).toContain(
				'bottom_html uses <section>, which the sanitizer strips'
			)
		})

		it('is case-insensitive about tag names', () => {
			expect(validate(withCopy({ bottom_html: '<P>текст</P><SCRIPT>x</SCRIPT>' }))).toContain(
				'bottom_html uses <script>, which the sanitizer strips'
			)
		})
	})

	describe('validate — cross-links', () => {
		it('rejects a link to an address that is not a landing', () => {
			const problems = validate(
				withCopy({ bottom_html: '<p><a href="/filament/petg-silk">PETG Silk</a></p>' })
			)
			expect(problems).toContain('link "/filament/petg-silk" is not a known landing address')
		})

		it('rejects a self-link', () => {
			const problems = validate(
				withCopy({ slug: 'pla', bottom_html: '<p><a href="/filament/pla">PLA</a></p>' })
			)
			expect(problems).toContain('links to itself (/filament/pla)')
		})

		it('allows an absolute external link', () => {
			expect(
				validate(withCopy({ bottom_html: '<p><a href="https://example.com">довідка</a></p>' }))
			).toEqual([])
		})
	})

	describe('validate — FAQ', () => {
		it('rejects markup inside a question', () => {
			const problems = validate(withCopy({ faq: [{ q: '<b>Питання</b>', a: 'Відповідь.' }] }))
			expect(problems).toContain('faq[0] contains markup, which is stripped from FAQ fields')
		})

		it('rejects markup inside an answer', () => {
			const problems = validate(withCopy({ faq: [{ q: 'Питання?', a: '<p>Відповідь.</p>' }] }))
			expect(problems).toContain('faq[0] contains markup, which is stripped from FAQ fields')
		})

		it('rejects an empty answer', () => {
			expect(validate(withCopy({ faq: [{ q: 'Питання?', a: '' }] }))).toContain(
				'faq[0] has an empty question or answer'
			)
		})

		it('names the offending index', () => {
			const problems = validate(
				withCopy({
					faq: [
						{ q: 'Перше?', a: 'Так.' },
						{ q: 'Друге?', a: '<i>Ні.</i>' }
					]
				})
			)
			expect(problems).toContain('faq[1] contains markup, which is stripped from FAQ fields')
		})

		it('accepts a comparison written with a bare angle bracket', () => {
			// `< 60` is prose, not a tag: the check looks for a letter or slash after the bracket.
			expect(
				validate(withCopy({ faq: [{ q: 'Яка температура?', a: 'Тримайте < 60 °C.' }] }))
			).toEqual([])
		})

		it('accepts an entry with no FAQ at all', () => {
			expect(validate(withCopy({ faq: [] }))).toEqual([])
		})

		it('rejects a faq that is not an array', () => {
			expect(validate(withCopy({ faq: null as unknown as FaqItem[] }))).toContain(
				'faq is not an array'
			)
		})
	})

	describe('hasCopy — what counts as already written', () => {
		it('is false for a freshly seeded landing', () => {
			expect(hasCopy({ intro_html: '', bottom_html: '', faq: [] })).toBe(false)
		})

		it.each([
			['intro', { intro_html: '<p>x</p>', bottom_html: '', faq: [] }],
			['body', { intro_html: '', bottom_html: '<p>x</p>', faq: [] }],
			['faq', { intro_html: '', bottom_html: '', faq: [{ q: 'Q', a: 'A' }] }]
		])('is true when only the %s is filled', (_label, doc) => {
			expect(hasCopy(doc)).toBe(true)
		})

		it('treats whitespace-only copy as unwritten', () => {
			expect(hasCopy({ intro_html: '  ', bottom_html: '\n', faq: [] })).toBe(false)
		})

		it('survives missing fields on an older document', () => {
			expect(hasCopy({})).toBe(false)
		})
	})

	describe('isPlaceholderMeta — protecting a hand-tuned title', () => {
		const h1 = 'PLA філамент'
		const seeded = seed.defaultsFor({ h1 })

		it('recognises the seeded placeholder', () => {
			expect(isPlaceholderMeta({ h1, ...seeded })).toBe(true)
		})

		it('refuses to treat an edited title as a placeholder', () => {
			expect(isPlaceholderMeta({ h1, ...seeded, title: 'PLA купити Київ' })).toBe(false)
		})

		it('refuses to treat an edited description as a placeholder', () => {
			expect(isPlaceholderMeta({ h1, ...seeded, meta_description: 'Свій опис.' })).toBe(false)
		})
	})

	describe('the shipped copy module', () => {
		it('covers exactly the seeded landings', () => {
			expect(LANDING_COPY.map(c => c.slug).sort()).toEqual(seed.LANDINGS.map(l => l.slug).sort())
		})

		it('keeps the h1 of every landing in step with the seed', () => {
			const seededH1 = new Map(seed.LANDINGS.map(l => [l.slug, l.h1]))
			for (const entry of LANDING_COPY) {
				expect({ slug: entry.slug, h1: entry.h1 }).toEqual({
					slug: entry.slug,
					h1: seededH1.get(entry.slug)
				})
			}
		})

		it('passes its own validator, entry by entry', () => {
			for (const entry of LANDING_COPY) {
				expect({ slug: entry.slug, problems: validate(entry) }).toEqual({
					slug: entry.slug,
					problems: []
				})
			}
		})

		it('gives every landing a unique title and description', () => {
			const titles = LANDING_COPY.map(c => c.title)
			const metas = LANDING_COPY.map(c => c.meta_description)
			expect(new Set(titles).size).toBe(titles.length)
			expect(new Set(metas).size).toBe(metas.length)
		})

		it('cross-links every landing to at least one sibling', () => {
			for (const entry of LANDING_COPY) {
				const links = [...entry.bottom_html.matchAll(/href="(\/filament\/[a-z0-9-]+)"/g)]
				expect({ slug: entry.slug, links: links.length > 0 }).toEqual({
					slug: entry.slug,
					links: true
				})
			}
		})

		it('never uses an em dash, which the style guide forbids', () => {
			for (const entry of LANDING_COPY) {
				const text = [entry.intro_html, entry.bottom_html, entry.meta_description]
					.concat(entry.faq.flatMap(f => [f.q, f.a]))
					.join(' ')
				expect({ slug: entry.slug, emDash: text.includes('—') }).toEqual({
					slug: entry.slug,
					emDash: false
				})
			}
		})
	})

	describe('allowlist stays in step with the sanitizer', () => {
		it.each(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'table', 'td'])(
			'allows <%s>, as sanitizeRichText does',
			tag => {
				expect(ALLOWED_TAGS.has(tag)).toBe(true)
			}
		)

		it.each(['script', 'style', 'iframe', 'object', 'embed'])('never allows <%s>', tag => {
			expect(ALLOWED_TAGS.has(tag)).toBe(false)
		})
	})
})

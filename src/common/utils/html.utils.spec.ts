import { escapeHtml, escapeTemplateData, sanitizePlainText, sanitizeRichText } from './html.utils'

/**
 * Landing copy and product descriptions are rendered with `dangerouslySetInnerHTML`, so what
 * survives this function runs in every visitor's browser. Each case below is an attack that
 * an admin account could otherwise store once and have replayed to everyone.
 */
describe('sanitizeRichText', () => {
	it.each([
		['a script tag', '<p>ok</p><script>alert(1)</script>', '<p>ok</p>'],
		['an inline event handler', '<p onclick="steal()">x</p>', '<p>x</p>'],
		['a javascript: link', '<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
		['a data: link outside images', '<a href="data:text/html,<b>x</b>">x</a>', '<a>x</a>'],
		['an iframe', '<iframe src="https://evil.invalid"></iframe>', ''],
		['a style element', '<style>body{display:none}</style><p>x</p>', '<p>x</p>'],
		['an svg payload', '<svg onload="alert(1)"></svg>', ''],
		['a form', '<form action="https://evil.invalid"><input name="card"></form>', '']
	])('drops %s', (_case, input, expected) => {
		expect(sanitizeRichText(input)).toBe(expected)
	})

	it('strips positioning styles that could cover the buy button, keeping typographic ones', () => {
		const result = sanitizeRichText(
			'<p style="color:#ff0000;position:fixed;top:0;z-index:99">x</p>'
		)
		expect(result).toContain('color:#ff0000')
		expect(result).not.toContain('position')
		expect(result).not.toContain('z-index')
	})

	it('forces rel=noopener on links that open a new tab', () => {
		expect(sanitizeRichText('<a href="https://e.invalid" target="_blank">x</a>')).toContain(
			'rel="noopener noreferrer"'
		)
	})

	it('leaves same-tab links without an invented rel', () => {
		expect(sanitizeRichText('<a href="/filament">x</a>')).toBe('<a href="/filament">x</a>')
	})

	it.each([
		['headings and lists', '<h2>T</h2><ul><li>a</li></ul>'],
		['tables', '<table><tbody><tr><td>1</td></tr></tbody></table>'],
		['basic formatting', '<p><strong>a</strong><em>b</em><u>c</u></p>'],
		['an https image', '<img src="https://cdn.invalid/a.webp" alt="a" />']
	])('keeps the editor output for %s', (_case, input) => {
		expect(sanitizeRichText(input)).toBe(input)
	})

	it('allows data: images, which the editor pastes before upload', () => {
		const input = '<img src="data:image/png;base64,iVBORw0KGgo=" />'
		expect(sanitizeRichText(input)).toBe(input)
	})

	it.each([[null], [undefined]])('passes %p through unchanged', value => {
		expect(sanitizeRichText(value)).toBe(value)
	})

	it('is idempotent — sanitizing stored copy again changes nothing', () => {
		const once = sanitizeRichText('<p onclick="x()">a</p><script>b</script><p>c</p>')
		expect(sanitizeRichText(once)).toBe(once)
	})
})

describe('sanitizePlainText', () => {
	it('keeps the words and drops the markup', () => {
		expect(sanitizePlainText('<b>PLA</b> Silk')).toBe('PLA Silk')
	})

	it('removes a script entirely rather than exposing its source', () => {
		expect(sanitizePlainText('a<script>alert(1)</script>b')).toBe('ab')
	})

	it.each([[null], [undefined]])('passes %p through unchanged', value => {
		expect(sanitizePlainText(value)).toBe(value)
	})
})

describe('sanitizeRichText — non-breaking spaces', () => {
	/**
	 * The bug this exists for: Quill writes `&nbsp;` between words, and a paragraph whose every
	 * space is non-breaking reports its whole length as its minimum width. One save through the
	 * admin stretched a landing's copy card to 3357px inside a 1248px page.
	 */
	it('turns the editor’s word spaces back into ordinary ones', () => {
		expect(sanitizeRichText('<p>PLA виготовляють із крохмалю</p>')).toBe(
			'<p>PLA виготовляють із крохмалю</p>'
		)
	})

	it('keeps the one after a digit, which binds a number to its unit', () => {
		expect(sanitizeRichText('<p>195 °C і 1,75 мм</p>')).toBe('<p>195 °C і 1,75 мм</p>')
	})

	it('leaves ordinary spaces alone', () => {
		expect(sanitizeRichText('<p>звичайний текст</p>')).toBe('<p>звичайний текст</p>')
	})

	it('handles a paragraph that starts with one', () => {
		expect(sanitizeRichText('<p> текст</p>')).toBe('<p> текст</p>')
	})
})

describe('escapeHtml', () => {
	it('escapes markup and both quote kinds', () => {
		expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
			'&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
		)
	})

	it('reads null and undefined as empty and prints numbers', () => {
		expect(escapeHtml(null)).toBe('')
		expect(escapeHtml(undefined)).toBe('')
		expect(escapeHtml(42)).toBe('42')
	})
})

describe('escapeTemplateData', () => {
	it('escapes every string, however deep, and leaves other values alone', () => {
		const createdAt = new Date('2026-09-29T10:00:00.000Z')
		const result = escapeTemplateData({
			name: '<b>Іван</b>',
			total: 918,
			paid: true,
			comment: null,
			createdAt,
			items: [{ name: '<img src=x>', quantity: 2 }]
		})

		expect(result).toEqual({
			name: '&lt;b&gt;Іван&lt;/b&gt;',
			total: 918,
			paid: true,
			comment: null,
			createdAt,
			items: [{ name: '&lt;img src=x&gt;', quantity: 2 }]
		})
		expect(result.createdAt).toBe(createdAt)
	})

	it('unwraps a Mongoose subdocument instead of passing it through unescaped', () => {
		const subdoc = { toObject: () => ({ code: '<script>', discount_percent: 10 }) }
		expect(escapeTemplateData({ appliedDiscount: subdoc })).toEqual({
			appliedDiscount: { code: '&lt;script&gt;', discount_percent: 10 }
		})
	})

	it('does not mutate its input', () => {
		const input = { name: '<b>' }
		escapeTemplateData(input)
		expect(input.name).toBe('<b>')
	})
})

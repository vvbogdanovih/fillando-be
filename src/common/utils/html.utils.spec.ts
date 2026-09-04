import { sanitizePlainText, sanitizeRichText } from './html.utils'

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

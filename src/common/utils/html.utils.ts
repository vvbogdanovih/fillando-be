import sanitizeHtml from 'sanitize-html'

/**
 * Allowlist for admin-authored rich text (landing copy, product descriptions).
 *
 * The editors are Quill/TipTap, so the tag set is what they can emit plus tables; anything
 * else — `<script>`, `<style>`, `<iframe>`, event handlers, `javascript:` URLs — is dropped
 * rather than escaped, because this HTML is rendered with `dangerouslySetInnerHTML` on the
 * storefront. Admins are trusted, but a stored XSS here would run for every visitor, and an
 * account can be phished.
 */
const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: [
		'p',
		'br',
		'span',
		'div',
		'h1',
		'h2',
		'h3',
		'h4',
		'h5',
		'h6',
		'strong',
		'b',
		'em',
		'i',
		'u',
		's',
		'sub',
		'sup',
		'blockquote',
		'code',
		'pre',
		'ul',
		'ol',
		'li',
		'a',
		'img',
		'table',
		'thead',
		'tbody',
		'tfoot',
		'tr',
		'th',
		'td',
		'hr'
	],
	allowedAttributes: {
		a: ['href', 'title', 'target', 'rel'],
		img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
		'*': ['class', 'style']
	},
	// Relative links stay usable; every other scheme is refused.
	allowedSchemes: ['http', 'https', 'mailto', 'tel'],
	allowedSchemesByTag: { img: ['http', 'https', 'data'] },
	allowProtocolRelative: false,
	// Inline styles are what the editors use for alignment and colour; keep those, drop the
	// rest so `style` cannot smuggle `position`/`z-index` overlays over the buy button.
	allowedStyles: {
		'*': {
			color: [/^.*$/],
			'background-color': [/^.*$/],
			'text-align': [/^(left|right|center|justify)$/],
			'font-size': [/^\d+(?:\.\d+)?(?:px|em|rem|%)$/],
			'font-weight': [/^(normal|bold|[1-9]00)$/],
			'text-decoration': [/^(none|underline|line-through)$/]
		}
	},
	transformTags: {
		// A link that leaves the site must not hand the opener a window reference.
		a: (tagName, attribs) => ({
			tagName,
			attribs:
				attribs.target === '_blank' ? { ...attribs, rel: 'noopener noreferrer' } : attribs
		})
	}
}

/** Sanitizes admin-authored rich text. `null`/`undefined` pass through unchanged. */
export function sanitizeRichText<T extends string | null | undefined>(html: T): T {
	if (typeof html !== 'string') return html
	return sanitizeHtml(html, RICH_TEXT_OPTIONS) as T
}

/**
 * Sanitizes a short field that must not carry markup at all (FAQ questions, headings):
 * tags are stripped and the text kept, so a pasted `<b>` degrades to its words.
 */
export function sanitizePlainText<T extends string | null | undefined>(text: T): T {
	if (typeof text !== 'string') return text
	return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} }) as T
}

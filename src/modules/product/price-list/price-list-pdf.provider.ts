import { Injectable, Logger } from '@nestjs/common'

const FONT_STACK = "'FreeSans',Arial,sans-serif"

/**
 * A deliberate near-copy of `InvoicePdfProvider`. It cannot be reused: `OrderModule`
 * already imports `ProductModule`, so importing back would be a circular module
 * dependency — and `generatePdf(html)` there takes no options, while a price list needs
 * `displayHeaderFooter` for page numbering.
 *
 * Follow-up worth doing separately: hoist a shared `PdfProvider` into `src/common/`
 * once there is a `CommonModule` to hang it on.
 */
@Injectable()
export class PriceListPdfProvider {
	private readonly logger = new Logger(PriceListPdfProvider.name)

	async generatePdf(html: string, title: string, landscape: boolean): Promise<Buffer> {
		const puppeteer = await import('puppeteer')
		const browser = await puppeteer.default.launch({
			headless: true,
			args: ['--no-sandbox', '--disable-setuid-sandbox'],
			// A few hundred pages can outlast puppeteer's 180s default mid-render.
			protocolTimeout: 180_000
		})

		try {
			const page = await browser.newPage()
			await page.setContent(html, { waitUntil: 'load', timeout: 120_000 })
			const pdf = await page.pdf({
				format: 'A4',
				// Set here rather than via an @page rule, so no preferCSSPageSize juggling.
				landscape,
				printBackground: true,
				displayHeaderFooter: true,
				// Header/footer render INSIDE the margin box, hence the roomy top/bottom.
				margin: { top: '18mm', right: '10mm', bottom: '14mm', left: '10mm' },
				// These templates inherit nothing from the document, so every style is
				// inline and font-size is stated explicitly (the default is ~6px).
				// No `class="date"` here: Chromium renders it in its own locale (M/D/YY),
				// which clashes with the uk-UA timestamp the body already carries.
				headerTemplate: `<div style="width:100%;font-family:${FONT_STACK};font-size:8px;color:#666;padding:0 10mm;">${title}</div>`,
				footerTemplate: `<div style="width:100%;font-family:${FONT_STACK};font-size:8px;color:#666;padding:0 10mm;text-align:center;">Стор. <span class="pageNumber"></span> з <span class="totalPages"></span></div>`,
				timeout: 180_000
			})
			await page.close()
			return Buffer.from(pdf)
		} finally {
			await browser.close()
		}
	}
}

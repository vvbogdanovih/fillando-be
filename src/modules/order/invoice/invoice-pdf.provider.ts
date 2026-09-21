import { Injectable, Logger } from '@nestjs/common'

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Chrome ignores inherited styles here, so every rule is spelled out inline. */
function footerTemplate(text: string): string {
	return `<div style="width:100%;margin:0 15mm;font-family:'Courier New',Courier,monospace;font-size:8px;color:#777;display:flex;justify-content:space-between;">
		<span>${escapeHtml(text)}</span>
		<span>Стор. <span class="pageNumber"></span> з <span class="totalPages"></span></span>
	</div>`
}

export interface PdfOptions {
	/** Wide tables (the sales report) need the long edge; invoices stay portrait. */
	landscape?: boolean
	/**
	 * Running footer, printed with a page counter beside it. A multi-page financial document is
	 * passed around on paper, and unnumbered pages get shuffled.
	 */
	footerText?: string
}

@Injectable()
export class InvoicePdfProvider {
	private readonly logger = new Logger(InvoicePdfProvider.name)

	async generatePdf(html: string, options: PdfOptions = {}): Promise<Buffer> {
		const puppeteer = await import('puppeteer')
		const browser = await puppeteer.default.launch({
			headless: true,
			args: ['--no-sandbox', '--disable-setuid-sandbox']
		})

		try {
			const page = await browser.newPage()
			await page.setContent(html, { waitUntil: 'load' })
			const pdf = await page.pdf({
				format: 'A4',
				landscape: options.landscape ?? false,
				margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
				printBackground: true,
				...(options.footerText
					? {
							displayHeaderFooter: true,
							headerTemplate: '<div></div>',
							footerTemplate: footerTemplate(options.footerText)
						}
					: {})
			})
			await page.close()
			return Buffer.from(pdf)
		} finally {
			await browser.close()
		}
	}
}

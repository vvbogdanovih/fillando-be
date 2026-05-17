import { Injectable, Logger } from '@nestjs/common'

@Injectable()
export class InvoicePdfProvider {
	private readonly logger = new Logger(InvoicePdfProvider.name)

	async generatePdf(html: string): Promise<Buffer> {
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
				margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
				printBackground: true
			})
			await page.close()
			return Buffer.from(pdf)
		} finally {
			await browser.close()
		}
	}
}

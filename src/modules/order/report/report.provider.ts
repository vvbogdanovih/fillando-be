import { Injectable } from '@nestjs/common'
import { InvoicePdfProvider } from '../invoice/invoice-pdf.provider'
import { invoiceTemplate, type InvoiceData } from '../invoice/invoice.template'

@Injectable()
export class ReportProvider {
	constructor(private readonly invoicePdfProvider: InvoicePdfProvider) {}

	async generateBatchPdf(invoices: InvoiceData[]): Promise<Buffer> {
		const pages = invoices.map(data => {
			const fullHtml = invoiceTemplate(data)
			const bodyMatch = fullHtml.match(/<body[^>]*>([\s\S]*)<\/body>/)
			return bodyMatch?.[1] ?? ''
		})

		const html = `<!DOCTYPE html>
<html lang="uk">
<head>
	<meta charset="UTF-8" />
	<title>Звіт замовлень</title>
	<style>
		.invoice-page { page-break-after: always; }
		.invoice-page:last-child { page-break-after: auto; }
	</style>
</head>
<body style="margin:0;padding:0;font-family:Courier New,Courier,monospace;font-size:13px;color:#111;line-height:1.5;">
	${pages.map(p => `<div class="invoice-page">${p}</div>`).join('\n\t')}
</body>
</html>`

		return this.invoicePdfProvider.generatePdf(html)
	}
}

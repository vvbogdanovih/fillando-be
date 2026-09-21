import { Injectable } from '@nestjs/common'
import { InvoicePdfProvider } from '../invoice/invoice-pdf.provider'
import type { SalesReportData } from './report.builder'
import { salesReportPeriodLabel, salesReportTemplate } from './report.template'

@Injectable()
export class ReportProvider {
	constructor(private readonly invoicePdfProvider: InvoicePdfProvider) {}

	/**
	 * Landscape: the order register is twelve columns wide and unreadable on a portrait page.
	 */
	generateSalesReportPdf(data: SalesReportData): Promise<Buffer> {
		const period = salesReportPeriodLabel(data.filters)

		return this.invoicePdfProvider.generatePdf(salesReportTemplate(data), {
			landscape: true,
			footerText: `Fillando · Звіт про продажі · ${period}`
		})
	}
}

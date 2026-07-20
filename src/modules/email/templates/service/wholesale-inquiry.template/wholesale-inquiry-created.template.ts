export interface WholesaleInquiryCreatedEmailData {
	name: string
	phone: string
	email: string
	quantity: string
	comment: string | null
}

export function wholesaleInquiryCreatedTemplate(data: WholesaleInquiryCreatedEmailData): string {
	return `<!DOCTYPE html>
<html lang="uk">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Нова заявка на оптову закупку</title>
  </head>
  <body style="margin:0;padding:24px 12px;background-color:#ffffff;font-family:Arial,sans-serif;">
    <div style="max-width:600px;margin:24px auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
      <div style="background-color:#ffffff;padding:24px 32px;border-bottom:1px solid #eceff4;">
        <h1 style="margin:0;color:#111827;font-size:28px;font-weight:700;letter-spacing:0.02em;">Fillando</h1>
      </div>
      <div style="padding:32px;color:#333333;">
        <p style="font-size:18px;font-weight:700;color:#1a1a1a;margin:0 0 16px;">Нова заявка на оптову закупку</p>

        <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#999;margin:20px 0 10px;">Контактна особа</p>
        <p style="font-size:14px;margin:4px 0;color:#333;">${data.name}</p>
        <p style="font-size:14px;margin:4px 0;color:#333;"><a href="tel:${data.phone}" style="color:#333;">${data.phone}</a></p>
        <p style="font-size:14px;margin:4px 0;color:#333;"><a href="mailto:${data.email}" style="color:#333;">${data.email}</a></p>

        <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#999;margin:28px 0 10px;">Бажана кількість пластику</p>
        <p style="font-size:14px;margin:4px 0;color:#333;">${data.quantity}</p>

        ${
			data.comment
				? `
        <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#999;margin:28px 0 10px;">Коментар</p>
        <p style="font-size:14px;margin:4px 0;color:#333;white-space:pre-line;">${data.comment}</p>
        `
				: ''
		}
      </div>
    </div>
  </body>
</html>`
}

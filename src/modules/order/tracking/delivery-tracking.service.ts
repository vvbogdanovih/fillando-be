import { Injectable, Logger } from '@nestjs/common'
import { Types } from 'mongoose'
import { OrderRepository } from 'src/database/mongoose/repositories/order.repository'
import { EmailService } from 'src/modules/email/email.service'
import {
	decideTracking,
	npPhone,
	TRACKED_ORDER_STATUSES,
	TRACKING_WINDOW_DAYS
} from './delivery-tracking.rules'
import { NovaPostTrackingClient } from './nova-post-tracking.client'

const DAY_MS = 24 * 60 * 60 * 1000

export interface TrackingSummary {
	checked: number
	answered: number
	updated: number
	alerted: number
}

/**
 * Follows shipped parcels through Nova Post and moves their orders along: a received parcel
 * closes a paid order and marks an unpaid COD as DELIVERED; a refusal, a return or an unknown
 * TTN is emailed to the admin once and the status is left for them to decide.
 */
@Injectable()
export class DeliveryTrackingService {
	private readonly logger = new Logger(DeliveryTrackingService.name)
	private running = false

	constructor(
		private readonly orderRepository: OrderRepository,
		private readonly trackingClient: NovaPostTrackingClient,
		private readonly emailService: EmailService
	) {}

	get isRunning(): boolean {
		return this.running
	}

	async run(now: Date = new Date()): Promise<TrackingSummary> {
		this.running = true
		try {
			return await this.track(now)
		} finally {
			this.running = false
		}
	}

	private async track(now: Date): Promise<TrackingSummary> {
		const since = new Date(now.getTime() - TRACKING_WINDOW_DAYS * DAY_MS)
		const orders = await this.orderRepository.findTrackable(TRACKED_ORDER_STATUSES, since)
		const summary: TrackingSummary = {
			checked: orders.length,
			answered: 0,
			updated: 0,
			alerted: 0
		}
		if (orders.length === 0) return summary

		const statuses = await this.trackingClient.getStatuses(
			orders.map(order => ({
				ttn: order.nova_post_ttn as string,
				phone: npPhone(order.customer?.phone)
			}))
		)

		for (const order of orders) {
			const ttn = order.nova_post_ttn as string
			const status = statuses.get(ttn)
			if (!status) continue
			summary.answered += 1

			const decision = decideTracking(order, status.code)
			// Guarded on the status and TTN this pass read: an admin who changed either in the
			// meantime wins, and the next run starts from what they set. Mongo here is
			// standalone, so this conditional write is the concurrency control there is.
			const guard = {
				_id: new Types.ObjectId(String(order._id)),
				order_status: order.order_status,
				nova_post_ttn: ttn
			}
			const trackingStatus = { code: status.code, text: status.text, checked_at: now }

			if (decision.kind === 'update') {
				const updated = await this.orderRepository.update(guard, {
					$set: { order_status: decision.nextStatus, nova_post_status: trackingStatus }
				})
				if (updated) {
					summary.updated += 1
					this.logger.log(
						`Order ${order.order_number}: ${order.order_status} → ${decision.nextStatus} (НП ${status.code} «${status.text}»)`
					)
				}
				continue
			}

			if (decision.kind === 'alert' && order.nova_post_alerted_code !== status.code) {
				try {
					await this.emailService.sendDeliveryIssueAlert({
						orderNumber: order.order_number,
						ttn,
						statusCode: status.code,
						statusText: status.text,
						customerName: order.customer?.name ?? '',
						customerPhone: order.customer?.phone ?? ''
					})
				} catch (err) {
					// Not marked as alerted, so the next run tries the email again.
					this.logger.error(
						`Delivery issue alert for ${order.order_number} failed: ${(err as Error).message}`
					)
					await this.orderRepository.update(guard, {
						$set: { nova_post_status: trackingStatus }
					})
					continue
				}
				await this.orderRepository.update(guard, {
					$set: { nova_post_status: trackingStatus, nova_post_alerted_code: status.code }
				})
				summary.alerted += 1
				continue
			}

			await this.orderRepository.update(guard, { $set: { nova_post_status: trackingStatus } })
		}

		return summary
	}
}

import { NovaPostWarehouseType } from 'src/common/types/enums'

const PARCEL_LOCKER_ID = 'f9316480-5f2d-425d-bc2c-ac7cd29decf0'
const POST_ID = '841339c7-591a-42e2-8233-7a0a00f0ed6f'
const CARGO_ID = '9a68df70-0267-42a8-bb5c-37f427e36ee4'

/** Nova Post `TypeOfWarehouse` refs behind each of our types; `BRANCH` is post and cargo together. */
export const NOVA_POST_WAREHOUSE_TYPE_IDS: Record<NovaPostWarehouseType, string[]> = {
	[NovaPostWarehouseType.PARCEL_LOCKER]: [PARCEL_LOCKER_ID],
	[NovaPostWarehouseType.BRANCH]: [POST_ID, CARGO_ID],
	[NovaPostWarehouseType.POST]: [POST_ID],
	[NovaPostWarehouseType.CARGO]: [CARGO_ID]
}

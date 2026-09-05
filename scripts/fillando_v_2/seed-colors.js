/**
 * Seed: the colour dictionary (TD-0002 §5.2.2).
 *
 * One row per canonical manufacturer colour. `name_en` is the key the normalizer matches on,
 * `name_uk` is what a shopper reads, `family` is the swatch bucket the catalogue filters by,
 * and `hex_stops` paints the swatch — one stop is a solid circle, several a gradient, and a
 * `multicolor` family is drawn as a conic gradient so a rainbow reads as a ring.
 *
 * `synonyms` are extra spellings seen in the existing `v_value` data. The normalizer also
 * derives aliases automatically (`name_en`, `name_uk`, and `"name_en name_uk"`, which is how
 * this shop's imported variants are usually written), so only the irregular spellings are
 * listed here.
 *
 * Deliberately conservative: this covers the colours that can be identified with certainty.
 * Codes and marketing names (`TR-1`, `HC186`, `Macaron`, `Universe`) are NOT guessed at — they
 * land in color-report.json for a human to decide on, which is what the plan asks for.
 *
 * Non-destructive and idempotent: an existing colour (matched on `name_en`) is left untouched,
 * so a hex tweaked in the admin survives a re-run.
 *
 * Usage:
 *   node scripts/fillando_v_2/seed-colors.js --dry-run
 *   node scripts/fillando_v_2/seed-colors.js
 */

const mongoose = require('mongoose')

const DRY_RUN = process.argv.includes('--dry-run')

/**
 * @typedef {{ name_en: string, name_uk: string, family: string, hex_stops: string[], synonyms?: string[] }} ColorSeed
 * @type {ColorSeed[]}
 */
const COLORS = [
	{ name_en: 'Black', name_uk: 'Чорний', family: 'black', hex_stops: ['#1a1a1a'] },
	{
		name_en: 'Charcoal',
		name_uk: 'Вугільно-чорний',
		family: 'black',
		hex_stops: ['#36454f'],
		synonyms: ['Charcoal Вугільно-чорний']
	},
	{ name_en: 'White', name_uk: 'Білий', family: 'white', hex_stops: ['#f5f5f5'] },
	{
		name_en: 'Bone White',
		name_uk: 'Кістково-білий',
		family: 'white',
		hex_stops: ['#e3dac9'],
		synonyms: ['Кістково-білий']
	},
	{
		name_en: 'Beige',
		name_uk: 'Бежевий',
		family: 'brown',
		hex_stops: ['#e8d8b8'],
		// Bambu Lab PLA Lite stores the whole label in the colour field, prefix and all.
		synonyms: ['Matte Beige Бежевий (матовий)']
	},
	{
		name_en: 'Gray',
		name_uk: 'Сірий',
		family: 'gray',
		hex_stops: ['#808080'],
		synonyms: ['Grey']
	},
	{ name_en: 'Dark Gray', name_uk: 'Темно-сірий', family: 'gray', hex_stops: ['#4a4a4a'] },
	{ name_en: 'Ash Gray', name_uk: 'Попелясто-сірий', family: 'gray', hex_stops: ['#b2beb5'] },
	{ name_en: 'Titan Gray', name_uk: 'Сірий титан', family: 'gray', hex_stops: ['#878681'] },
	{ name_en: 'Lava Gray', name_uk: 'Лавово-сірий', family: 'gray', hex_stops: ['#6e6e6e'] },
	{ name_en: 'Red', name_uk: 'Червоний', family: 'red', hex_stops: ['#e53e3e'] },
	{
		name_en: 'Burgundy Red',
		name_uk: 'Бордовий',
		family: 'red',
		hex_stops: ['#800020'],
		synonyms: ['Вишнево-червоний', 'Вишня']
	},
	{ name_en: 'Orange', name_uk: 'Помаранчевий', family: 'orange', hex_stops: ['#ed8936'] },
	{
		name_en: 'Sunflower',
		name_uk: 'Соняшниковий',
		family: 'yellow',
		hex_stops: ['#ffc300'],
		synonyms: ['Сонячно-помаранчевий']
	},
	{ name_en: 'Yellow', name_uk: 'Жовтий', family: 'yellow', hex_stops: ['#ecc94b'] },
	{
		name_en: 'Lemon Yellow',
		name_uk: 'Лимонно-жовтий',
		family: 'yellow',
		hex_stops: ['#fff44f'],
		synonyms: ['Яскраво-жовтий']
	},
	{
		name_en: 'Tangerine Yellow',
		name_uk: 'Мандариново-жовтий',
		family: 'yellow',
		hex_stops: ['#ffcc00']
	},
	{ name_en: 'Green', name_uk: 'Зелений', family: 'green', hex_stops: ['#38a169'] },
	{ name_en: 'Dark Green', name_uk: 'Темно-зелений', family: 'green', hex_stops: ['#14532d'] },
	{
		name_en: 'Olive',
		name_uk: 'Оливковий',
		family: 'green',
		hex_stops: ['#808000'],
		synonyms: ['Оливково-зелений']
	},
	{
		name_en: 'Matcha Green',
		name_uk: 'Зелений матча',
		family: 'green',
		hex_stops: ['#8fbc8f'],
		synonyms: ['Трав’яний зелений']
	},
	{
		name_en: 'Mint',
		name_uk: 'М’ятний',
		family: 'green',
		hex_stops: ['#98ff98'],
		synonyms: ['М’ятно-зелений']
	},
	{ name_en: 'Apple Green', name_uk: 'Яблучно-зелений', family: 'green', hex_stops: ['#8db600'] },
	{ name_en: 'Blue', name_uk: 'Синій', family: 'blue', hex_stops: ['#3182ce'] },
	{
		name_en: 'Dark Blue',
		name_uk: 'Темно-синій',
		family: 'blue',
		hex_stops: ['#1e3a8a'],
		synonyms: ['Navy Blue Темно-синій', 'Темно синій', 'Опівнічний (темно-синій)']
	},
	{
		name_en: 'Royal Blue',
		name_uk: 'Королівський синій',
		family: 'blue',
		hex_stops: ['#4169e1']
	},
	{ name_en: 'Jeans Blue', name_uk: 'Джинсовий синій', family: 'blue', hex_stops: ['#5d76a9'] },
	{ name_en: 'Klein Blue', name_uk: 'Синій Кляйна', family: 'blue', hex_stops: ['#002fa7'] },
	{
		name_en: 'Cyan',
		name_uk: 'Блакитний',
		family: 'blue',
		hex_stops: ['#00b7eb'],
		synonyms: ['Небесно-блакитний']
	},
	// Bambu's "Blue Grey" is a muted slate, not cyan — and both sit on the same product.
	// `family` is a judgement call between `gray` and `blue`; it is editable in the admin.
	{ name_en: 'Blue Grey', name_uk: 'Сіро-блакитний', family: 'gray', hex_stops: ['#5b6579'] },
	{ name_en: 'Azure', name_uk: 'Лазуровий', family: 'blue', hex_stops: ['#007fff'] },
	{
		name_en: 'Teal',
		name_uk: 'Бірюзовий',
		family: 'blue',
		hex_stops: ['#008080'],
		synonyms: ['Tea Бірюзовий', 'Синьо-зелений']
	},
	{ name_en: 'Purple', name_uk: 'Фіолетовий', family: 'purple', hex_stops: ['#805ad5'] },
	{
		name_en: 'Iris Purple',
		name_uk: 'Фіолетовий ірис',
		family: 'purple',
		hex_stops: ['#5a4fcf'],
		synonyms: ['Бузкво-фіолетовий', 'Лавандово-фіолетовий', 'Синьо-фіолетовий']
	},
	{
		name_en: 'Magenta',
		name_uk: 'Пурпуровий (маджента)',
		family: 'pink',
		hex_stops: ['#ff00ff']
	},
	{ name_en: 'Pink', name_uk: 'Рожевий', family: 'pink', hex_stops: ['#ed64a6'] },
	{ name_en: 'Sakura Pink', name_uk: 'Рожева сакура', family: 'pink', hex_stops: ['#ffb7c5'] },
	{ name_en: 'Skin', name_uk: 'Тілесний', family: 'brown', hex_stops: ['#e8beac'] },
	{ name_en: 'Brown', name_uk: 'Коричневий', family: 'brown', hex_stops: ['#8b5e3c'] },
	{
		name_en: 'Dark Brown',
		name_uk: 'Темно-коричневий',
		family: 'brown',
		hex_stops: ['#4b3621'],
		synonyms: ['Каштановий']
	},
	{
		name_en: 'Light Brown',
		name_uk: 'Світло-коричневий',
		family: 'brown',
		hex_stops: ['#b5651d']
	},
	{
		name_en: 'Coffee',
		name_uk: 'Кавовий',
		family: 'brown',
		hex_stops: ['#6f4e37'],
		synonyms: ['Кавово-коричневий']
	},
	{ name_en: 'Chocolate', name_uk: 'Шоколадний', family: 'brown', hex_stops: ['#7b3f00'] },
	{ name_en: 'Walnut', name_uk: 'Горіх', family: 'brown', hex_stops: ['#5c4033'] },
	{ name_en: 'Oak', name_uk: 'Дубовий', family: 'brown', hex_stops: ['#c8a165'] },
	{ name_en: 'Maple', name_uk: 'Клен', family: 'brown', hex_stops: ['#d9a066'] },
	{ name_en: 'Gold', name_uk: 'Золотий', family: 'gold', hex_stops: ['#d4af37'] },
	{ name_en: 'Rose Gold', name_uk: 'Рожеве золото', family: 'gold', hex_stops: ['#b76e79'] },
	{ name_en: 'Champagne', name_uk: 'Шампань', family: 'gold', hex_stops: ['#f7e7ce'] },
	{ name_en: 'Bronze', name_uk: 'Бронзовий', family: 'gold', hex_stops: ['#cd7f32'] },
	{ name_en: 'Copper', name_uk: 'Мідний', family: 'gold', hex_stops: ['#b87333'] },
	// Metallic finishes are their own colours, not spellings of the plain ones: Kingroon's
	// PETG carries "Сріблястий" and "Металік сріблястий" as two separate variants of one
	// product, so folding them together collided on the slug.
	{
		name_en: 'Metallic Copper',
		name_uk: 'Металік мідний',
		family: 'gold',
		hex_stops: ['#a55a2a', '#e0a070']
	},
	{
		name_en: 'Silver',
		name_uk: 'Сріблястий',
		family: 'silver',
		hex_stops: ['#c0c0c0'],
		synonyms: ['Срібний']
	},
	{
		name_en: 'Metallic Silver',
		name_uk: 'Металік сріблястий',
		family: 'silver',
		hex_stops: ['#9a9a9a', '#e8e8e8']
	},
	{
		name_en: 'Clear',
		name_uk: 'Безбарвний',
		family: 'transparent',
		hex_stops: ['#e8f4f8'],
		synonyms: ['Прозорий']
	},
	// Multi-colour: `hex_stops` order is what the conic swatch is painted from.
	{
		name_en: 'Rainbow',
		name_uk: 'Веселка',
		family: 'multicolor',
		hex_stops: ['#e53e3e', '#ecc94b', '#38a169', '#3182ce', '#805ad5'],
		synonyms: ['Веселковий']
	},

	// ---------------------------------------------------------------------------------
	// Added 2026-09-05 from the 49 spellings `normalize-variant-colors.js` could not match on
	// a production dump. The catalogue is frozen while this work lands, so the set is closed:
	// every entry below exists to cover one exact stored value, carried verbatim in `synonyms`.
	//
	// Two variants on Kingroon PLA Silk Rainbow are both stored as "Candy" and are deliberately
	// NOT covered: one product cannot give two variants the same colour without colliding on
	// the variant slug, and which is which is a question about the photographs. See
	// fix-known-data-defects.js.
	// ---------------------------------------------------------------------------------
	// Dual-Silk: two-tone shifts on one product, so each needs its own `name_en` or their slugs collide.
	{
		name_en: 'Red Gold Silk',
		name_uk: 'Червоно-золотистий',
		family: 'multicolor',
		hex_stops: ['#c0392b', '#d4af37'],
		synonyms: ['Червоно-золотистий', 'Червоно-золотий']
	},
	{
		name_en: 'Red Green Silk',
		name_uk: 'Червоно-зелений',
		family: 'multicolor',
		hex_stops: ['#c0392b', '#2e8b57'],
		synonyms: ['Червоно-зелений']
	},
	{
		name_en: 'Red Blue Silk',
		name_uk: 'Червоно-синій',
		family: 'multicolor',
		hex_stops: ['#c0392b', '#2b4fa2'],
		synonyms: ['Червоно-синій']
	},
	{
		name_en: 'Gold Silver Silk',
		name_uk: 'Золотисто-срібний',
		family: 'multicolor',
		hex_stops: ['#d4af37', '#c0c4c8'],
		synonyms: ['Золотисто-срібний', 'Золото-срібний']
	},
	{
		name_en: 'Gold Purple Silk',
		name_uk: 'Золотисто-фіолетовий',
		family: 'multicolor',
		hex_stops: ['#d4af37', '#7b4fa8'],
		synonyms: ['Золотисто-фіолетовий']
	},
	{
		name_en: 'Black Gold Silk',
		name_uk: 'Чорно-золотистий',
		family: 'multicolor',
		hex_stops: ['#1f1f1f', '#d4af37'],
		synonyms: ['Чорно-золотистий', 'Чорно-золотий']
	},
	{
		name_en: 'Black Red Silk',
		name_uk: 'Чорно-червоний',
		family: 'multicolor',
		hex_stops: ['#1f1f1f', '#c0392b'],
		synonyms: ['Чорно-червоний']
	},
	{
		name_en: 'Black Green Silk',
		name_uk: 'Чорно-зелений',
		family: 'multicolor',
		hex_stops: ['#1f1f1f', '#2e8b57'],
		synonyms: ['Чорно-зелений']
	},
	{
		name_en: 'Dual Silk HC186',
		name_uk: 'Двоколірний шовк HC186',
		family: 'multicolor',
		hex_stops: ['#c0c4c8', '#7e848a'],
		synonyms: ['HC186', 'HC-186']
	},

	// Tri-Silk: three-tone shifts, fourteen variants on one product.
	{
		name_en: 'Red Yellow Blue Silk',
		name_uk: 'Червоно-жовто-синій',
		family: 'multicolor',
		hex_stops: ['#c0392b', '#e3c04a', '#2b4fa2'],
		synonyms: ['Червоно-жовто-синій']
	},
	{
		name_en: 'Red Green Blue Silk',
		name_uk: 'Червоно-зелено-синій',
		family: 'multicolor',
		hex_stops: ['#c0392b', '#2e8b57', '#2b4fa2'],
		synonyms: ['Червоно-зелено-синій']
	},
	{
		name_en: 'Yellow Blue Green Silk',
		name_uk: 'Жовто-синьо-зелений',
		family: 'multicolor',
		hex_stops: ['#e3c04a', '#2b4fa2', '#2e8b57'],
		synonyms: ['Жовто-синьо-зелений']
	},
	{
		name_en: 'Gold Green Pink Silk',
		name_uk: 'Золотисто-зелено-рожевий',
		family: 'multicolor',
		hex_stops: ['#d4af37', '#2e8b57', '#dd8fa6'],
		synonyms: ['Золотисто-зелено-рожевий']
	},
	{
		name_en: 'Gold Silver Copper Silk',
		name_uk: 'Золотисто-срібно-мідний',
		family: 'multicolor',
		hex_stops: ['#d4af37', '#c0c4c8', '#b87333'],
		synonyms: ['Золотисто-срібно-мідний']
	},
	{
		name_en: 'Green Purple Copper Silk',
		name_uk: 'Зелено-фіолетово-мідний',
		family: 'multicolor',
		hex_stops: ['#2e8b57', '#7b4fa8', '#b87333'],
		synonyms: ['Зелено-фіолетово-мідний']
	},
	{
		name_en: 'Red Gold Blue Silk',
		name_uk: 'Червоно-золотисто-синій',
		family: 'multicolor',
		hex_stops: ['#c0392b', '#d4af37', '#2b4fa2'],
		synonyms: ['Червоно-золотисто-синій']
	},
	{
		name_en: 'Black Blue Purple Silk',
		name_uk: 'Чорно-синьо-фіолетовий',
		family: 'multicolor',
		hex_stops: ['#1f1f1f', '#2b4fa2', '#7b4fa8'],
		synonyms: ['Чорно-синьо-фіолетовий']
	},
	{
		name_en: 'Red Gold Purple Silk',
		name_uk: 'Червоно-золотисто-фіолетовий',
		family: 'multicolor',
		hex_stops: ['#c0392b', '#d4af37', '#7b4fa8'],
		synonyms: ['Червоно-золотисто-фіолетовий']
	},
	{
		name_en: 'Blue Green Orange Silk',
		name_uk: 'Синьо-зелено-помаранчевий',
		family: 'multicolor',
		hex_stops: ['#2b4fa2', '#2e8b57', '#d9772f'],
		synonyms: ['Синьо-зелено-помаранчевий', 'Синьо-зелено-оранжевий']
	},
	{
		name_en: 'Gold Magenta Black Silk',
		name_uk: 'Золотисто-пурпурово-чорний',
		family: 'multicolor',
		hex_stops: ['#d4af37', '#a53a7a', '#1f1f1f'],
		synonyms: ['Золотисто-пурпурово-чорний', 'Золотисто-пурпурно-чорний']
	},
	{
		name_en: 'Gold Magenta Blue Silk',
		name_uk: 'Золотисто-пурпурово-синій',
		family: 'multicolor',
		hex_stops: ['#d4af37', '#a53a7a', '#2b4fa2'],
		synonyms: ['Золотисто-пурпурово-синій', 'Золотисто-пурпурно-синій']
	},
	{
		name_en: 'Gold Green Black Silk',
		name_uk: 'Золотисто-зелено-чорний',
		family: 'multicolor',
		hex_stops: ['#d4af37', '#2e8b57', '#1f1f1f'],
		synonyms: ['Золотисто-зелено-чорний']
	},
	{
		name_en: 'Magenta Blue Green Silk',
		name_uk: 'Пурпурово-синьо-зелений',
		family: 'multicolor',
		hex_stops: ['#a53a7a', '#2b4fa2', '#2e8b57'],
		synonyms: ['Пурпурово-синьо-зелений', 'Пурпурно-синьо-зелений']
	},

	// Silk Rainbow blends, sold under marketing names.
	{
		name_en: 'Universe Silk',
		name_uk: 'Космічний перелив',
		family: 'multicolor',
		hex_stops: ['#141433', '#3c2a7a', '#6a3fa0', '#1f4f8f'],
		synonyms: ['Universe']
	},
	{
		name_en: 'Macaron Silk',
		name_uk: 'Пастельний макарун',
		family: 'multicolor',
		hex_stops: ['#f6c6d7', '#fbe7a8', '#c3e6c9', '#c2d8f2'],
		synonyms: ['Macaron']
	},
	{
		name_en: 'Forest Silk',
		name_uk: 'Лісовий зелений',
		family: 'green',
		hex_stops: ['#1f4d2e', '#3f7d4b', '#8fbf6a'],
		synonyms: ['Forest']
	},
	{
		name_en: 'Lovely Silk',
		name_uk: 'Ніжно-рожевий перелив',
		family: 'multicolor',
		hex_stops: ['#f7b0c0', '#ea7d95', '#f3c6a1'],
		synonyms: ['Lovely']
	},

	// Fluorescent and neon: single bright tones.
	{
		name_en: 'Fluorescent Yellow',
		name_uk: 'Флуоресцентний жовтий',
		family: 'yellow',
		hex_stops: ['#e6f43c'],
		synonyms: ['Флуоресцентний жовтий', 'Флуорисцентний жовтий']
	},
	{
		name_en: 'Fluorescent Blue',
		name_uk: 'Флуоресцентний синій',
		family: 'blue',
		hex_stops: ['#2b7ae5'],
		synonyms: ['Флуоресцентний синій', 'Флуорисцентний синій']
	},
	{
		name_en: 'Fluorescent Red',
		name_uk: 'Флуоресцентний червоний',
		family: 'red',
		hex_stops: ['#f5402a'],
		synonyms: ['Флуоресцентний червоний', 'Флуорисцентний червоний']
	},
	{
		name_en: 'Neon Green',
		name_uk: 'Неоново-зелений',
		family: 'green',
		hex_stops: ['#5cd93a'],
		synonyms: ['Неоново-зелений', 'Неоновий зелений']
	},

	// One-off finishes.
	{
		name_en: 'Marble',
		name_uk: 'Мармуровий',
		family: 'white',
		hex_stops: ['#f4f3f0', '#9aa1a8'],
		synonyms: ['Мармур']
	},
	{
		name_en: 'Combustion Titanium',
		name_uk: 'Темний титан',
		family: 'gray',
		hex_stops: ['#2f343a', '#7b828a'],
		synonyms: ['Combustion Titanium']
	},
	{
		name_en: 'Ceramic',
		name_uk: 'Керамічний',
		family: 'white',
		hex_stops: ['#ece4d8'],
		synonyms: ['Керамічний', 'Кераміка']
	},
	{
		name_en: 'Natural Wood',
		name_uk: 'Натуральне дерево',
		family: 'brown',
		hex_stops: ['#c2a887'],
		synonyms: ['Звичайне']
	},

	// Sunlu rainbow series: four numbered blends on one product, four distinct entries.
	{
		name_en: 'Rainbow R1',
		name_uk: 'Веселковий R1',
		family: 'multicolor',
		hex_stops: ['#d94f4f', '#e08a3c', '#e3c74a', '#4f9e5c', '#3f6cb5'],
		synonyms: ['Веселковий R1']
	},
	{
		name_en: 'Rainbow R2',
		name_uk: 'Веселковий R2',
		family: 'multicolor',
		hex_stops: ['#3fa08f', '#3f8fc4', '#4f63b8', '#7a56ab'],
		synonyms: ['Веселковий R2']
	},
	{
		name_en: 'Rainbow R3',
		name_uk: 'Веселковий R3',
		family: 'multicolor',
		hex_stops: ['#f0a3b8', '#f3d79a', '#a8d5c2'],
		synonyms: ['Веселковий R3']
	},
	{
		name_en: 'Rainbow R4',
		name_uk: 'Веселковий R4',
		family: 'multicolor',
		hex_stops: ['#57a85f', '#c9c04a', '#d0679f', '#8a4fa8'],
		synonyms: ['Веселковий R4']
	},

	// Sunlu transparent rainbow: the value stored is the manufacturer's code.
	{
		name_en: 'Transparent Rainbow TR-1',
		name_uk: 'Прозорий веселковий TR-1',
		family: 'transparent',
		hex_stops: ['#cfe9f2', '#d9e7c8', '#f2e6c2'],
		synonyms: ['TR-1']
	},
	{
		name_en: 'Transparent Rainbow TR-2',
		name_uk: 'Прозорий веселковий TR-2',
		family: 'transparent',
		hex_stops: ['#e3d6f0', '#d3e2f5', '#cfeee8'],
		synonyms: ['TR-2']
	},
	{
		name_en: 'Transparent Rainbow TR-3',
		name_uk: 'Прозорий веселковий TR-3',
		family: 'transparent',
		hex_stops: ['#f6dfe6', '#f7ecd4', '#dcefdc', '#d6e6f6'],
		synonyms: ['TR-3']
	},
	{
		name_en: 'Transparent Rainbow TR-4',
		name_uk: 'Прозорий веселковий TR-4',
		family: 'transparent',
		hex_stops: ['#d9f0ea', '#e8f2cf', '#f7e2d2', '#e6d9f2'],
		synonyms: ['TR-4']
	},

	// Thermochromic: the value names both states, cold first.
	{
		name_en: 'Thermal Teal to Lime',
		name_uk: 'Синьо-зелений, при нагріванні жовто-зелений',
		family: 'multicolor',
		hex_stops: ['#2f8f86', '#b9cf46'],
		synonyms: ['Синьо-зелений -Жовто-зелений', 'Синьо-зелений-Жовто-зелений']
	},
	{
		name_en: 'Thermal Purple to Pink',
		name_uk: 'Фіолетовий, при нагріванні рожевий',
		family: 'multicolor',
		hex_stops: ['#7b4fa8', '#e07aa8'],
		synonyms: ['Фіолетовий-рожевий', 'Фіолетовий - рожевий']
	},
	{
		name_en: 'Thermal Blue to White',
		name_uk: 'Синій, при нагріванні білий',
		family: 'multicolor',
		hex_stops: ['#2f5fae', '#f2f4f7'],
		synonyms: ['Синій-білий', 'Синій - білий']
	},
	{
		name_en: 'Thermal Gray to White',
		name_uk: 'Сірий, при нагріванні білий',
		family: 'multicolor',
		hex_stops: ['#8a8f96', '#f4f5f6'],
		synonyms: ['Сірий-білий', 'Сірий - білий']
	}
]

/** Normalization shared with normalize-variant-colors.js. */
function normalizeColorValue(value) {
	if (typeof value !== 'string') return null
	const cleaned = value
		.normalize('NFC')
		// The data mixes typographic and straight apostrophes for the same word
		// ("М’ятний" / "М'ятний"), and the dash forms differ too.
		.replace(/[\u2018\u2019\u02BC\u02B9`´]/g, "'")
		.replace(/[\u2010-\u2015]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\s*\brefill\b\s*$/i, '')
		.replace(/^\s*(колір|кольор|цвет|color)\s*[:\-]?\s*/i, '')
		.trim()
	return cleaned === '' ? null : cleaned
}

/** Every spelling that resolves to a colour, lower-cased. */
function aliasesFor(color) {
	const en = color.name_en
	const uk = color.name_uk
	return [en, uk, `${en} ${uk}`, `${uk} ${en}`, ...(color.synonyms ?? [])]
		.map(a => normalizeColorValue(a))
		.filter(Boolean)
		.map(a => a.toLowerCase())
}

/** @returns Map<alias, name_en> — throws if two colours claim the same spelling. */
function buildAliasIndex(colors) {
	const index = new Map()
	for (const color of colors) {
		for (const alias of aliasesFor(color)) {
			const owner = index.get(alias)
			if (owner && owner !== color.name_en) {
				throw new Error(
					`Alias "${alias}" is claimed by both "${owner}" and "${color.name_en}"`
				)
			}
			index.set(alias, color.name_en)
		}
	}
	return index
}

function slugFor(nameEn) {
	return nameEn
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
}

async function migrate(db) {
	const colors = db.collection('colors')

	// Fails loudly rather than seeding a dictionary two spellings disagree about.
	buildAliasIndex(COLORS)

	const existing = await colors.find({}).project({ name_en: 1 }).toArray()
	const existingNames = new Set(existing.map(c => c.name_en))

	const toInsert = COLORS.filter(c => !existingNames.has(c.name_en)).map((c, index) => ({
		name_en: c.name_en,
		name_uk: c.name_uk,
		slug: slugFor(c.name_en),
		family: c.family,
		hex_stops: c.hex_stops.map(h => h.toLowerCase()),
		order: existingNames.size + index,
		createdAt: new Date(),
		updatedAt: new Date()
	}))

	console.log(`Dictionary: ${COLORS.length} defined, ${existingNames.size} already stored.`)
	const byFamily = new Map()
	for (const c of COLORS) byFamily.set(c.family, (byFamily.get(c.family) ?? 0) + 1)
	console.log('By family:', [...byFamily].map(([f, n]) => `${f}=${n}`).join(', '))

	if (toInsert.length === 0) {
		console.log('\nNothing to do.')
		return true
	}

	console.log(`\nPlan: insert ${toInsert.length} colour(s).`)
	for (const c of toInsert) console.log(`  + ${c.name_en} (${c.name_uk}) — ${c.family}`)

	if (DRY_RUN) {
		console.log('\nDry run complete — nothing was changed.')
		return true
	}

	const res = await colors.insertMany(toInsert, { ordered: false })
	console.log(`\nInserted ${res.insertedCount} colour(s).`)

	const total = await colors.countDocuments()
	console.log('\nVerify:')
	const ok = total >= COLORS.length
	console.log(`  ${ok ? 'OK ' : 'FAIL'} colours stored: ${total} (expected ≥ ${COLORS.length})`)
	if (ok) console.log('\nDone. Next: normalize-variant-colors.js --dry-run')
	return ok
}

async function main() {
	require('dotenv').config()
	const DATABASE_URL = process.env.DATABASE_URL
	if (!DATABASE_URL) {
		console.error('DATABASE_URL is not set. Check your .env file.')
		process.exit(1)
	}

	await mongoose.connect(DATABASE_URL)
	let ok = false
	try {
		const db = mongoose.connection.db
		console.log(
			`Connected to MongoDB: database "${db.databaseName}" on ${mongoose.connection.host}.${DRY_RUN ? ' (dry run)' : ''}`
		)
		ok = await migrate(db)
	} finally {
		await mongoose.disconnect()
	}

	if (!ok) process.exit(1)
}

module.exports = { COLORS, normalizeColorValue, aliasesFor, buildAliasIndex, slugFor }

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}

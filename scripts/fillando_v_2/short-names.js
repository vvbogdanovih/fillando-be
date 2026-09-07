/**
 * Short product names for migration 3k (`rename-products-short.js`), keyed by the long SEO name
 * the catalogue stores today. Generated once with `--propose` from the strip rule
 * (`proposeShortName`), then reviewed by hand and committed — the same way `landing-copy.js`
 * carries reviewed text through review like code.
 *
 * Keyed by the name, not the id: ids differ between dev and production, and the refill product
 * is created per environment by step 3d with a deterministic name.
 *
 * Rules the spec enforces: every value is unique, none carries the long prefix, and every value
 * equals `proposeShortName(key)` unless the key is listed in `REVIEWED_EDITS`. A product with
 * the prefix and no entry here makes the migration refuse rather than guess.
 *
 * Reviewed 2026-09-06 against `fillando-dev` (43 products). Decisions worth knowing:
 * - «(еко-пакування)», «(CoPET)», «(напівпрозорий)», «Carbon Fiber», «15%», «для AMS» stay —
 *   they distinguish products or are part of the manufacturer's own name;
 * - «3 кг» stays: without it the 3 kg reel would share a name (and its variants an address)
 *   with the 1 kg one; 1 кг is the category default the page already states;
 * - «PA6 Nylon (нейлон)» → «PA6 Nylon»: the gloss belongs in the description.
 */
const SHORT_NAMES = {
	// attrs: Bambu Lab / ABS / Basic
	'Філамент (пластик для 3D принтера) Bambu Lab ABS 1,75 мм 1 кг': 'Bambu Lab ABS',
	// attrs: Bambu Lab / ABS / Basic
	'Філамент (пластик для 3D принтера) Bambu Lab ABS-GF 1,75 мм 1 кг': 'Bambu Lab ABS-GF',
	// attrs: Bambu Lab / PA6 / Basic
	'Філамент (пластик для 3D принтера) Bambu Lab PA6-CF 1,75 мм 1 кг': 'Bambu Lab PA6-CF',
	// attrs: Bambu Lab / PET / Basic
	'Філамент (пластик для 3D принтера) Bambu Lab PET-CF 1,75 мм 1 кг': 'Bambu Lab PET-CF',
	// attrs: Bambu Lab / PETG / Basic
	'Філамент (пластик для 3D принтера) Bambu Lab PETG Basic 1,75 мм 1 кг': 'Bambu Lab PETG Basic',
	// attrs: Bambu Lab / PETG / Basic
	'Філамент (пластик для 3D принтера) Bambu Lab PETG Translucent (напівпрозорий) 1,75 мм 1 кг':
		'Bambu Lab PETG Translucent (напівпрозорий)',
	// attrs: Bambu Lab / PETG / Basic
	'Філамент (пластик для 3D принтера) Bambu Lab PETG-CF Carbon Fiber 1,75 мм 1 кг':
		'Bambu Lab PETG-CF Carbon Fiber',
	// attrs: Bambu Lab / PLA / Basic
	'Філамент (пластик для 3D принтера) Bambu Lab PLA Basic 1,75 мм 1 кг': 'Bambu Lab PLA Basic',
	// attrs: Bambu Lab / PLA / Glow / Basic
	'Філамент (пластик для 3D принтера) Bambu Lab PLA Glow 1,75 мм 1 кг': 'Bambu Lab PLA Glow',
	// attrs: Bambu Lab / PLA / Lite
	'Філамент (пластик для 3D принтера) Bambu Lab PLA Lite 1,75 мм 1 кг': 'Bambu Lab PLA Lite',
	// attrs: Bambu Lab / PLA / Matte / Basic
	'Філамент (пластик для 3D принтера) Bambu Lab PLA Matte 1,75 мм 1 кг': 'Bambu Lab PLA Matte',
	// attrs: Bambu Lab / PLA / Silk / Plus
	'Філамент (пластик для 3D принтера) Bambu Lab PLA Silk+ 1,75 мм 1 кг': 'Bambu Lab PLA Silk+',
	// attrs: Bambu Lab / PLA / Basic
	'Філамент (пластик для 3D принтера) Bambu Lab PLA-CF 1,75 мм 1 кг': 'Bambu Lab PLA-CF',
	// attrs: Bambu Lab / TPU / Basic
	'Філамент (пластик для 3D принтера) Bambu Lab TPU для AMS 1,75 мм 1 кг':
		'Bambu Lab TPU для AMS',
	// attrs: Kingroon / ABS / Basic
	'Філамент (пластик для 3D принтера) Kingroon ABS 1,75 мм 1 кг': 'Kingroon ABS',
	// attrs: Kingroon / ASA / Basic
	'Філамент (пластик для 3D принтера) Kingroon ASA 1,75 мм 1 кг': 'Kingroon ASA',
	// attrs: Kingroon / PA6 / Basic
	'Філамент (пластик для 3D принтера) Kingroon PA-CF 15% 1,75 мм 1 кг': 'Kingroon PA-CF 15%',
	// attrs: Kingroon / PA6 / Basic
	'Філамент (пластик для 3D принтера) Kingroon PA6 Nylon (нейлон) 1,75 мм 1 кг':
		'Kingroon PA6 Nylon', // edited: the Ukrainian gloss belongs to the description, the name is the one Kingroon prints
	// attrs: Kingroon / PETG / Basic
	'Філамент (пластик для 3D принтера) Kingroon PETG (CoPET) 1,75 мм 1 кг':
		'Kingroon PETG (CoPET)',
	// attrs: Kingroon / PETG / Basic
	'Філамент (пластик для 3D принтера) Kingroon PETG (CoPET) 1,75 мм 1 кг (еко-пакування)':
		'Kingroon PETG (CoPET) (еко-пакування)',
	// attrs: Kingroon
	'Філамент (пластик для 3D принтера) Kingroon PETG (CoPET) 1,75 мм 3 кг':
		'Kingroon PETG (CoPET) 3 кг',
	// attrs: Kingroon / PETG / High Speed
	'Філамент (пластик для 3D принтера) Kingroon PETG High Speed 1,75 мм 1 кг':
		'Kingroon PETG High Speed',
	// attrs: Kingroon / PETG / Basic
	'Філамент (пластик для 3D принтера) Kingroon PETG-CF 1,75 мм 1 кг': 'Kingroon PETG-CF',
	// attrs: Kingroon / PLA / Basic
	'Філамент (пластик для 3D принтера) Kingroon PLA 1,75 мм 1 кг': 'Kingroon PLA',
	// attrs: Kingroon / PLA / Dual-Silk / Basic
	'Філамент (пластик для 3D принтера) Kingroon PLA Dual-Silk 1,75 мм 1 кг':
		'Kingroon PLA Dual-Silk',
	// attrs: Kingroon / PLA / Gradient / Basic
	'Філамент (пластик для 3D принтера) Kingroon PLA Gradient 1,75 мм 1 кг':
		'Kingroon PLA Gradient',
	// attrs: Kingroon / PLA / High Speed
	'Філамент (пластик для 3D принтера) Kingroon PLA High Speed 1,75 мм 1 кг':
		'Kingroon PLA High Speed',
	// attrs: Kingroon / PLA / Luminous / Basic
	'Філамент (пластик для 3D принтера) Kingroon PLA Luminous 1,75 мм 1 кг':
		'Kingroon PLA Luminous',
	// attrs: Kingroon / PLA / Matte / Basic
	'Філамент (пластик для 3D принтера) Kingroon PLA Matte 1,75 мм 1 кг': 'Kingroon PLA Matte',
	// attrs: Kingroon / PLA / Matte+Rainbow / Basic
	'Філамент (пластик для 3D принтера) Kingroon PLA Matte Rainbow 1,75 мм 1 кг':
		'Kingroon PLA Matte Rainbow',
	// attrs: Kingroon / PLA / Plus
	'Філамент (пластик для 3D принтера) Kingroon PLA Plus 1,75 мм 1 кг': 'Kingroon PLA Plus',
	// attrs: Kingroon / PLA / Silk / Basic
	'Філамент (пластик для 3D принтера) Kingroon PLA Silk 1,75 мм 1 кг': 'Kingroon PLA Silk',
	// attrs: Kingroon / PLA / Silk+Rainbow / Basic
	'Філамент (пластик для 3D принтера) Kingroon PLA Silk Rainbow 1,75 мм 1 кг':
		'Kingroon PLA Silk Rainbow',
	// attrs: Kingroon / PLA / Temperature Changing / Basic
	'Філамент (пластик для 3D принтера) Kingroon PLA Temperature Changing 1,75 мм 1 кг':
		'Kingroon PLA Temperature Changing',
	// attrs: Kingroon / PLA / Tri-Silk / Basic
	'Філамент (пластик для 3D принтера) Kingroon PLA Tri-Silk 1,75 мм 1 кг':
		'Kingroon PLA Tri-Silk',
	// attrs: Kingroon / PLA / Basic
	'Філамент (пластик для 3D принтера) Kingroon PLA-CF 1,75 мм 1 кг': 'Kingroon PLA-CF',
	// attrs: Kingroon / TPU / Basic
	'Філамент (пластик для 3D принтера) Kingroon TPU 1,75 мм 1 кг': 'Kingroon TPU',
	// attrs: Kingroon / PLA / Wood / Basic
	'Філамент (пластик для 3D принтера) Kingroon Wood PLA 1,75 мм 1 кг': 'Kingroon Wood PLA',
	// attrs: Sunlu / PETG / Basic
	'Філамент (пластик для 3D принтера) Sunlu PETG 1,75 мм 1 кг': 'Sunlu PETG',
	// attrs: Sunlu / PLA / Basic
	'Філамент (пластик для 3D принтера) Sunlu PLA 1,75 мм 1 кг': 'Sunlu PLA',
	// attrs: Sunlu / PLA / Rainbow / Basic
	'Філамент (пластик для 3D принтера) Sunlu PLA Rainbow 1,75 мм 1 кг': 'Sunlu PLA Rainbow',
	// attrs: Sunlu / PLA / Rainbow / Basic
	'Філамент (пластик для 3D принтера) Sunlu PLA Transparent Rainbow 1,75 мм 1 кг':
		'Sunlu PLA Transparent Rainbow',
	// attrs: Sunlu / PLA / Wood / Basic
	'Філамент (пластик для 3D принтера) Sunlu Wood PLA 1,75 мм 1 кг': 'Sunlu Wood PLA',
	// created by split-refill-products.js (3d); the suffix must survive, or the refill and its parent would share a name and their variants an address
	'Філамент (пластик для 3D принтера) Bambu Lab PETG Translucent (напівпрозорий) 1,75 мм 1 кг (без котушки)':
		'Bambu Lab PETG Translucent (напівпрозорий) (без котушки)'
}

/** Keys whose value deliberately differs from `proposeShortName` — the reviewer's decisions. */
const REVIEWED_EDITS = [
	'Філамент (пластик для 3D принтера) Kingroon PA6 Nylon (нейлон) 1,75 мм 1 кг'
]

module.exports = { SHORT_NAMES, REVIEWED_EDITS }

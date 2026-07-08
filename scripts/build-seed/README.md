# Bulk food-seed builder

Regenerates `pb_migrations/1720000004_foods_bulk.js` — the ~1,800-row predefined food
database — from **USDA FoodData Central**. All USDA FDC data is **public domain**
(`usa.gov/publicdomain/label/1.0`), so the generated seed is safe to redistribute in this
MIT-licensed image with no attribution or share-alike obligations.

## What it does

Pulls four USDA datasets and distills them into a curated base suite:

| Source | Contributes | Notes |
|---|---|---|
| Foundation Foods | whole foods | highest-quality nutrient analysis |
| SR Legacy | whole foods | deduped to one plain representative per base food |
| FNDDS / Survey | "as-eaten" mixed dishes | e.g. mac & cheese, burritos; ships portion weights |
| Branded Foods | major-US-brand staples | filtered to a brand whitelist, deduped, with UPC barcodes |

It converts USDA per-100g nutrients to per-serving using each food's portion/serving data,
picks the most household-friendly measure, and writes the migration with rows in Sate's terse
format: `[name, brand, serving_desc, serving_g, kcal, protein, carbs, fat, category, aliases, barcode]`.
The migration is idempotent — it skips any `norm_key` already present, so it never duplicates the
hand-curated seed in `1720000002` or user-added foods.

## Regenerating

1. Download the CSV bundles from https://fdc.nal.usda.gov/download-datasets/ :
   - `FoodData_Central_foundation_food_csv_*.zip`
   - `FoodData_Central_sr_legacy_food_csv_*.zip`
   - `FoodData_Central_survey_food_csv_*.zip`
   - `FoodData_Central_branded_food_csv_*.zip`
2. Unzip each into a directory (default `./usda`), keeping USDA's nested folder layout.
   If your USDA release dates differ from the ones hardcoded near the top of `build_seed.py`,
   update the `SR/FO/SV/BR` folder names to match.
3. Run:
   ```sh
   SATE_USDA_DIR=./usda SATE_OUT=../../pb_migrations/1720000004_foods_bulk.js python3 build_seed.py
   ```

No third-party Python packages required (stdlib only).

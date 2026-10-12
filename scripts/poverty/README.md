# Poverty overlay (data/poverty/)

Source: Diéguez, Málaga & Romero (2025), *Mapa de Pobreza de Panamá para 2022* (MEF / World Bank), technical report
https://documentos.bancomundial.org/es/publication/documents-reports/documentdetail/099043025143034152
and its online annex (corregimiento tables) http://documents.worldbank.org/curated/en/099042925123538272

1. `parse.py` — extracts the corregimiento table (699 rows: population, income, moderate/extreme poverty FGT0-2, GE, Gini) from the annex PDF text.
2. `join.py` — matches rows to Census 2023 corregimiento polygons (one-to-one assignment per province on name + district + population; Penonomé's post-2019 corregimientos are matched on population).
3. `export.py` — writes `corregimientos_poverty.geojson` (simplified) and `summary.json`, crossing poverty with the ShakeMap population-exposure table (`data/risk/exposure_corr_census2023.csv`).

Run from the session scratchpad (`pov/`, `risk/`) — paths are relative to it. Checks: population total 4,008,473 and population-weighted poverty 24.9% equal the report's national figures.

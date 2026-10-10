# Panama earthquake monitor (M7.7 Azuero, 9 Oct 2026)

**For preliminary analytical use only. Not for public distribution.** The site opens with an access-code landing page (a courtesy screen, not security — the repository and data files are public).

**Preliminary and unofficial.** This is a living situational-awareness page compiled from public internet sources: USGS, news, official statements as quoted in the media, and social media. It is not a formal damage or risk assessment, and it is not a product of the Government of Panama, the World Bank or any other institution. Contact: Brenden Jongman.

Live site: https://sismopanama.org (the original https://brenden-jon.github.io/Panama_earthquake/ redirects there)

## What updates, and how

| Content | Source | Cadence | Mechanism |
|---|---|---|---|
| Aftershocks | USGS FDSN API | every 2 min | fetched live in the visitor's browser |
| News stream, PAGER/ShakeMap versions, GDACS | Google News RSS, USGS, GDACS | every 15 min | GitHub Action `.github/workflows/update.yml` → `scripts/update_feeds.py` |
| Curated impact reports, official figures, overview text | News, official channels, social media | regularly | edited by the curation agent (Claude) and pushed |
| Exposure / indicative damage | ShakeMap × WorldPop/Census 2023 × MS building footprints | on new ShakeMap version | `data/risk/exposure.py` (needs large rasters, run locally) |

## Files to edit by hand

- `data/official_totals.json`: append a snapshot whenever SINAPROC, MINSA or Presidencia publishes figures. The newest snapshot drives the "Officially reported figures" tiles.
- `data/highlights.json`: headline, key points, area summaries, service status.
- `raw/reports_*.json`: curated impact reports. Every item needs a source URL; add new batches as new files, e.g. `raw/reports_update_2026-10-10T02.json`.
- `raw/image_review.json`: visual check of each image (`damage` / `event` / `generic` / `broken`). Images marked `generic` or `broken` are hidden.

After editing, run `python3 scripts/build_data.py` and commit. After changing `index.html`/`assets/`, run `scripts/bump_assets.sh` so browsers fetch the new files.

## Local preview

```
python3 -m http.server 8765
```

"""Assemble the dashboard data files from curated inputs.

Inputs
  raw/reports_*.json        curated impact reports (news, social, official); any file matching the glob is merged
  data/official_totals.json time series of official figures (edit by hand / by update agent)
  data/risk/exposure_adm2.csv  ShakeMap x population/buildings exposure (scripts in data/risk/exposure.py)
  data/usgs/pager_*.json    USGS PAGER snapshot

Outputs
  data/reports.json   merged, de-duplicated-by-id report list, newest first
  data/summary.json   headline numbers for the front page
  data/districts.json per-district exposure + indicative damage ranges
"""
import csv, glob, json, os
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = lambda *p: os.path.join(ROOT, *p)
NOW = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# Indicative share of buildings reaching a damage state, by MMI class.
# Rule-of-thumb ranges for a mixed stock (confined masonry / RC frame with a
# minority of adobe, quincha and unreinforced block), broadly consistent with
# PAGER structure-type collapse rates and EMS-98 descriptions. NOT a calibrated
# fragility model; replace with GEM vulnerability when available.
RATES = {  # mmi_class: (moderate+ low, high, heavy/collapse low, high)
    6: (0.01, 0.04, 0.000, 0.003),
    7: (0.05, 0.15, 0.003, 0.015),
    8: (0.15, 0.35, 0.02, 0.07),
    9: (0.30, 0.55, 0.06, 0.15),
}
# Used only for the "+1 intensity level" sensitivity case (class IX shifted up).
RATE_X = (0.45, 0.70, 0.12, 0.25)


def load_reports():
    seen, out = set(), []
    rev_path = D("raw", "image_review.json")
    review = json.load(open(rev_path)) if os.path.exists(rev_path) else {}
    for f in glob.glob(D("raw", "reports_*.json")):  # batches may carry their own image_review
        review.update(json.load(open(f)).get("image_review", {}))
    for f in sorted(glob.glob(D("raw", "reports_*.json"))):
        for r in json.load(open(f))["reports"]:
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            r.setdefault("figures", {})
            r.setdefault("image_url", None)
            r.setdefault("added_utc", NOW)
            if r.get("reported_utc") and r["reported_utc"] > NOW:  # drop future timestamps (mislabelled local times)
                r["reported_utc"] = None
            prov = (r.get("province") or "").strip()
            if not prov or prov.lower() in ("all", "nationwide", "national") or "," in prov or "/" in prov:
                r["province"] = "Multiple / national"
            v = review.get(r["id"])
            if v and r.get("image_url"):
                r["image_verdict"] = v["verdict"]
                r["image_caption"] = v.get("caption")
                if v["verdict"] in ("generic", "broken") or v.get("place_match") is False:
                    r["image_url"] = None
            out.append(r)
    out.sort(key=lambda r: r.get("reported_utc") or r.get("added_utc") or "", reverse=True)
    return out


def walls():
    f = D("data", "risk", "housing_walls_adm2_on_exposure_pcodes.csv")
    if not os.path.exists(f):
        return {}
    return {r["adm2_pcode"]: float(r["share_vulnerable_nonmasonry"]) for r in csv.DictReader(open(f))}


def districts():
    rows = []
    wall = walls()
    for r in csv.DictReader(open(D("data", "risk", "exposure_adm2.csv"))):
        num = {k: float(v) for k, v in r.items() if k.startswith(("pop", "bldg", "mean", "max", "centroid"))}
        if num["pop_mmi6plus"] < 1 and num["bldg_mmi5"] < 1:
            continue
        lo = hi = clo = chi = 0.0
        for m, (a, b, c, d) in RATES.items():
            n = num[f"bldg_mmi{m}"]
            lo += n * a; hi += n * b; clo += n * c; chi += n * d
        # Sensitivity: every building one intensity class higher (observations near
        # Penonomé and Santiago suggest the ShakeMap underestimates shaking there).
        shifted = {6: num["bldg_mmi5"], 7: num["bldg_mmi6"], 8: num["bldg_mmi7"], 9: num["bldg_mmi8"]}
        p1hi = sum(shifted[m] * RATES[m][1] for m in shifted) + num["bldg_mmi9"] * RATE_X[1]
        p1chi = sum(shifted[m] * RATES[m][3] for m in shifted) + num["bldg_mmi9"] * RATE_X[3]
        rows.append({
            "pcode": r["adm2_pcode"], "district": r["adm2_name"], "province": r["adm1_name"],
            "lat": num["centroid_lat"], "lon": num["centroid_lon"],
            "pop_total": round(num["pop23_total"]),
            **{f"pop_mmi{m}": round(num[f"pop23_mmi{m}"]) for m in (6, 7, 8, 9)},
            "pop_mmi7plus": round(num["pop23_mmi7plus"]),
            "bldg_total": round(num["bldg_total"]),
            **{f"bldg_mmi{m}": round(num[f"bldg_mmi{m}"]) for m in (6, 7, 8, 9)},
            "bldg_mmi7plus": round(num["bldg_mmi7plus"]),
            "mean_mmi": num["mean_mmi"], "max_mmi": num["max_mmi"], "max_pga": num["max_pga_pctg"],
            "nonblock_share": wall.get(r["adm2_pcode"]),
            "dmg_mod_lo": round(lo), "dmg_mod_hi": round(hi),
            "dmg_heavy_lo": round(clo), "dmg_heavy_hi": round(chi),
            "dmg_mod_hi_p1": round(p1hi), "dmg_heavy_hi_p1": round(p1chi),
        })
    rows.sort(key=lambda r: -(r["dmg_mod_lo"] + r["dmg_mod_hi"]))
    return rows


def main():
    reports = load_reports()
    dist = districts()
    official = json.load(open(D("data", "official_totals.json")))
    losses = json.load(open(D("data", "usgs", "pager_losses.json")))
    alerts = json.load(open(D("data", "usgs", "pager_alerts.json")))
    expo = json.load(open(D("data", "usgs", "pager_exposures.json")))
    pa = next(c for c in expo["population_exposure"]["country_exposures"] if c["country_code"] == "PA")["exposure"]

    tot = lambda k: sum(r[k] for r in dist)
    summary = {
        "generated_utc": NOW,
        "official_latest": official["snapshots"][-1] if official["snapshots"] else None,
        "official_snapshots": official["snapshots"],
        "conflicts": official.get("conflicts", []),
        "pager": {
            "fatality_alert": alerts["fatality"]["level"],
            "economic_alert": alerts["economic"]["level"],
            "fatality_bins": alerts["fatality"]["bins"],
            "economic_bins": alerts["economic"]["bins"],
            "fatalities_empirical": losses["empirical_fatality"]["total_fatalities"],
            "fatalities_semi_empirical": losses["semi_empirical_fatalities"]["fatalities"],
            "losses_usd_empirical": losses["empirical_economic"]["total_dollars"],
            "pop_exposure_pa_by_mmi": pa,
        },
        "exposure": {
            "pop_mmi6": tot("pop_mmi6"), "pop_mmi7": tot("pop_mmi7"),
            "pop_mmi8": tot("pop_mmi8"), "pop_mmi9": tot("pop_mmi9"),
            "pop_mmi7plus": tot("pop_mmi7plus"),
            "bldg_mmi6": tot("bldg_mmi6"), "bldg_mmi7": tot("bldg_mmi7"),
            "bldg_mmi8": tot("bldg_mmi8"), "bldg_mmi9": tot("bldg_mmi9"),
            "bldg_mmi7plus": tot("bldg_mmi7plus"),
            "dmg_mod_lo": tot("dmg_mod_lo"), "dmg_mod_hi": tot("dmg_mod_hi"),
            "dmg_heavy_lo": tot("dmg_heavy_lo"), "dmg_heavy_hi": tot("dmg_heavy_hi"),
            "dmg_mod_hi_p1": tot("dmg_mod_hi_p1"), "dmg_heavy_hi_p1": tot("dmg_heavy_hi_p1"),
            "rates": {str(k): v for k, v in RATES.items()},
        },
        "reports_count": len(reports),
        "reports_with_images": sum(1 for r in reports if r.get("image_url")),
        "places_with_damage": sorted({r["place"] for r in reports if r["category"] in ("building_damage", "injuries", "fatalities", "landslide")}),
    }
    json.dump({"generated_utc": NOW, "reports": reports}, open(D("data", "reports.json"), "w"), ensure_ascii=False, indent=1)
    json.dump(summary, open(D("data", "summary.json"), "w"), ensure_ascii=False, indent=1)
    json.dump(dist, open(D("data", "districts.json"), "w"), ensure_ascii=False, indent=1)
    print(f"{len(reports)} reports, {len(dist)} districts; moderate+ damage {summary['exposure']['dmg_mod_lo']:,}-{summary['exposure']['dmg_mod_hi']:,}")


if __name__ == "__main__":
    main()

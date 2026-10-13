"""Automatic feed refresh, run by .github/workflows/update.yml every 15 minutes.

Pulls machine-readable sources only (no judgement involved):
  - USGS: mainshock product versions + PAGER snapshot, aftershock list
  - Google News RSS (Spanish + English queries)
  - ReliefWeb API (reports tagged Panama)
  - GDACS event record
Writes data/news_feed.json (accumulating, de-duplicated) and data/usgs_status.json,
then re-runs build_data.py. Uses the standard library only.
"""
import email.utils, json, os, re, subprocess, sys, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = lambda *p: os.path.join(ROOT, *p)
EVENT = "us6000u18k"
T0 = datetime(2026, 10, 9, 17, 56, tzinfo=timezone.utc)
UA = {"User-Agent": "panama-eq-2026-dashboard/1.0 (preliminary situational awareness)"}
NOW = datetime.now(timezone.utc)

NEWS_QUERIES = [
    ("es", "sismo Panamá"), ("es", "terremoto Panamá"), ("es", "sismo Azuero"),
    ("es", "Sinaproc sismo"), ("es", "sismo Los Santos Tonosí"), ("es", "sismo Veraguas daños"),
    ("es", "sismo Herrera Chitré"), ("es", "sismo Penonomé"), ("es", "fallecidos sismo Panamá"),
    ("es", "damnificados sismo Panamá"), ("en", "Panama earthquake"),
]
KEYWORDS = re.compile(r"sismo|terremoto|temblor|r[eé]plica|earthquake|quake|aftershock|sinaproc", re.I)


def get(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def google_news():
    items = []
    for lang, q in NEWS_QUERIES:
        hl, gl, ceid = ("es-419", "PA", "PA:es-419") if lang == "es" else ("en-US", "US", "US:en")
        url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
            {"q": q + " when:2d", "hl": hl, "gl": gl, "ceid": ceid})
        try:
            root = ET.fromstring(get(url))
        except Exception as e:
            print("news fail", q, e, file=sys.stderr)
            continue
        for it in root.iter("item"):
            title = it.findtext("title") or ""
            pub = it.findtext("pubDate")
            try:
                dt = email.utils.parsedate_to_datetime(pub)
            except Exception:
                continue
            if dt < T0 or not KEYWORDS.search(title):
                continue
            src = it.find("source")
            items.append({
                "id": "gn:" + (it.findtext("guid") or it.findtext("link")),
                "kind": "news", "lang": lang,
                "title": re.sub(r"\s+-\s+[^-]+$", "", title),
                "source": src.text if src is not None else "",
                "url": it.findtext("link"), "published_utc": iso(dt),
            })
    return items


def reliefweb():
    body = json.dumps({
        "filter": {"operator": "AND", "conditions": [
            {"field": "country.iso3", "value": "pan"},
            {"field": "date.created", "value": {"from": iso(T0)}}]},
        "fields": {"include": ["title", "url", "source.shortname", "date.created", "format.name"]},
        "sort": ["date.created:desc"], "limit": 50}).encode()
    try:
        req = urllib.request.Request("https://api.reliefweb.int/v2/reports?appname=panama-eq-2026-dashboard",
                                     data=body, headers={**UA, "Content-Type": "application/json"})
        data = json.load(urllib.request.urlopen(req, timeout=30))
    except Exception as e:
        print("reliefweb fail", e, file=sys.stderr)
        return []
    out = []
    for r in data.get("data", []):
        f = r["fields"]
        out.append({"id": "rw:" + str(r["id"]), "kind": "humanitarian", "lang": "en",
                    "title": f["title"], "source": ", ".join(s["shortname"] for s in f.get("source", [])),
                    "url": f["url"], "published_utc": f["date"]["created"][:19] + "Z",
                    "format": (f.get("format") or [{}])[0].get("name")})
    return out


def usgs():
    status = {"checked_utc": iso(NOW)}
    try:
        ev = json.loads(get(f"https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/{EVENT}.geojson"))
        p = ev["properties"]
        status.update(mag=p["mag"], alert=p["alert"], mmi=p["mmi"], felt=p["felt"],
                      updated_utc=iso(datetime.fromtimestamp(p["updated"] / 1000, timezone.utc)))
        prods = p["products"]
        status["versions"] = {k: prods[k][0]["properties"].get("version") or prods[k][0]["updateTime"]
                              for k in ("shakemap", "losspager", "dyfi") if k in prods}
        old = {}
        if os.path.exists(D("data", "usgs_status.json")):
            old = json.load(open(D("data", "usgs_status.json"))).get("versions", {})
        pinned = os.path.exists(D("data", "usgs", "PINNED.json"))  # analyst kept an earlier ShakeMap/PAGER on purpose
        status["pinned"] = pinned
        if pinned:
            status["versions"] = old or status["versions"]
        if not pinned and "losspager" in prods and old.get("losspager") != status["versions"].get("losspager"):
            c = prods["losspager"][0]["contents"]
            for name in ("losses", "alerts", "exposures", "comments", "cities", "event"):
                key = f"json/{name}.json"
                if key in c:
                    open(D("data", "usgs", f"pager_{name}.json"), "wb").write(get(c[key]["url"]))
            status["pager_refreshed_utc"] = iso(NOW)
        if not pinned and "shakemap" in prods and old.get("shakemap") != status["versions"].get("shakemap"):
            c = prods["shakemap"][0]["contents"]
            open(D("data", "usgs", "cont_mmi.json"), "wb").write(get(c["download/cont_mmi.json"]["url"]))
            status["shakemap_refreshed_utc"] = iso(NOW)
            status["exposure_stale"] = True  # rerun data/risk/exposure.py locally (needs large rasters)
    except Exception as e:
        status["error"] = str(e)
    q = urllib.parse.urlencode({"format": "geojson", "starttime": "2026-10-09T17:50:00",
                                "minlatitude": 5.5, "maxlatitude": 10, "minlongitude": -83.5,
                                "maxlongitude": -78, "minmagnitude": 2.5, "orderby": "time"})
    try:
        open(D("data", "usgs", "aftershocks.geojson"), "wb").write(
            get("https://earthquake.usgs.gov/fdsnws/event/1/query?" + q))
    except Exception as e:
        print("aftershocks fail", e, file=sys.stderr)
    return status


def gdacs():
    try:
        r = json.loads(get("https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ"
                           "&fromDate=2026-10-09&toDate=2026-10-31&country=Panama"))
        return [{"alert": f["properties"].get("alertlevel"), "name": f["properties"].get("name"),
                 "url": f["properties"].get("url", {}).get("report"),
                 "severity": f["properties"].get("severitydata", {}).get("severitytext")}
                for f in r.get("features", [])]
    except Exception as e:
        print("gdacs fail", e, file=sys.stderr)
        return []


def main():
    path = D("data", "news_feed.json")
    feed = json.load(open(path)) if os.path.exists(path) else {"items": []}
    items = {i["id"]: i for i in feed["items"]}
    seen_titles = {i["title"].lower() for i in feed["items"]}
    new = 0
    for it in google_news() + reliefweb():
        if it["id"] in items or it["title"].lower() in seen_titles:
            continue
        it["first_seen_utc"] = iso(NOW)
        items[it["id"]] = it
        seen_titles.add(it["title"].lower())
        new += 1
    out = sorted(items.values(), key=lambda i: i["published_utc"], reverse=True)[:600]
    json.dump({"updated_utc": iso(NOW), "items": out}, open(path, "w"), ensure_ascii=False, indent=1)
    status = usgs()
    status["gdacs"] = gdacs()
    json.dump(status, open(D("data", "usgs_status.json"), "w"), indent=1)
    subprocess.run([sys.executable, D("scripts", "build_data.py")], check=True)
    print(f"news feed: {new} new, {len(out)} total")


if __name__ == "__main__":
    main()

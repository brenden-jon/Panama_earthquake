"""Rapid exposure estimate: M7.7 Panama (us6000u18k) ShakeMap v5 x WorldPop 2025 x MS buildings."""
import glob, gzip, json, re, os
import numpy as np, pandas as pd, geopandas as gpd, rasterio
from rasterio import features
from rasterio.transform import from_origin
from scipy.interpolate import RegularGridInterpolator
from shapely.geometry import shape, mapping

HERE = os.path.dirname(os.path.abspath(__file__))
GRID = os.path.join(HERE, '..', 'usgs', 'shakemap_download_grid.xml')
os.chdir(HERE)

# ---------- 1. ShakeMap grid ----------
txt = open(GRID).read()
spec = re.search(r'<grid_specification ([^/]*)/>', txt).group(1)
sp = dict(re.findall(r'(\w+)="([^"]*)"', spec))
nlon, nlat = int(sp['nlon']), int(sp['nlat'])
data = txt.split('<grid_data>')[1].split('</grid_data>')[0]
arr = np.array(data.split(), dtype=float).reshape(-1, 10)
lon = arr[:, 0].reshape(nlat, nlon)[0]
lat = arr[:, 1].reshape(nlat, nlon)[:, 0]          # descending
MMI = arr[:, 2].reshape(nlat, nlon)
PGA = arr[:, 3].reshape(nlat, nlon)
print('grid', nlat, nlon, 'MMI max', MMI.max())
latA = lat[::-1]
fM = RegularGridInterpolator((latA, lon), MMI[::-1], bounds_error=False, fill_value=np.nan)
fP = RegularGridInterpolator((latA, lon), PGA[::-1], bounds_error=False, fill_value=np.nan)

def mmi_class(m):
    # PAGER convention: class k = [k-0.5, k+0.5); IX+ = >= 8.5
    c = np.floor(m + 0.5)
    return np.clip(c, 0, 9)

# ---------- 2. Boundaries ----------
a2 = gpd.read_file('raw/cod/pan_admin2.geojson')
a3 = gpd.read_file('raw/cod/pan_admin3.geojson')
k2 = ['adm2_pcode', 'adm2_name', 'adm1_pcode', 'adm1_name']
k3 = ['adm3_pcode', 'adm3_name'] + k2
a2 = a2[k2 + ['area_sqkm', 'geometry']].copy()
a3 = a3[k3 + ['area_sqkm', 'geometry']].copy()
a3['id3'] = np.arange(1, len(a3) + 1)

# ---------- 3. Population (WorldPop R2025A constrained 100 m) ----------
with rasterio.open('raw/pan_pop_2025_CN_100m_R2025A_v1.tif') as r:
    pop = r.read(1); tr = r.transform; shp = pop.shape
pop[pop < 0] = 0
zone = features.rasterize(((g, i) for g, i in zip(a3.geometry, a3.id3)), out_shape=shp,
                          transform=tr, fill=0, dtype='int32', all_touched=False)
rr, cc = np.nonzero(pop > 0)
pv = pop[rr, cc]
plon = tr.c + (cc + 0.5) * tr.a
plat = tr.f + (rr + 0.5) * tr.e
pz = zone[rr, cc]
# pixels that fall outside polygon (coast) -> nearest adm3
miss = pz == 0
if miss.any():
    pts = gpd.GeoDataFrame(geometry=gpd.points_from_xy(plon[miss], plat[miss]), crs=4326)
    j = gpd.sjoin_nearest(pts.to_crs(32617), a3[['id3', 'geometry']].to_crs(32617), how='left')
    j = j[~j.index.duplicated()]
    pz[miss] = j['id3'].values
print('pop total', pv.sum(), 'unassigned share', pv[miss].sum() / pv.sum())
pm = fM(np.c_[plat, plon]); pp = fP(np.c_[plat, plon])
P = pd.DataFrame({'id3': pz, 'pop': pv, 'mmi': pm, 'pga': pp})

# --- Census 2023 (INEC, via Esri Panama Living Atlas, 699 corregimientos): rescale pixels ---
cen = gpd.read_file('raw/census2023_corr.geojson')
cen['geometry'] = cen.geometry.make_valid()
cen['cid'] = np.arange(1, len(cen) + 1)
czone = features.rasterize(((g, i) for g, i in zip(cen.geometry, cen.cid)), out_shape=shp,
                           transform=tr, fill=0, dtype='int32')
cz = czone[rr, cc]
cmiss = cz == 0
if cmiss.any():
    pts = gpd.GeoDataFrame(geometry=gpd.points_from_xy(plon[cmiss], plat[cmiss]), crs=4326)
    j = gpd.sjoin_nearest(pts.to_crs(32617), cen[['cid', 'geometry']].to_crs(32617), how='left')
    cz[cmiss] = j[~j.index.duplicated()]['cid'].values
wp_c = pd.Series(pv).groupby(cz).sum()
fac = cen.set_index('cid')['Total_Poblacion'] / wp_c
P['cid'] = cz
P['pop23'] = pv * fac.reindex(cz).fillna(0).values
lost = cen[~cen.cid.isin(wp_c.index)]
print('census total', cen.Total_Poblacion.sum(), 'rescaled', P.pop23.sum(), 'census polys w/o WorldPop pixels', len(lost), lost.Total_Poblacion.sum())
# census-geography exposure table
Pc = P.copy(); Pc['cls'] = mmi_class(Pc['mmi'].fillna(0))
tc = Pc.pivot_table(index='cid', columns='cls', values='pop23', aggfunc='sum', fill_value=0)
ce = cen.drop(columns='geometry').set_index('cid')
for k in [5, 6, 7, 8, 9]:
    ce[f'pop23_mmi{k}'] = (tc[k] if k in tc.columns else 0)
ce = ce.fillna(0)
ce['pop23_mmi7plus'] = ce[['pop23_mmi7', 'pop23_mmi8', 'pop23_mmi9']].sum(1)
ce['mean_mmi'] = Pc.dropna(subset=['mmi']).groupby('cid').apply(lambda d: np.average(d['mmi'], weights=d['pop']) if d['pop'].sum() > 0 else np.nan).round(2)
cc_ = cen.to_crs(32617).geometry.centroid.to_crs(4326)
ce['centroid_lat'] = cc_.y.round(4).values; ce['centroid_lon'] = cc_.x.round(4).values
for c in ce.columns:
    if c.startswith('pop23_'): ce[c] = ce[c].round().astype(int)
ce.sort_values('pop23_mmi7plus', ascending=False).to_csv('exposure_corr_census2023.csv', index=False)
print('census-scaled national by class', {k: int(ce[f'pop23_mmi{k}'].sum()) for k in [5,6,7,8,9]})
print(ce.sort_values('pop23_mmi7plus', ascending=False)[['LMPR_NOMB','LMDI_NOMB','LMCO_NOMB','Total_Poblacion','pop23_mmi7plus','pop23_mmi8','pop23_mmi9','mean_mmi']].head(20).to_string())

# ---------- 4. Buildings (Microsoft Global ML Building Footprints, 2026-02 release) ----------
if not os.path.exists('raw/ms_centroids.parquet'):
    rows = []
    for f in sorted(glob.glob('raw/ms/*.csv.gz')):
        with gzip.open(f, 'rt') as fh:
            for line in fh:
                g = json.loads(line)['geometry']['coordinates'][0]
                c = np.asarray(g[:-1])
                x, y = c[:, 0], c[:, 1]
                # shoelace area in m2 (local equirectangular)
                ky = 111320.0; kx = 111320.0 * np.cos(np.radians(y.mean()))
                ar = 0.5 * abs(np.dot(x * kx, np.roll(y * ky, 1)) - np.dot(y * ky, np.roll(x * kx, 1)))
                rows.append((x.mean(), y.mean(), ar))
        print(f, len(rows))
    B = pd.DataFrame(rows, columns=['lon', 'lat', 'area_m2'])
    B.to_parquet('raw/ms_centroids.parquet')
B = pd.read_parquet('raw/ms_centroids.parquet')
B = B.drop_duplicates(['lon', 'lat'])
bg = gpd.GeoDataFrame(B, geometry=gpd.points_from_xy(B.lon, B.lat), crs=4326)
bj = gpd.sjoin(bg, a3[['id3', 'geometry']], how='inner', predicate='within')
bj = bj[~bj.index.duplicated()]
print('buildings total', len(B), 'in Panama polygons', len(bj))
bj['mmi'] = fM(np.c_[bj.lat.values, bj.lon.values])
bj['pga'] = fP(np.c_[bj.lat.values, bj.lon.values])

# ---------- 5. Aggregate ----------
CL = {5: 'mmi5', 6: 'mmi6', 7: 'mmi7', 8: 'mmi8', 9: 'mmi9'}

def agg(df, key, w):
    d = df.copy(); d['cls'] = mmi_class(d['mmi'].fillna(0))
    d['w'] = w(d)
    t = d.pivot_table(index=key, columns='cls', values='w', aggfunc='sum', fill_value=0)
    out = pd.DataFrame(index=t.index)
    for k, n in CL.items():
        out[n] = t[k] if k in t.columns else 0
    out['total'] = d.groupby(key)['w'].sum()
    out['mmi6plus'] = out[['mmi6', 'mmi7', 'mmi8', 'mmi9']].sum(1)
    out['mmi7plus'] = out[['mmi7', 'mmi8', 'mmi9']].sum(1)
    out['mmi8plus'] = out[['mmi8', 'mmi9']].sum(1)
    return out

lut = a3.set_index('id3')
for d in (P, bj):
    d['adm3_pcode'] = lut.loc[d['id3'].values, 'adm3_pcode'].values
    d['adm2_pcode'] = lut.loc[d['id3'].values, 'adm2_pcode'].values

# max MMI over ShakeMap nodes within each polygon (area based)
sm_tr = from_origin(lon[0] - (lon[1] - lon[0]) / 2, lat[0] + (lat[0] - lat[1]) / 2, lon[1] - lon[0], lat[0] - lat[1])

def poly_max(gdf, idcol):
    res = {}
    for i, g in zip(gdf[idcol], gdf.geometry):
        m = features.geometry_mask([g], out_shape=MMI.shape, transform=sm_tr, invert=True, all_touched=True)
        res[i] = MMI[m].max() if m.any() else np.nan
    return pd.Series(res)

def build(level, gdf, key):
    p = agg(P, key, lambda d: d['pop']).add_prefix('pop_').rename(columns={'pop_total': 'pop_total'})
    b = agg(bj, key, lambda d: np.ones(len(d))).add_prefix('bldg_')
    p23 = agg(P, key, lambda d: d['pop23']).add_prefix('pop23_')
    out = gdf.drop(columns='geometry').set_index(key).join(p).join(p23).join(b)
    pw = P.dropna(subset=['mmi']).groupby(key).apply(lambda d: np.average(d['mmi'], weights=d['pop']) if d['pop'].sum() > 0 else np.nan)
    out['mean_mmi'] = pw            # population-weighted
    out['mean_pga_pctg'] = P.dropna(subset=['pga']).groupby(key).apply(lambda d: np.average(d['pga'], weights=d['pop']) if d['pop'].sum() > 0 else np.nan)
    out['max_mmi'] = poly_max(gdf, key)
    out['max_pga_pctg'] = P.groupby(key)['pga'].max()
    cen = gdf.to_crs(32617).geometry.centroid.to_crs(4326)
    out['centroid_lat'] = cen.y.values; out['centroid_lon'] = cen.x.values
    out = out.fillna({c: 0 for c in out.columns if c.startswith(('pop_', 'bldg_'))})
    for c in out.columns:
        if c.startswith(('pop_', 'bldg_')):
            out[c] = out[c].round().astype(int)
    for c in ['mean_mmi', 'max_mmi', 'centroid_lat', 'centroid_lon', 'mean_pga_pctg', 'max_pga_pctg', 'area_sqkm']:
        out[c] = out[c].round(4 if 'centroid' in c else 2)
    return out.reset_index()

e3 = build(3, a3.drop(columns='id3'), 'adm3_pcode')
e2 = build(2, a2, 'adm2_pcode')
e3 = e3.sort_values('pop_mmi7plus', ascending=False)
e2 = e2.sort_values('pop_mmi7plus', ascending=False)
e3.to_csv('exposure_adm3.csv', index=False)
e2.to_csv('exposure_adm2.csv', index=False)

# ---------- 6. GeoJSON outputs ----------
def simp(g, tol=0.002):
    g = g.copy(); g['geometry'] = g.geometry.simplify(tol, preserve_topology=True); return g

simp(a2).to_file('adm2.geojson', driver='GeoJSON', COORDINATE_PRECISION=4)
simp(a3.drop(columns='id3')).to_file('adm3.geojson', driver='GeoJSON', COORDINATE_PRECISION=4)
keep = ['adm3_pcode', 'adm3_name', 'adm2_pcode', 'adm2_name', 'adm1_name', 'pop_total', 'pop_mmi5', 'pop_mmi6', 'pop_mmi7',
        'pop_mmi8', 'pop_mmi9', 'pop_mmi7plus', 'bldg_total', 'bldg_mmi6', 'bldg_mmi7', 'bldg_mmi8', 'bldg_mmi9',
        'bldg_mmi7plus', 'pop23_total', 'pop23_mmi6', 'pop23_mmi7', 'pop23_mmi8', 'pop23_mmi9', 'pop23_mmi7plus', 'max_mmi', 'mean_mmi', 'centroid_lat', 'centroid_lon']
g3 = simp(a3[['adm3_pcode', 'geometry']]).merge(e3[keep], on='adm3_pcode')
g3.to_file('adm3_exposure.geojson', driver='GeoJSON', COORDINATE_PRECISION=4)

# MMI bands (0.5 MMI steps) polygonised from ShakeMap grid, land+sea
levels = np.arange(4.0, np.ceil(MMI.max() * 2) / 2 + 0.5, 0.5)
cls = np.digitize(MMI, levels).astype('int16')  # 0 = <4
feats = []
for geom, v in features.shapes(cls, mask=cls > 0, transform=sm_tr):
    v = int(v); lo = levels[v - 1]; hi = levels[v] if v < len(levels) else None
    feats.append({'mmi_min': float(lo), 'mmi_max': float(hi) if hi else None,
                  'mmi_label': f'{lo:.1f}-{hi:.1f}' if hi else f'>={lo:.1f}', 'geometry': shape(geom)})
mg = gpd.GeoDataFrame(feats, crs=4326).dissolve(by=['mmi_min', 'mmi_label'], as_index=False)
mg['geometry'] = mg.geometry.simplify(0.01, preserve_topology=True)
mg = mg[['mmi_min', 'mmi_label', 'geometry']].sort_values('mmi_min')
mg.to_file('mmi_grid.geojson', driver='GeoJSON', COORDINATE_PRECISION=3)

# ---------- 7. Headline ----------
tot = {}
for n in ['mmi5', 'mmi6', 'mmi7', 'mmi8', 'mmi9']:
    tot[n] = (int(e3['pop_' + n].sum()), int(e3['pop23_' + n].sum()), int(e3['bldg_' + n].sum()))
print('Headline (pop WP2025, pop census2023-scaled, bldg) by MMI class:', tot)
print('pop_total', int(e3.pop_total.sum()), 'bldg_total', int(e3.bldg_total.sum()))
print('PGA at pop: max %.1f %%g' % np.nanmax(P.pga))
print(e3[['adm3_name', 'adm2_name', 'adm1_name', 'pop_total', 'pop_mmi7plus', 'pop_mmi8plus', 'bldg_mmi7plus', 'mean_mmi', 'max_mmi']].head(20).to_string())
print(e2[['adm2_name', 'adm1_name', 'pop_total', 'pop_mmi6', 'pop_mmi7', 'pop_mmi8', 'pop_mmi9', 'bldg_mmi7plus', 'mean_mmi', 'max_mmi']].head(20).to_string())

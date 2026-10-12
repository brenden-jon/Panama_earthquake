import json, sys, re
import pandas as pd, geopandas as gpd, numpy as np
OUT=sys.argv[1]
J=pd.read_pickle('pov/joined2.pkl')
g=gpd.read_file('risk/raw/census2023_corr.geojson')
ex=pd.read_csv('risk/exposure_corr_census2023.csv',dtype={'COD_CORREG':str})
g=g.set_index('COD_CORREG').loc[ex.COD_CORREG.values].reset_index()  # align to exposure-table row order
assert not J.j.duplicated().any()
g=g.loc[J.j.astype(int)].reset_index(drop=True)
J=J.reset_index(drop=True)
def title(s):
    s=s.title()
    for a,b in [(' De ',' de '),(' Del ',' del '),(' La ',' la '),(' Las ',' las '),(' Los ',' los '),(' El ',' el '),(' O ',' o '),(' Y ',' y '),('(P)',''),('(Cabecera)','(cabecera)')]: s=s.replace(a,b)
    return re.sub(r'\s+',' ',s).strip()
props=pd.DataFrame({
 'n':J['corr'].map(title),'d':J['dist'].map(title),'p':J['prov'].map(title).str.replace('Comarca ','Comarca '),
 'pop':J['pop'],'pov':J.pov,'ext':J.ext,'inc':J.inc,'gini':J.gini,
 'mmi':J.mean_mmi.round(1),'p7':J.p7.round(0).astype(int),'poor7':(J.p7*J.pov).round(0).astype(int),
 's7':(J.p7/J.Total_Poblacion).clip(0,1).round(2),'rural':(J.H_AREA_Rural/(J.H_AREA_Rural+J.H_AREA_Urbano)).round(2)})
G=gpd.GeoDataFrame(props,geometry=g.geometry.values,crs=g.crs).to_crs(4326)
G['geometry']=G.geometry.simplify(0.0025,preserve_topology=True)
gj=json.loads(G.to_json(drop_id=True))
def rnd(c):
    if isinstance(c[0],(float,int)): return [round(c[0],4),round(c[1],4)]
    return [rnd(x) for x in c]
for f in gj['features']:
    f['geometry']['coordinates']=rnd(f['geometry']['coordinates'])
    f['properties']={k:(None if (isinstance(v,float) and np.isnan(v)) else v) for k,v in f['properties'].items()}
json.dump(gj,open(f'{OUT}/corregimientos_poverty.geojson','w'),separators=(',',':'),ensure_ascii=False)
# summary
def agg(col):
    P=J[col].sum(); return dict(pop=int(P),poor=int((J[col]*J.pov).sum()),ext=int((J[col]*J.ext).sum()),
        rate=round((J[col]*J.pov).sum()/P,3),ext_rate=round((J[col]*J.ext).sum()/P,3),inc=int((J[col]*J.inc).sum()/P))
r=J[J.p7>0]; ru=r[(r.H_AREA_Rural/(r.H_AREA_Rural+r.H_AREA_Urbano))>0.5]; ur=r.drop(ru.index)
h=J[J.p7>0.5*J.Total_Poblacion]
top=h[h.pov>=0.4].sort_values('pov',ascending=False)
S=dict(national=dict(pop=int(J['pop'].sum()),rate=0.249,ext_rate=0.110,inc=385,gini=0.508,line_mod=111.54,line_mod_city=148.01,line_ext='62.40'),
  vi=agg('p6'),vii=agg('p7'),viii=agg('p8'),
  rural_vii=dict(pop=int(ru.p7.sum()),rate=round((ru.p7*ru.pov).sum()/ru.p7.sum(),3)),
  urban_vii=dict(pop=int(ur.p7.sum()),rate=round((ur.p7*ur.pov).sum()/ur.p7.sum(),3)),
  n_vii_corr=int(len(h)),n_vii_pov40=int((h.pov>=0.4).sum()),n_vii_pov30=int((h.pov>=0.3).sum()),
  pov40_pop=int(top['pop'].sum()),
  top=[dict(n=title(x['corr']),d=title(x['dist']),p=title(x['prov']),pop=int(x['pop']),pov=x.pov,ext=x.ext,inc=int(x.inc),mmi=round(x.mean_mmi,1),s7=round(x.p7/x.Total_Poblacion,2),poor7=int(x.p7*x.pov)) for _,x in h.sort_values('pov',ascending=False).head(15).iterrows()])
json.dump(S,open(f'{OUT}/summary.json','w'),ensure_ascii=False,indent=1)
print(json.dumps({k:v for k,v in S.items() if k!='top'},indent=1))

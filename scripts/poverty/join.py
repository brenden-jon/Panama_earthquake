import json, unicodedata, re, difflib
import pandas as pd, numpy as np
from scipy.optimize import linear_sum_assignment
pv=pd.DataFrame(json.load(open('pov/corr_poverty.json')))
ex=pd.read_csv('risk/exposure_corr_census2023.csv',dtype={'COD_CORREG':str,'COD_DIST':str,'COD_PROV':str})
def norm(s):
    s=unicodedata.normalize('NFKD',str(s)).encode('ascii','ignore').decode().upper()
    s=re.sub(r'^(PROVINCIA DE|COMARCA|DISTRITO DE|CORREGIMIENTO)\s+','',s)
    s=re.sub(r'\(.*?\)','',s); s=re.sub(r'[^A-Z ]','',s); s=re.sub(r'\b(CABECERA|P)\b','',s)
    return re.sub(r'\s+',' ',s).strip()
for d,c in [(ex,'LMPR_NOMB'),(pv,'prov')]: d['pn']=d[c].map(norm).str.replace('GUNA','KUNA').str.replace('NGOBE','NGABE').str[:5]
ex['dn']=ex.LMDI_NOMB.map(norm); pv['dn']=pv.dist.map(norm); ex['cn']=ex.LMCO_NOMB.map(norm); pv['cn']=pv['corr'].map(norm)
pv['j']=-1
sm=lambda a,b: difflib.SequenceMatcher(None,a,b).ratio()
for p in pv.pn.unique():
    A=pv[pv.pn==p]; B=ex[ex.pn==p]
    C=np.zeros((len(A),len(B)))
    for ii,(i,a) in enumerate(A.iterrows()):
        for jj,(j,b) in enumerate(B.iterrows()):
            name=sm(a.cn,b.cn); dist=sm(a.dn,b.dn); popm=abs(a['pop']-b.Total_Poblacion)/max(a['pop'],1)
            C[ii,jj]=(1-name)*1.0+(1-dist)*1.5+min(popm,1)*4
    r,c=linear_sum_assignment(C)
    pv.loc[A.index[r],'j']=B.index[c]
    pv.loc[A.index[r],'cost']=C[r,c]
J=pv.join(ex.drop(columns=['pn','dn','cn']),on='j')
J['pop_ratio']=J['pop']/J.Total_Poblacion
print('unassigned',(J.j<0).sum(),'dup',J.j.duplicated().sum())
b=J[(J.pop_ratio<0.95)|(J.pop_ratio>1.05)|(J.cost>0.6)]
print(b[['dist','corr','LMDI_NOMB','LMCO_NOMB','pop','Total_Poblacion','cost']].to_string())
print('corr inc~pov', np.corrcoef(np.log(J.inc),J.pov)[0,1])
for k in ['pop23_mmi5','pop23_mmi6','pop23_mmi7','pop23_mmi8','pop23_mmi9','pop23_mmi7plus']: J[k]=J[k].fillna(0)
J['p8']=J.pop23_mmi8+J.pop23_mmi9; J['p7']=J.pop23_mmi7plus; J['p6']=J.p7+J.pop23_mmi6
J.to_pickle('pov/joined2.pkl')

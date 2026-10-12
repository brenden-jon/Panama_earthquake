import re, json, csv
t=open('annex.txt').read().split('=====PAGE=====')
PROVS=["BOCAS DEL TORO","COCLÉ","COLÓN","CHIRIQUÍ","DARIÉN","HERRERA","LOS SANTOS","PANAMÁ OESTE","PANAMÁ","VERAGUAS","COMARCA KUNA YALA","COMARCA GUNA YALA","COMARCA EMBERÁ","COMARCA NGÄBE BUGLÉ","COMARCA NASO TJËR DI"]
def lines(rng, pat):
    out=[]
    for i in rng:
        for l in t[i].split('\n'):
            l=l.strip()
            if pat(l): out.append(l)
    return out
pd=lines(range(0,15), lambda l: any(l.startswith(p) for p in PROVS) and 'Disclosure' not in l)
def split_pd(l):
    for p in sorted(PROVS,key=len,reverse=True):
        if l.startswith(p): return p, l[len(p):].strip()
pd=[split_pd(l) for l in pd]
num=re.compile(r'^(.*\S)\s+([\d,]+)\s+([\d,]+)$')
nm=[num.match(l) for l in lines(range(15,30), lambda l: bool(num.match(l)))]
nm=[(m.group(1),int(m.group(2).replace(',','')),int(m.group(3).replace(',',''))) for m in nm]
r8=re.compile(r'^([\d.]+ ){7}[\d.]+$')
v8=[list(map(float,l.split())) for l in lines(range(30,45), lambda l: bool(r8.match(l)))]
r2=re.compile(r'^[\d.]+ [\d.]+$')
v2=[list(map(float,l.split())) for l in lines(range(45,60), lambda l: bool(r2.match(l)))]
print(len(pd),len(nm),len(v8),len(v2))
rows=[]
for (p,d),(c,pop,inc),a,b in zip(pd,nm,v8,v2):
    rows.append(dict(prov=p,dist=d,corr=c,pop=pop,inc=inc,pov=a[0],pov_gap=a[1],ext=a[3],gini=b[1]))
json.dump(rows,open('corr_poverty.json','w'),ensure_ascii=False,indent=0)
w=csv.DictWriter(open('corr_poverty.csv','w'),fieldnames=rows[0].keys()); w.writeheader(); w.writerows(rows)
for r in rows:
    if r['dist'] in ('TONOSÍ','MARIATO','LOS POZOS','LAS TABLAS'): print(r)
print(sum(r['pop'] for r in rows), sum(r['pop']*r['pov'] for r in rows)/sum(r['pop'] for r in rows))

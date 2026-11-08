import json,sys,os
from PIL import Image
meta=json.load(open(sys.argv[1])); base=sys.argv[2]
for s in meta['splits']:
    if s['channel']=='A':   # opacity factor baked into the alpha
        im=Image.open(os.path.join(base,s['src'])).convert('RGBA'); r,g,b,a=im.split()
        a=a.point(lambda v: round(v*s['alpha'])); Image.merge('RGBA',(r,g,b,a)).save(os.path.join(base,s['out'])); print('wrote',s['out']); continue
    im=Image.open(os.path.join(base,s['src'])).convert('RGB')
    ch={'R':0,'G':1,'B':2}[s['channel']]
    im.split()[ch].save(os.path.join(base,s['out'])); print('wrote',s['out'])

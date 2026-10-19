import json,sys,os
from PIL import Image
meta=json.load(open(sys.argv[1])); base=sys.argv[2]
for s in meta['splits']:
    im=Image.open(os.path.join(base,s['src'])).convert('RGB')
    ch={'R':0,'G':1,'B':2}[s['channel']]
    im.split()[ch].save(os.path.join(base,s['out'])); print('wrote',s['out'])

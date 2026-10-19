import bpy, sys, numpy as np, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gltfref import G
glb, fbx = sys.argv[sys.argv.index('--')+1:][:2]
g=G(glb)
def summary(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    (bpy.ops.import_scene.gltf if path.endswith('glb') else bpy.ops.import_scene.fbx)(filepath=path)
    out={}
    for m in bpy.data.materials:
        if not m.use_nodes: continue
        bs=[n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED']
        if not bs: continue
        b=bs[0]; d={}
        def src(sock, depth=0):
            if not sock.is_linked: 
                v=sock.default_value
                try: return tuple(round(x,3) for x in v)[:3]
                except TypeError: return round(v,3)
            n=sock.links[0].from_node
            if n.type=='TEX_IMAGE': return ('IMG', os.path.basename(n.image.filepath) if n.image else None, sock.links[0].from_socket.name)
            for inp in n.inputs:
                if inp.is_linked and depth<4:
                    r=src(inp,depth+1)
                    if isinstance(r,tuple) and r and r[0]=='IMG': return r+(n.type,)
            return (n.type,)
        for k in ('Base Color','Metallic','Roughness','Normal','Emission Color','Alpha','Emission Strength'):
            if k in b.inputs: d[k]=src(b.inputs[k])
        d['blend']=getattr(m,'surface_render_method',None)
        # normalise equivalent setups
        ec,es=d.get('Emission Color'),d.get('Emission Strength')
        if (ec==(0.0,0.0,0.0)) or es==0.0: d['Emission Color']='none'; d['Emission Strength']='none'
        if d.get('Normal')==('NORMAL_MAP',) or d.get('Normal')==(0.0,0.0,0.0): d['Normal']='none'
        al=d.get('Alpha')
        if isinstance(al,tuple) and al[0]=='IMG' and isinstance(d.get('Base Color'),tuple) and d['Base Color'][:2]==al[:2]: d['Alpha']='base-alpha'
        out[m.name.split('.')[0] if False else m.name]=d
    return out
a=summary(glb); b=summary(fbx)
for k,v in a.items():
    if v.get('Alpha')==1.0: v['Alpha']='opaque'
for k,v in b.items():
    if v.get('Alpha') in (1.0,'base-alpha') and a.get(k,{}).get('Alpha')=='opaque': v['Alpha']='opaque'
keys=sorted(set(a)|set(b)); diffs=0
for k in keys:
    da,db=a.get(k),b.get(k)
    if da!=db:
        diffs+=1
        if diffs<=12: print('MAT',k,'\n   glb:',da,'\n   fbx:',db)
print('materials compared', len(keys), 'different', diffs)

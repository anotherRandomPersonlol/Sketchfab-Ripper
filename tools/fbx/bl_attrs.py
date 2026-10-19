import bpy, sys, numpy as np, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gltfref import G
glb, fbx = sys.argv[sys.argv.index('--')+1:][:2]
g=G(glb)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)
meshes=[o for o in bpy.data.objects if o.type=='MESH']
REF=g.mesh_world(None,0)
worst_uv=0; worst_col=0; worst_n=0; ncol=0
used=set()
for i,n in enumerate(g.j['nodes']):
    if 'mesh' not in n: continue
    m=g.j['meshes'][n['mesh']]; pr=m['primitives'][0]
    cand=[o for o in meshes if o not in used and len(o.data.vertices)==g.j['accessors'][pr['attributes']['POSITION']]['count'] and o.name.split('.')[0]==n.get('name','').split('.')[0]]
    if not cand: cand=[o for o in meshes if o not in used and len(o.data.vertices)==g.j['accessors'][pr['attributes']['POSITION']]['count']]
    def wv(o):
        co=np.array([v.co for v in o.data.vertices]); mw=np.array(o.matrix_world); w=(mw@np.c_[co,np.ones(len(co))].T).T[:,:3]; return np.c_[w[:,0],w[:,2],-w[:,1]]
    r=REF[(n.get('name',f'node{i}'),i)]
    o=min(cand,key=lambda o: np.abs(wv(o)-r).max()); used.add(o); me=o.data
    lv=np.array([l.vertex_index for l in me.loops])
    if 'TEXCOORD_0' in pr['attributes']:
        uv=g.acc(pr['attributes']['TEXCOORD_0']); exp=np.c_[uv[:,0],1-uv[:,1]][lv]
        got=np.array([d.uv for d in me.uv_layers[0].data]); worst_uv=max(worst_uv,np.abs(got-exp).max())
    if 'COLOR_0' in pr['attributes']:
        c=g.acc(pr['attributes']['COLOR_0']); ca=me.color_attributes[0]; ncol+=1
        got=np.array([d.color for d in ca.data]); exp=c[lv] if ca.domain=='CORNER' else c
        if c.shape[1]==3: exp=np.c_[exp,np.ones(len(exp))]
        worst_col=max(worst_col,np.abs(got-exp).max())
        if ncol==1: print('  color attr', ca.name, ca.domain, ca.data_type, 'sample got', got[0].round(3), 'exp(linear glTF)', exp[0].round(3))
    if 'NORMAL' in pr['attributes'] and 'skin' not in n:
        N=g.acc(pr['attributes']['NORMAL'])
        got=np.array([cn.vector for cn in me.corner_normals]) if hasattr(me,'corner_normals') else None
        if got is not None:
            exp=N[lv]; e=np.abs(got-exp).max(1)
            if e.max()>0.01:
                bad=e>0.01; k=e.argmax()
                print(f'   {o.name}: {bad.sum()} of {len(e)} corners off; worst got {got[k].round(3)} exp {exp[k].round(3)} |exp|={np.linalg.norm(exp[k]):.3f} vertex {lv[k]}')
                # are the bad corners on degenerate faces?
                areas=np.array([p.area for p in me.polygons]); lp=np.zeros(len(lv),int)
                for p_ in me.polygons:
                    lp[p_.loop_start:p_.loop_start+p_.loop_total]=p_.index
                print('     bad corners on zero-area faces:', int((areas[lp[bad]]<1e-12).sum()), 'exp normal length range', np.linalg.norm(exp[bad],axis=1).min().round(3), np.linalg.norm(exp[bad],axis=1).max().round(3))
            worst_n=max(worst_n,e.max())
print(f'meshes {len(used)} uv max err {worst_uv:.2e}  color max err {worst_col:.2e} ({ncol} meshes)  local normal max err {worst_n:.2e}')

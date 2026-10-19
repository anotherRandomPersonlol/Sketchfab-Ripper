import bpy, sys, numpy as np, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gltfref import G
glb, fbx = sys.argv[sys.argv.index('--')+1:][:2]
g=G(glb)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)
sc=bpy.context.scene; fps=sc.render.fps/sc.render.fps_base
meshes=[o for o in bpy.data.objects if o.type=='MESH']
def bl_verts(o):
    dg=bpy.context.evaluated_depsgraph_get(); oe=o.evaluated_get(dg); me=oe.to_mesh()
    co=np.array([v.co for v in me.vertices]); mw=np.array(oe.matrix_world)
    oe.to_mesh_clear()
    w=(mw@np.c_[co,np.ones(len(co))].T).T[:,:3]
    return np.c_[w[:,0],w[:,2],-w[:,1]]   # Blender Z-up -> glTF Y-up
def match(ref):
    # pair glTF mesh nodes with Blender objects by order of names and vertex count
    pairs=[]; used=set()
    for (nm,i),v in ref.items():
        cand=[o for o in meshes if o not in used and len(o.data.vertices)==len(v) and (o.name==nm or o.name.startswith(nm+'.') or True)]
        cand.sort(key=lambda o:(0 if o.name==nm else 1 if o.name.split('.')[0]==nm.split('.')[0] else 2, o.name))
        if not cand: print('  NO MATCH for',nm,len(v)); continue
        # choose candidate with closest rest positions
        best=min(cand,key=lambda o: np.abs(bl_verts(o)-v).max() if len(cand)>1 else 0)
        used.add(best); pairs.append((nm,i,best))
    return pairs
def size_of(ref): allv=np.vstack(list(ref.values())); return np.linalg.norm(allv.max(0)-allv.min(0))
anims=g.j.get('animations',[])
# rest pose
for ob in bpy.data.objects:
    if ob.animation_data: ob.animation_data.action=None
    if ob.type=='MESH' and ob.data.shape_keys and ob.data.shape_keys.animation_data: ob.data.shape_keys.animation_data.action=None
sc.frame_set(0)
ref=g.mesh_world(None,0); diag=size_of(ref); pairs=match(ref)
def report(label, ref):
    worst=0
    for nm,i,o in pairs:
        d=np.abs(bl_verts(o)-ref[(nm,i)]).max(); worst=max(worst,d)
    return worst
print(f'scene size {diag:.3f}, meshes {len(pairs)}/{len(ref)}, rest pose max err {report("rest",ref)/diag:.2e} (rel)')
# animation
acts=list(bpy.data.actions)
for ci,a in enumerate(anims):
    nm=a.get('name',f'clip_{ci}')
    mine=[x for x in acts if x.name.split('|')[-2]==nm or ('|'+nm+'|') in x.name]
    if not mine: print('  clip',nm,'NO ACTION'); continue
    for x in mine:
        owner=x.name.split('|')[0]
        ids=[ob for ob in bpy.data.objects if ob.name==owner]+[k for k in bpy.data.shape_keys if k.name==owner]
        for idb in ids:
            if not idb.animation_data: idb.animation_data_create()
            idb.animation_data.action=x
            if hasattr(idb.animation_data,'action_slot') and idb.animation_data.action_slot is None and len(x.slots): idb.animation_data.action_slot=x.slots[0]
    T=[]
    for smp in a['samplers']: T+=list(g.acc(smp['input'])[:,0])
    t0,t1=min(T),max(T)
    worst=0
    for t in np.linspace(t0,t1,13):
        f=t*fps+1.0; sc.frame_set(int(np.floor(f)),subframe=f-np.floor(f))
        r=g.mesh_world(ci,t)
        for mnm,i,o in pairs: worst=max(worst,np.abs(bl_verts(o)-r[(mnm,i)]).max())
    print(f'  clip {nm[:28]:28s} actions {len(mine)} t=[{t0:.2f},{t1:.2f}] max err {worst/diag:.2e} (rel)')
    for x in mine:
        owner=x.name.split('|')[0]
        for idb in [ob for ob in bpy.data.objects if ob.name==owner]+[k for k in bpy.data.shape_keys if k.name==owner]: idb.animation_data.action=None

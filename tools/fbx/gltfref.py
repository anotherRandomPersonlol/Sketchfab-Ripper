# Reference evaluation of our GLBs: world-space vertex positions at time t of clip c
import json, struct, numpy as np
CT={5126:np.float32,5121:np.uint8,5123:np.uint16,5125:np.uint32,5120:np.int8,5122:np.int16}
NC={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}
class G:
    def __init__(s,p):
        b=open(p,'rb').read(); jl=struct.unpack('<I',b[12:16])[0]
        s.j=json.loads(b[20:20+jl]); o=20+jl; bl=struct.unpack('<I',b[o:o+4])[0]; s.bin=b[o+8:o+8+bl]
        s.parent={}
        for i,n in enumerate(s.j['nodes']):
            for c in n.get('children',[]): s.parent[c]=i
    def acc(s,i):
        a=s.j['accessors'][i]; bv=s.j['bufferViews'][a['bufferView']]; dt=np.dtype(CT[a['componentType']]); nc=NC[a['type']]
        st=bv.get('byteStride',dt.itemsize*nc); off=bv.get('byteOffset',0)+a.get('byteOffset',0)
        raw=np.frombuffer(s.bin,dtype=np.uint8,count=st*(a['count']-1)+dt.itemsize*nc,offset=off)
        arr=np.lib.stride_tricks.as_strided(raw.view(dt) if st%dt.itemsize==0 and False else np.frombuffer(s.bin,dtype=dt,offset=off,count=(st*(a['count']-1))//dt.itemsize+nc),shape=(a['count'],nc),strides=(st,dt.itemsize)).astype(np.float64)
        if a.get('normalized'):
            arr/= {np.uint8:255,np.uint16:65535}.get(CT[a['componentType']],1)
        return arr
    @staticmethod
    def trs(t,q,sc):
        x,y,z,w=q
        R=np.array([[1-2*(y*y+z*z),2*(x*y-w*z),2*(x*z+w*y)],[2*(x*y+w*z),1-2*(x*x+z*z),2*(y*z-w*x)],[2*(x*z-w*y),2*(y*z+w*x),1-2*(x*x+y*y)]])
        M=np.eye(4); M[:3,:3]=R*np.array(sc)[None,:]; M[:3,3]=t; return M
    def sample(s,smp,t):
        T=s.acc(smp['input'])[:,0]; V=s.acc(smp['output'])
        if smp.get('interpolation')=='CUBICSPLINE': V=V.reshape(len(T),3,-1)[:,1]
        V=V.reshape(len(T),-1)
        if t<=T[0]: return V[0]
        if t>=T[-1]: return V[-1]
        k=np.searchsorted(T,t)-1; u=(t-T[k])/(T[k+1]-T[k]); a,b=V[k],V[k+1]
        if smp.get('interpolation')=='STEP': return a
        return a+(b-a)*u
    def pose(s,clip,t):
        loc={}; wts={}
        for i,n in enumerate(s.j['nodes']):
            if 'matrix' in n: loc[i]=['M',np.array(n['matrix']).reshape(4,4).T]
            else: loc[i]=['T',list(n.get('translation',[0,0,0])),list(n.get('rotation',[0,0,0,1])),list(n.get('scale',[1,1,1]))]
        if clip is not None:
            a=s.j['animations'][clip]
            for ch in a['channels']:
                nd=ch['target']['node']; p=ch['target']['path']; v=s.sample(a['samplers'][ch['sampler']],t)
                if p=='weights': wts[nd]=v; continue
                L=loc[nd]
                if L[0]=='M': raise Exception('animated matrix node')
                if p=='translation': L[1]=v
                elif p=='rotation':
                    # slerp instead of lerp for rotation
                    smp=a['samplers'][ch['sampler']]; T=s.acc(smp['input'])[:,0]; V=s.acc(smp['output'])
                    if t<=T[0]: q=V[0]
                    elif t>=T[-1]: q=V[-1]
                    else:
                        k=np.searchsorted(T,t)-1; u=(t-T[k])/(T[k+1]-T[k]); qa,qb=V[k],V[k+1]
                        d=np.dot(qa,qb)
                        if d<0: qb=-qb; d=-d
                        if d>0.9995: q=qa+(qb-qa)*u
                        else:
                            th=np.arccos(d); q=(np.sin((1-u)*th)*qa+np.sin(u*th)*qb)/np.sin(th)
                    L[2]=q/np.linalg.norm(q)
                elif p=='scale': L[3]=v
        M={i:(L[1] if L[0]=='M' else s.trs(*L[1:])) for i,L in loc.items()}
        W={}
        def world(i):
            if i in W: return W[i]
            W[i]=M[i] if i not in s.parent else world(s.parent[i])@M[i]; return W[i]
        for i in M: world(i)
        return W,wts
    def mesh_world(s,clip,t):
        W,wts=s.pose(clip,t); out={}
        for i,n in enumerate(s.j['nodes']):
            if 'mesh' not in n: continue
            mesh=s.j['meshes'][n['mesh']]; vs=[]
            for pr in mesh['primitives']:
                P=s.acc(pr['attributes']['POSITION'])
                w=wts.get(i, mesh.get('weights',[]))
                for k,tg in enumerate(pr.get('targets',[])):
                    if k<len(w) and 'POSITION' in tg: P=P+w[k]*s.acc(tg['POSITION'])
                Ph=np.c_[P,np.ones(len(P))]
                if 'skin' in n:
                    sk=s.j['skins'][n['skin']]; ibm=s.acc(sk['inverseBindMatrices']).reshape(-1,4,4).transpose(0,2,1)
                    J=s.acc(pr['attributes']['JOINTS_0']).astype(int); Wt=s.acc(pr['attributes']['WEIGHTS_0'])
                    mats=np.array([W[jn]@ibm[k] for k,jn in enumerate(sk['joints'])])
                    res=np.zeros((len(P),4))
                    for c in range(4): res+=Wt[:,c:c+1]*np.einsum('nij,nj->ni',mats[J[:,c]],Ph)
                    vs.append(res[:,:3])
                else: vs.append((W[i]@Ph.T).T[:,:3])
            out[n.get('name',f'node{i}'),i]=np.vstack(vs)
        return out

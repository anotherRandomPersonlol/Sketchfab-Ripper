# FBX export tests

These tools test the FBX writer in `src/Sketchfab-ripper.user.js` without a browser. They read a GLB that the userscript made, write the FBX, import it into Blender and compare it with the GLB.

Requirements: Node.js, Python 3 with numpy and Pillow, and the Blender Python module (`pip install bpy`, Python 3.13).

## Procedure

1. Convert a GLB:
   `node tools/fbx/glb2fbx.js model.glb model.fbx`
2. If `model.fbx.json` lists splits, make the separate metal/rough maps (run from the folder with the `textures` folder):
   `python3 tools/fbx/dosplits.py model.fbx.json .`
3. Compare the vertices in the rest pose and in every clip:
   `python3 tools/fbx/bl_compare.py -- model.glb model.fbx`
4. Compare UVs, vertex colors and normals:
   `python3 tools/fbx/bl_attrs.py -- model.glb model.fbx`
5. Compare the materials of the GLB import and the FBX import (put the GLB next to the `textures` folder):
   `python3 tools/fbx/bl_mats.py -- model.glb model.fbx`

`gltfref.py` computes the reference: the world position of every vertex at a time in a clip, from the GLB alone (node animation, skinning, morph targets). The errors are relative to the size of the scene. Expect about 1e-5 or less.

The rest pose line of `bl_compare.py` is only meaningful when the rest pose is the first frame of the first clip. Blender keeps the pose of the last evaluated action after the action is removed, so with **Rest pose: Static Pose** the rest error is large while every clip matches. Check the joint defaults with ufbx instead (`node.local_transform` against the glTF node TRS).

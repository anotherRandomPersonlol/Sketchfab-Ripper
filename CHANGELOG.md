# Changelog

## Unreleased

### Fixed
- RECORD ALL CLIPS that ends with one recorded clip (for example, cancelled after the first clip) now exports that clip. Before, the export had no animation.
- After a language change, you can drag the panel again.
- A cancelled RECORD ALL CLIPS now shows "Recording cancelled". When the clip list cannot be read, it shows "Recording failed" instead of "Recorded 0 clips".
- Clip recording follows the viewer's playback speed (x0.1, x0.5, x2). Before, at x0.5 or x0.1 the recording ended too early. The exported clip always plays at normal speed, so a slow speed gives more frames per second of animation (with Record FPS set to Max).
- An export started in a background tab no longer stops at "Building scene" until you open the tab again.
- Untextured materials that use the viewer's Diffuse colour (specular/gloss workflow) keep their colour. Before, they were exported white (for example the lamps, cables and papers of the Abandoned Warehouse).
- If one metal, roughness or gloss image cannot be decoded, the other maps of that material are still merged.
- With **Vertex color sRGB>linear** off, FBX vertex colours are no longer converted to sRGB a second time (they were too bright). The GLB marks such colours with `asset.extras.vertexColorSpace: "srgb"`.

### Changed
- The console log reports viewer patches that did not apply, and an error when the patched viewer code did not run (for example, when the page blocks inline scripts). At export start, one line lists which viewer data was found. These lines help with bug reports after a Sketchfab update.
- The script header asks the userscript manager to run the script in the page (`@inject-into page`, `@sandbox JavaScript`). Greasemonkey 4 is not supported.
- An FBX export no longer builds the GLB file it does not use (less memory on large models).
- The console log shows more settings changes, and a warning when the settings cannot be saved (for example, in a private window).
- Code cleanup: unused code and duplicate helpers removed, outdated comments and notes corrected.

## v1.6.0

### New
- The panel is translated: English, Polish, Russian, Japanese, Korean, Spanish, Portuguese (Brazil), German, French and Simplified Chinese. It uses the language of your browser. The new **Language** setting changes it. The console log stays in English.
- Greasy Fork shows the script in the search of these languages (localized name and description).
- Issue form for translation problems.

### Fixed
- Export scale accepts a comma as the decimal separator (`0,01`). Before, some browsers did not accept `0,01` in the field.

### Changed
- The panel is wider while the settings are open, and progress texts wrap instead of being cut.

## v1.5.0

### New
- FBX export: click **FBX** under **Download**. The zip has a binary FBX 7.4 file and the `textures` folder. The file has the same scene as the GLB: nodes, meshes, materials and textures, the skeleton with its bind pose and skin weights, every recorded clip (one animation stack each), morph targets with their animated weights, and vertex colors. Tested by importing into Blender 5.2 and comparing every vertex with the GLB, in the rest pose and in every clip.
- Progress bars: one bar shows the stage (for example "3/6 Building scene" or "2/5 Recording Idle") and one bar shows the progress in that stage. The texture wait shows the captured textures, the merge stage shows the metal/rough and opacity maps done.

### Changed
- The panel has a new look. The download buttons are blue, the record buttons are red, and a button that cannot be used is grey.
- RECORD is now RECORD SINGLE CLIP. It is grey when the model has no animation clips.
- The download buttons are grey while a recording or an export runs.
- FBX export merges the metal/rough maps as PNG (no JPEG loss), because the FBX needs them split again. The FBX zip leaves out the packed metal/rough image, which the FBX does not use.

## v1.4.0

### Fixed
- Skinned models now export the real skeleton: bones with their names, their parents and a bind pose (inverse bind matrices). Before, every joint was a direct child of the skeleton root with an identity inverse bind matrix, so in Blender all bones sat at the root and a cleared pose (Alt+R, Alt+G, Alt+S) lost the shape ([#2](https://github.com/anotherRandomPersonlol/Sketchfab-Ripper/issues/2)).
- When the rig cannot be read, or a local bone matrix cannot be stored exactly, the skin uses the old flat joints. The console log shows which one was used and why.

## v1.3.2

### Changed
- The repository is now github.com/anotherRandomPersonlol/Sketchfab-Ripper. The home, support and icon links in the script header use the new address. The `@namespace` line stays the same, so Tampermonkey keeps treating it as the same script.

## v1.3.1

### Changed
- The script has an icon in Tampermonkey and on Greasy Fork: the Sketchfab logo (`docs/icon64.png`), used as described on the Sketchfab press page.
- README: the script is not an official Sketchfab tool.

## v1.3.0

### Changed
- The script uses modern JavaScript syntax: `let` and `const`, arrow functions, template literals. Exports are the same as in v1.2.1 (tested on 5 models: static, rigged with 26 clips, vertex colours and morph targets). `tools/migration/` has the converter and the checker that compares the new code with the old code.

## v1.2.1

### Fixed
- A joint that does not move in a clip, but is held away from the rest pose, now keeps that pose in the clip. Before, a glTF player showed the rest pose for that joint, so the clip looked wrong (for example Sit1 of "Simple rigged and animated character"). The same fix applies to moving meshes without a skin and to morph weights.

## v1.2.0

### New
- New setting: Keep still clips (off by default). A clip in which no joint moves (a pose clip) is exported as a pose of the skeleton, with two equal keys at the start and the end of the clip. With the setting off, such clips are left out of the file, as before.
- README: list of tested models.

## v1.1.4

### Changed
- The script header has a `@namespace` line (Greasy Fork needs it). Tampermonkey sees this as a new script, so a user who installed an older version can have two copies. Remove the old copy.

## v1.1.3

### Changed
- The script header has no fixed update address. Tampermonkey updates the script from the place that you installed it from (GitHub or Greasy Fork).

## v1.1.2

### New
- New setting: Reduce keyframes (on by default). Leaves out animation keys that the keys before and after them already give, within a small tolerance. Animated exports are about half as large. Turn it off if an animation looks wrong.

### Changed
- The zip file is compressed. Textures are stored as they are, because PNG and JPEG are already compressed.
- Every setting has a tooltip that tells what it does.
- The script header has `@license MIT`.

### Fixed
- The GLB no longer has an empty node for the skipped wireframe overlay.
- The GLB no longer has unused time data for clips that are not exported.

## v1.1.1

### Fixed
- The export no longer contains the wireframe overlay of the viewer as a second mesh. It looked like a stretched copy of the model made of lines, and it did not move with the animation.

### Changed
- The log names the clips that are not exported because they do not move.
- The script header uses `@match` and not a regular expression in `@include`. The script runs on the same pages as before.

## v1.1.0

### New
- Records one full loop of the active clip automatically when you click RECORD.
- Exports material values for models without textures: base color, metalness, roughness, emission and opacity.
- Exports alpha mask (cutout) materials and opacity images without a base color image.
- Follows the Single Sided setting of each material.
- Exports bones with non-uniform scale and shear without data loss, also in Blender.
- Keeps expression switches (bones scaled to zero) instant, as in the viewer.
- New settings: Record FPS, Export scale, Auto single sided, Drop strip slivers, Vertex color sRGB>linear, Flat metal/rough from viewer.
- Issue forms for bug reports and feature requests.

### Fixed
- The viewer bundle ran many times, which used all WebGL contexts and a very large amount of memory.
- Large models lost geometry because separate chunks were merged as duplicates.
- Long thin "stripes" between separate parts of strip geometry.
- Missing triangles in meshes with more than one primitive.
- Textures from a different material, unused textures and duplicate merged textures in the zip.
- Texture file names with spaces or special characters broke the links in the GLB.
- Zero and mirrored bone scales were exported wrong.
- Many smaller problems that two code reviews found (index limits, export during recording, settings validation, memory use).

### Changed
- Script name is now "Sketchfab Ripper", version 1.1.0. The file is now `src/Sketchfab-ripper.user.js`, so Tampermonkey can install it from a link and update it.
- Quieter console log. Each export still lists the materials, so you can paste the log in a bug report.

## v1.0.0
- Multi-clip recording (RECORD ALL CLIPS).

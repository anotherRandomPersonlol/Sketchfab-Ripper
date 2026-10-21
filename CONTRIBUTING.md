# Contributing

Thank you for helping to make Sketchfab Ripper better. This page tells you how to report a problem, how to ask a question and how to send a code change.

Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Ask a question

Use [Discussions](../../discussions) for questions and ideas. Use Issues only for problems with an export.

## Report a problem

Before you report:

1. Update the script to the latest version. Click the Tampermonkey icon, then click **Check for userscript updates**.
2. Reload the model page and export again.
3. Keep the Sketchfab tab visible while you record. A hidden tab loses frames.
4. Look at the [open issues](../../issues). If the same model or the same problem is there, add a comment to that issue.

Then [open an issue](../../issues/new/choose) with the bug report form. The form asks for these data:

- The link to the model on Sketchfab. The model must still be visible on Sketchfab.
- The script version and your browser.
- The settings that you changed.
- The steps that cause the problem.
- What you expected and what you got.
- Where you saw the problem: the glTF viewer, Blender, or both.
- The full console log. Press **F12**, open **Console**, type `[Ripper]` in the filter box, then copy all lines.

Without the model link and the log, the problem usually cannot be found.

Do not attach exported files, textures or screenshots of models that you do not have the rights to share. The link to the model page is enough.

## Send a code change

1. Fork the repository and make a branch from `main`.
2. Make the change in `src/Sketchfab-ripper.user.js`.
3. Obey the code rules below.
4. Export at least one model that your change affects, and one model that it does not affect. Check both in the [glTF viewer](https://gltf-viewer.donmccurdy.com/) and with the [glTF validator](https://github.khronos.org/glTF-Validator/).
5. Open a pull request. Tell which models you tested, and paste the `[Ripper]` log lines that show the change.

### Code rules

- Use `const` for a variable that does not change and `let` for one that changes. Do not use `var`.
- Use arrow functions for callbacks. Keep named helpers as `function` declarations: they are hoisted, and the script calls some of them above the place where they are defined.
- Use template literals for messages: `` `clip ${name}: ${n} frames` ``.
- Keep the script one plain file. Do not use modules, classes or a build step: Tampermonkey and Greasy Fork install the file as it is.
- Write one `log()`, `warn()` or `err()` line for each important action, with the `[Ripper]` prefix that these functions add. A bug report is only as good as the log.
- Put new parts of the script between `// ====` section lines, as the other parts are.
- The sections of `src/Sketchfab-ripper.user.js`, in order: settings, logging, UI text (translations), math, sheared joint matrices, viewer access (node matrices, materials, morph targets, the rig, the animation manager), capture hooks (textures, meshes), recorder, texture merges and readiness, glTF builder, export (GLB and FBX downloads), UI panel, FBX writer, script interceptor. Keep the FBX writer directly above the script interceptor: `tools/fbx/glb2fbx.js` cuts the writer out of the file between those two section lines.
- Run `node --check src/Sketchfab-ripper.user.js` before you commit.
- Do not change `@version` in the script header. The maintainer sets it at release: a new `@version` on `main` publishes a release at once.
- Add a line to [`CHANGELOG.md`](CHANGELOG.md) under `## Unreleased` at the top. Add that heading if it is not there.
- Put research notes and test results in [`docs/NOTES.md`](docs/NOTES.md).

### Fix or add a translation

The panel text is in the `STRINGS` table near the top of `src/Sketchfab-ripper.user.js`, between `// @i18n-begin` and `// @i18n-end`. English (`en`) is the base. The console log stays in English.

To fix a text:

1. Find the key of the text in the table of your language, for example `set_reduce_tip`.
2. Change the text. Keep each part in curly brackets, for example `{n}` or `{name}`, exactly as in English.
3. Run `python3 tools/i18n/check_strings.py`. Fix all errors that it shows.

To add a language:

1. Run `python3 tools/i18n/compare.py --export > en.txt`. The file has one numbered line for each English text.
2. Translate the lines. Keep the numbers and the parts in curly brackets.
3. Run `python3 tools/i18n/import_numbered.py <code> <file>`, for example `zh-CN zh.txt`. For a language with more plural forms than English (for example Polish or Russian), write the extra forms (`few`, `many`) by hand.
4. Add the language name to `LANG_NAMES` and add `@name:<code>` and `@description:<code>` lines to the script header.
5. Run `python3 tools/i18n/check_strings.py`. Fix all errors that it shows.
6. Open the panel in your language and make sure that the buttons and the settings fit.

To compare a translation with other translators, run `python3 tools/i18n/compare.py --compare <code> <file1> <file2> ...`. It shows only the lines that are different.

### Probes

The [`tools/`](tools/) folder has read-only console probes. A probe shows how the viewer stores a part of the model, for example textures, materials or animation targets. To use a probe, open the console, change the context list (it shows **top**) to the viewer frame, and paste the probe.

## License

When you send a change, you agree that it is published under the [MIT license](LICENSE) of this repository.

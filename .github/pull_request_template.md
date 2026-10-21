<!-- Thank you for the change. Fill in the parts that apply and delete the others. See CONTRIBUTING.md. -->

## What changes

<!-- What does this pull request change, and why? -->

## Tested with

<!-- Links to the Sketchfab models you exported, and where you checked the result
     (glTF viewer, glTF validator, Blender). Test one model that the change affects
     and one that it does not affect. -->

-

<!-- Paste the [Ripper] console lines that show the change (F12 > Console, filter: [Ripper]). -->

```
```

## Checklist

- [ ] `node --check src/Sketchfab-ripper.user.js` passes.
- [ ] `python3 tools/i18n/check_strings.py` shows 0 errors (for changes to the panel or the translations).
- [ ] New UI text goes through `i18n()` and is in the `STRINGS` table in English.
- [ ] Each important action writes one `log()`, `warn()` or `err()` line.
- [ ] `@version` and `CHANGELOG.md` are updated (see CONTRIBUTING.md).
- [ ] The description has no closing keyword such as "fixes #12". The maintainer closes issues after testing.

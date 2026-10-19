#!/usr/bin/env python3
"""Put a numbered translation (from compare.py --export) into the STRINGS table.

usage:
  python3 tools/i18n/import_numbered.py zh-CN zh.txt          write it into the userscript
  python3 tools/i18n/import_numbered.py zh-CN zh.txt --dry    only print the block

Line N of the file is the translation of line N of `compare.py --export`.
Plural lines: a language with one plural form (zh, ja, ko) uses the line of
the English "other" form. A language with more forms than English (pl, ru)
needs its extra forms (few, many) written by hand: the import stops with an
error for those keys. Run check_strings.py after the import.
"""
import json, os, re, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_strings import load, SRC
from compare import entries, read_numbered

def plural_forms(lang):
    js = f"process.stdout.write(JSON.stringify(new Intl.PluralRules({json.dumps(lang)}).resolvedOptions().pluralCategories))"
    return json.loads(subprocess.run(['node', '-e', js], capture_output=True, text=True, check=True).stdout)

def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    lang, path, dry = sys.argv[1], sys.argv[2], '--dry' in sys.argv
    strings, _, _ = load()
    got = read_numbered(path)
    rows = entries(strings)
    need = plural_forms(lang)
    table, problems = {}, []
    for i, (label, k, form, en) in enumerate(rows, 1):
        text = got.get(i)
        if text is None:
            problems.append(f'line {i} ({label}) is missing'); continue
        if not form:
            table[k] = text; continue
        d = table.setdefault(k, {})
        if form == 'other' or len(need) > 1:
            d[form] = text
    for k, v in list(table.items()):
        if isinstance(v, dict):
            if need == ['other']:
                table[k] = {'other': v.get('other') or next(iter(v.values()))}
            else:
                miss = [f for f in need if f not in v]
                if miss:
                    problems.append(f'{k}: plural forms {miss} must be written by hand')
    if problems:
        sys.exit('import stopped:\n  ' + '\n  '.join(problems))
    key = lang if re.fullmatch(r'[a-z]+', lang) else "'" + lang + "'"
    lines = [f'        {key}: {{']
    for k, v in table.items():
        if isinstance(v, dict):
            inner = ', '.join(f'{f}: {json.dumps(t, ensure_ascii=False)}' for f, t in v.items())
            lines.append(f'            {k}: {{ {inner} }},')
        else:
            lines.append(f'            {k}: {json.dumps(v, ensure_ascii=False)},')
    lines.append('        },')
    block = '\n'.join(lines) + '\n'
    if dry:
        print(block); return
    src = open(SRC, encoding='utf-8').read()
    end = src.index('    };\n    // @i18n-end')
    begin = src.index('// @i18n-begin')
    keyre = re.escape(lang) if re.fullmatch(r'[a-z]+', lang) else '[\'"]' + re.escape(lang) + '[\'"]'
    pat = re.compile(r'\n        ' + keyre + r': \{\n.*?\n        \},\n', re.S)
    m = pat.search(src, begin, end)
    if m:
        src = src[:m.start() + 1] + block + src[m.end():]
        print(f'{lang}: replaced')
    else:
        src = src[:end] + block + src[end:]
        print(f'{lang}: added')
    open(SRC, 'w', encoding='utf-8').write(src)
    print('now run: python3 tools/i18n/check_strings.py')

if __name__ == '__main__':
    main()

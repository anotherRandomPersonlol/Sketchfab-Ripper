#!/usr/bin/env python3
"""Strict checker for the panel translations in src/Sketchfab-ripper.user.js.

usage:
  python3 tools/i18n/check_strings.py            check, exit 1 on errors
  python3 tools/i18n/check_strings.py --table pl print a review table (key, English, Polish)

Errors (exit 1):
  - a language misses a key of English, or has a key that English does not have
  - placeholders ({n}, {name}, ...) differ from English
  - a plural entry misses a plural form that the language needs (Intl.PluralRules)
  - code uses i18n('key') / i18nN('key') with a key that is not in English
  - UI text is written directly in code (textContent/title/progress/button text)
Warnings:
  - a key in English that the code does not use
  - a translation that is the same as English (allowed for some keys)
  - a button text much longer than in English (it can wrap or be cut)
Needs Node.js (to read the table and to get the plural rules).
"""
import json, os, re, subprocess, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
SRC = os.path.join(ROOT, 'src', 'Sketchfab-ripper.user.js')
# same word as English in some languages (for example "Animation" in German and French)
SAME_OK = {'btn_glb', 'btn_fbx', 'opt_auto', 'pr_seconds', 'st_clips', 'sec_animation', 'fbx_animation', 'fbx_animation_n'}
DYNAMIC_PREFIX = ('fbx_',)      # built from FbxWriter progress labels in fbxLabel()
PH = re.compile(r'\{(\w+)\}')

def load():
    src = open(SRC, encoding='utf-8').read()
    a = src.index('// @i18n-begin'); b = src.index('// @i18n-end')
    block = src[a:b]
    js = block[block.index('const STRINGS'):] + """
const out = { strings: STRINGS, plural: {} };
for (const l of Object.keys(STRINGS)) out.plural[l] = new Intl.PluralRules(l).resolvedOptions().pluralCategories;
process.stdout.write(JSON.stringify(out));"""
    res = subprocess.run(['node', '-e', js], capture_output=True, text=True)
    if res.returncode:
        sys.exit('could not read STRINGS:\n' + res.stderr)
    data = json.loads(res.stdout)
    code = src[:a] + src[b:]
    return data['strings'], data['plural'], code

def forms(v):
    return v if isinstance(v, dict) else {'': v}

def check(strings, plural, code):
    errors, warns = [], []
    en = strings['en']
    for lang, table in strings.items():
        if lang == 'en':
            continue
        for k in en:
            if k not in table:
                errors.append(f'{lang}: missing key {k}  (en: {en[k]!r})')
        for k in table:
            if k not in en:
                errors.append(f'{lang}: key {k} is not in English')
        for k, v in table.items():
            if k not in en:
                continue
            ev = en[k]
            want = set(PH.findall(json.dumps(ev, ensure_ascii=False)))
            for form, text in forms(v).items():
                got = set(PH.findall(text))
                if got != want:
                    errors.append(f'{lang}: {k}{"." + form if form else ""} placeholders {sorted(got)} != English {sorted(want)}')
            if isinstance(ev, dict) != isinstance(v, dict):
                errors.append(f'{lang}: {k} must be {"a plural object" if isinstance(ev, dict) else "a plain text"} like English')
            if isinstance(v, dict):
                miss = [f for f in plural[lang] if f not in v]
                if miss:
                    errors.append(f'{lang}: {k} misses plural forms {miss} (needed: {plural[lang]})')
            if v == ev and k not in SAME_OK:
                warns.append(f'{lang}: {k} is the same as English: {v!r}')
            if k.startswith('btn_') and isinstance(v, str) and len(v) > 1.35 * len(ev) and len(v) > 8:
                warns.append(f'{lang}: {k} is {len(v)} characters, English {len(ev)} (check that the button fits): {v!r}')
    for k, v in en.items():
        if isinstance(v, dict):
            miss = [f for f in plural['en'] if f not in v]
            if miss:
                errors.append(f'en: {k} misses plural forms {miss}')
    code_nc = '\n'.join(l for l in code.split('\n') if not l.strip().startswith('//'))
    used = set(re.findall(r"\bi18nN?\('(\w+)'", code_nc))
    literal = set(re.findall(r"'(\w+)'", code_nc))
    for k in sorted(used):
        if k not in en:
            errors.append(f'code: i18n key {k} is not in English')
    for k in en:
        if k not in used and k not in literal and not k.startswith(DYNAMIC_PREFIX):
            warns.append(f'en: key {k} is not used in the code')
    pats = [
        (r"\.(?:textContent|title)\s*=\s*(['`])([^'`]*)\1", 'text set directly'),
        (r"\b(?:progStage|progSub|progDone|setRecLabel|setRecAllLabel|section)\((?:[^()'`]*,\s*)?(['`])([^'`]*)\1", 'progress/label text'),
        (r"\bbutton\('[\w-]*',\s*(['`])([^'`]*)\1", 'button text'),
    ]
    for i, line in enumerate(code.split('\n'), 1):
        # "// i18n-ok" on a line: text that stays the same in every language (for example the brand name)
        if line.strip().startswith('//') or 'i18n-ok' in line or 'css.textContent' in line or 'script.textContent' in line:
            continue
        for pat, what in pats:
            for m in re.finditer(pat, line):
                words = re.sub(r'\$\{[^}]*\}', '', m.group(2))   # only ${...} values: nothing to translate
                if re.search(r'[A-Za-z]', words):
                    errors.append(f'code line ~{i}: {what} not translated: {m.group(2)!r}')
    return errors, warns

def table(strings, lang):
    en, tr = strings['en'], strings.get(lang, {})
    rows = []
    for k, v in en.items():
        for form, text in forms(v).items():
            t = tr.get(k)
            t = (t.get(form) if isinstance(t, dict) else t) if t is not None else '(missing)'
            rows.append((k + ('.' + form if form else ''), text, t))
        if isinstance(tr.get(k), dict):
            for form in tr[k]:
                if not isinstance(v, dict) or form not in v:
                    rows.append((k + '.' + form, '', tr[k][form]))
    w = max(len(r[0]) for r in rows)
    for r in rows:
        print(f'{r[0]:<{w}} | {r[1]}\n{"":<{w}} | {r[2]}\n')

if __name__ == '__main__':
    strings, plural, code = load()
    if len(sys.argv) > 2 and sys.argv[1] == '--table':
        table(strings, sys.argv[2]); sys.exit(0)
    errors, warns = check(strings, plural, code)
    for w in warns: print('WARN ', w)
    for e in errors: print('ERROR', e)
    langs = ', '.join(f'{l} ({len(v)} keys)' for l, v in strings.items())
    print(f'\n{len(errors)} error(s), {len(warns)} warning(s). Languages: {langs}')
    sys.exit(1 if errors else 0)

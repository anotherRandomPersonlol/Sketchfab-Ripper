#!/usr/bin/env python3
"""Second opinions for a translation: compare our strings with other translators.

1. Export the English text as a numbered list:
     python3 tools/i18n/compare.py --export > en.txt
2. Paste en.txt into each translator (Google Translate, Gemini, DeepSeek, ...).
   Ask it to keep the numbers and the {placeholders}. Save each answer as a
   text file, for example google.txt, gemini.txt, deepseek.txt.
3. Compare:
     python3 tools/i18n/compare.py --compare pl google.txt gemini.txt deepseek.txt
   Give the files in order of trust: the first file counts most.

The output lists only the lines where a source differs from our text, with a
similarity score (1.00 = same words) for each source, and a warning when a
source lost a {placeholder}. Lines where every source agrees are only counted.
"""
import difflib, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_strings import load, forms, PH

def entries(strings):
    out = []
    for k, v in strings['en'].items():
        for form, text in forms(v).items():
            out.append((k + ('.' + form if form else ''), k, form, text))
    return out

def norm(s):
    s = s.lower().replace('…', '...')
    return re.sub(r'[\s\.,:;!?()"\'«»„”“]+', ' ', s).strip()

def read_numbered(path):
    got = {}
    for line in open(path, encoding='utf-8'):
        m = re.match(r'\s*(\d+)\s*[.)]\s*(.*\S)', line)
        if m:
            got[int(m.group(1))] = m.group(2)
    return got

def main():
    strings, _, _ = load()
    rows = entries(strings)
    if sys.argv[1:2] == ['--export']:
        for i, (_, _, _, text) in enumerate(rows, 1):
            print(f'{i}. {text}')
        return
    if sys.argv[1:2] != ['--compare'] or len(sys.argv) < 4:
        sys.exit(__doc__)
    lang, files = sys.argv[2], sys.argv[3:]
    srcs = [(os.path.splitext(os.path.basename(f))[0], read_numbered(f)) for f in files]
    same = 0
    for i, (label, k, form, en) in enumerate(rows, 1):
        ours_all = strings[lang].get(k)
        if ours_all is None:
            continue
        # plural: the source may give any of our forms (Polish has more forms than English)
        cands = list(ours_all.values()) if isinstance(ours_all, dict) else [ours_all]
        ours = ours_all.get(form, cands[0]) if isinstance(ours_all, dict) else ours_all
        lines, differs = [], False
        for name, got in srcs:
            g = got.get(i)
            if g is None:
                lines.append(f'      {name:>9}: (no line {i})'); continue
            r = max(difflib.SequenceMatcher(None, norm(c), norm(g)).ratio() for c in cands)
            lost = set(PH.findall(en)) - set(PH.findall(g))
            if r < 0.999 or lost:
                differs = True
            lines.append(f'      {name:>9}: {g}   [{r:.2f}]' + (f'  LOST {sorted(lost)}' if lost else ''))
        if differs:
            shown = ' / '.join(f'{f}: {v}' for f, v in ours_all.items()) if isinstance(ours_all, dict) else ours
            print(f'{i:>3}. {label}\n      {"English":>9}: {en}\n      {"ours":>9}: {shown}')
            print('\n'.join(lines) + '\n')
        else:
            same += 1
    print(f'{same} of {len(rows)} lines: all sources agree with our text.')

if __name__ == '__main__':
    main()

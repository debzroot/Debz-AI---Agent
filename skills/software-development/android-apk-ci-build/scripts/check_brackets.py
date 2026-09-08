#!/usr/bin/env python3
"""Check bracket balance ({}, (), []) in Dart/Kotlin/Java source.

Naive counting (e.g. `s.count('{')`) false-positives on string literals that
contain brackets — notably Dart regexes like r'[^\]]*' or JSON strings.
This tokenizer strips string literals (single/double/raw r'...'), line and
block comments FIRST, then counts brackets on the remaining code only.

Usage: python3 check_brackets.py <file1> [file2 ...]
Exit code: 0 if all balanced, 1 otherwise (prints offending files).
"""
import sys


def strip_code(s: str) -> str:
    out = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        # line comment
        if c == '/' and i + 1 < n and s[i + 1] == '/':
            while i < n and s[i] != '\n':
                i += 1
            continue
        # block comment
        if c == '/' and i + 1 < n and s[i + 1] == '*':
            i += 2
            while i + 1 < n and not (s[i] == '*' and s[i + 1] == '/'):
                i += 1
            i += 2
            continue
        # raw string prefix r'...' or r"..."
        if c == 'r' and i + 1 < n and s[i + 1] in ('"', "'"):
            quote = s[i + 1]
            i += 2
            while i < n and s[i] != quote:
                i += 1
            i += 1
            continue
        # normal string
        if c in ('"', "'"):
            quote = c
            i += 1
            while i < n:
                if s[i] == '\\':
                    i += 2
                    continue
                if s[i] == quote:
                    break
                i += 1
            i += 1
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def check(path: str) -> bool:
    s = open(path, encoding='utf-8').read()
    code = strip_code(s)
    ok = True
    for a, b in [('{', '}'), ('(', ')'), ('[', ']')]:
        ca, cb = code.count(a), code.count(b)
        if ca != cb:
            ok = False
            print(f'{path}: {a}{b} {ca} vs {cb} MISMATCH')
    if ok:
        print(f'{path}: OK')
    return ok


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    results = [check(p) for p in sys.argv[1:]]
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())

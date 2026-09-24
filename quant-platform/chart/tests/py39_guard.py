"""Nothing in qp may need a Python newer than the box's.

The box runs Amazon Linux 2023's /usr/bin/python3, which is 3.9. The machine
the tests usually run on is newer, so a 3.10-only construct passes every test
here and fails on the box — which is what happened to chart/parity.py:

    def latest_for(ids) -> dict | None:
    TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'

`X | None` in an annotation is evaluated when the function is DEFINED, on 3.9,
unless the file starts with `from __future__ import annotations` (which the
rest of qp does). This reads every qp source file and refuses:

  · `A | B` in a function or module/class-level annotation, in a file without
    the __future__ import
  · `match` statements (3.10)
  · `isinstance(x, A | B)` — evaluated at run time whatever the import says
"""
import ast
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DIRS = ['chart', 'tools']
bad = []


def has_union(node):
    return any(isinstance(n, ast.BinOp) and isinstance(n.op, ast.BitOr)
               for n in ast.walk(node)) if node is not None else False


files = [p for d in DIRS for p in (ROOT / d).rglob('*.py')
         if '__pycache__' not in p.parts]
for p in files:
    src = p.read_text(encoding='utf-8')
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        bad.append(f'{p.relative_to(ROOT)}: does not parse: {e}')
        continue
    future = any(isinstance(n, ast.ImportFrom) and n.module == '__future__'
                 and any(a.name == 'annotations' for a in n.names)
                 for n in tree.body)
    for n in ast.walk(tree):
        if type(n).__name__ == 'Match':
            bad.append(f'{p.relative_to(ROOT)}:{n.lineno}: match statement (3.10+)')
        if isinstance(n, ast.Call) and getattr(n.func, 'id', None) in ('isinstance', 'issubclass') \
                and len(n.args) == 2 and has_union(n.args[1]):
            bad.append(f'{p.relative_to(ROOT)}:{n.lineno}: isinstance with A | B (3.10+)')
        if future:
            continue
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            anns = [a.annotation for a in n.args.args + n.args.kwonlyargs + n.args.posonlyargs]
            anns += [n.args.vararg and n.args.vararg.annotation,
                     n.args.kwarg and n.args.kwarg.annotation, n.returns]
            if any(has_union(a) for a in anns if a is not None):
                bad.append(f'{p.relative_to(ROOT)}:{n.lineno}: `A | B` annotation on '
                           f'{n.name}() without `from __future__ import annotations`')
        if isinstance(n, ast.AnnAssign) and has_union(n.annotation):
            bad.append(f'{p.relative_to(ROOT)}:{n.lineno}: `A | B` variable annotation '
                       'without `from __future__ import annotations`')

print(f'{len(files)} files read')
for b in bad:
    print('  FAIL', b)
print(f'\n{0 if bad else 1} passed, {len(bad)} failed')
sys.exit(1 if bad else 0)

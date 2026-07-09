#!/usr/bin/env python3
"""Flip PROGRESS.html tracked-item statuses by step key.
Usage: flip-progress.py <status> KEY [KEY ...]
  status in {todo,wip,done,blocked}; KEY is the .k label (S1, G1, C3, S-A, ...).
Updates the item's data-status attribute AND its visible .stamp text.
"""
import re, sys, pathlib

PROG = pathlib.Path(__file__).resolve().parent.parent / "PROGRESS.html"

def flip(html, key, status):
    # Match a full <li class="item" ...> ... </li> whose .k span text == key.
    pat = re.compile(r'(<li class="item[^"]*"[^>]*>)(.*?)(</li>)', re.S)
    hits = [0]
    def repl(m):
        open_tag, body, close = m.group(1), m.group(2), m.group(3)
        km = re.search(r'<span class="k">([^<]+)</span>', body)
        matched = km and km.group(1).strip() == key
        if not matched:
            # C-items carry the key inside <span class="t">Cx · …> (no .k). Match key at the
            # start, bounded so C1 never matches C10.
            tm = re.search(r'<span class="t">\s*([^<·]+)', body)
            label = tm.group(1).strip() if tm else ''
            matched = bool(re.match(rf'{re.escape(key)}(?![0-9A-Za-z-])', label))
        if not matched:
            return m.group(0)
        hits[0] += 1
        open_tag = re.sub(r'data-status="[a-z]+"', f'data-status="{status}"', open_tag)
        body = re.sub(r'(<span class="stamp">)[a-z]+(</span>)', rf'\g<1>{status}\g<2>', body, count=1)
        return open_tag + body + close
    html = pat.sub(repl, html)
    return html, hits[0]

def main():
    status, keys = sys.argv[1], sys.argv[2:]
    assert status in {"todo", "wip", "done", "blocked"}, status
    html = PROG.read_text()
    for key in keys:
        html, n = flip(html, key, status)
        if n != 1:
            sys.exit(f"ERROR: key {key!r} matched {n} items (expected 1)")
        print(f"  {key} -> {status}")
    PROG.write_text(html)

if __name__ == "__main__":
    main()

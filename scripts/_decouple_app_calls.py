#!/usr/bin/env python3
"""Mechanical decoupling: replace app.getPath/getVersion/isPackaged in pure-logic
core modules with getHost() from the platform abstraction layer.

Excludes shell/IPC/platform files which legitimately import electron.
Skips comment lines. Adds the getHost import and removes now-unused `app` import.
"""
import os, re, pathlib

ELECTRON = pathlib.Path(r'D:\pipiclaw\piclaw\electron')
PLATFORM_DIR = ELECTRON / 'platform'

EXCLUDE = {
    ELECTRON / 'main.ts',
    ELECTRON / 'core' / 'WindowManager.ts',
    ELECTRON / 'core' / 'TrayManager.ts',
    ELECTRON / 'core' / 'MiniWindow.ts',
    ELECTRON / 'core' / 'IpcServer.ts',
    ELECTRON / 'core' / 'AutoUpdater.ts',
}

def is_comment_line(line: str) -> bool:
    s = line.strip()
    return (s.startswith('//') or s.startswith('/*') or s.startswith('*')
            or s.startswith('*/') or s.startswith('* '))

def transform_calls(text: str):
    out, changed = [], False
    for line in text.split('\n'):
        if is_comment_line(line):
            out.append(line); continue
        new = line
        if 'app.getPath(' in new:
            new = new.replace('app.getPath(', 'getHost().getPath('); changed = True
        if 'app.getVersion()' in new:
            new = new.replace('app.getVersion()', 'getHost().getVersion()'); changed = True
        if 'app.isPackaged' in new:
            new = new.replace('app.isPackaged', 'getHost().isPackaged()'); changed = True
        out.append(new)
    return '\n'.join(out), changed

def add_import(text: str, file_dir: pathlib.Path):
    if 'getHost' in text:
        return text
    rel = os.path.relpath(str(PLATFORM_DIR), str(file_dir)).replace('\\', '/')
    spec = rel + '/runtime'
    imp = f"import {{ getHost }} from '{spec}'"
    lines = text.split('\n')
    first_idx = -1
    for i, l in enumerate(lines):
        if re.match(r'^import\s', l):
            first_idx = i; break
    if first_idx == -1:
        lines.insert(0, imp)
    else:
        lines.insert(first_idx + 1, imp)
    return '\n'.join(lines)

def app_still_used(text: str) -> bool:
    # standalone `app` token, not inside getHost and not part of another word
    return bool(re.search(r'(?<![\w.])app(?![\w])', text))

def remove_unused_app(text: str):
    if app_still_used(text):
        return text
    lines = text.split('\n')
    for i, l in enumerate(lines):
        m = re.match(r"^(import\s*\{)([^}]*)(\}\s*from\s*['\"]electron['\"]\s*;?)$", l)
        if m:
            members = m.group(2)
            new_members = re.sub(r'\bapp\b\s*,?', '', members)
            new_members = re.sub(r',\s*,', ',', new_members)
            new_members = new_members.strip().strip(',').strip()
            if new_members == '':
                lines[i] = ''
            else:
                lines[i] = m.group(1) + new_members + m.group(3)
            break
    return '\n'.join(lines)

def main():
    targets = []
    for root, dirs, files in os.walk(ELECTRON):
        if 'platform' in dirs:
            dirs.remove('platform')  # never touch platform layer
        for f in files:
            if not f.endswith('.ts'):
                continue
            p = pathlib.Path(root) / f
            if p in EXCLUDE:
                continue
            txt = p.read_text(encoding='utf-8')
            if 'app.getPath(' in txt or 'app.getVersion()' in txt or 'app.isPackaged' in txt:
                targets.append(p)
    print(f"Found {len(targets)} target files")
    changed_files = []
    for p in targets:
        orig = p.read_text(encoding='utf-8')
        new, did = transform_calls(orig)
        if not did:
            continue
        new = add_import(new, p.parent)
        new = remove_unused_app(new)
        if new != orig:
            p.write_text(new, encoding='utf-8')
            changed_files.append(str(p.relative_to(ELECTRON)))
    for c in changed_files:
        print("CHANGED  " + c)
    print(f"\nTotal changed: {len(changed_files)}")

if __name__ == '__main__':
    main()

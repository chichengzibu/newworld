#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解耦 core 层剩余 app.* 调用:getAppPath() -> getHost().getAppPath();app.quit() -> getHost().quit()

逐文件精确文本替换,避免 Edit 工具因显示/字节不一致导致的匹配失败。
- SelfLearner.ts:696   app.getAppPath() -> getHost().getAppPath()  (getHost 已导入)
- SkillLoader.ts:14     import { app } from 'electron' -> import { getHost } from '../platform/runtime'
                   :78  app.getAppPath() -> getHost().getAppPath()
- TrayManager.ts       新增 import { getHost } from '../platform/runtime' (在 isOhos import 之后)
                   :154 app.quit() -> getHost().quit()  (app 仍用于 isPackaged,保留 import)
"""
import io, pathlib, sys

E = pathlib.Path('electron')

def edit(path: str, replacements: list, add_import: str | None = None, after_marker: str | None = None):
    p = E / path
    t = p.read_text(encoding='utf-8')
    orig = t
    for old, new in replacements:
        if old not in t:
            print(f'  [WARN] 未找到片段: {path} :: {old!r}')
        t = t.replace(old, new, 1)
    if add_import and after_marker:
        if add_import.splitlines()[0] not in t:
            lines = t.split('\n')
            out = []
            inserted = False
            for ln in lines:
                out.append(ln)
                if (not inserted) and ln.strip() == after_marker.strip():
                    out.append(add_import)
                    inserted = True
            t = '\n'.join(out)
            if not inserted:
                print(f'  [WARN] 未找到锚点插入 import: {path} :: {after_marker!r}')
        else:
            print(f'  [INFO] import 已存在,跳过: {path}')
    if t != orig:
        p.write_text(t, encoding='utf-8')
        print(f'  [OK] 已修改 {path}')
    else:
        print(f'  [SKIP] 无变化 {path}')

print('== SelfLearner.ts ==')
edit('learning/SelfLearner.ts', [
    ('app.getAppPath()', 'getHost().getAppPath()'),
])

print('== SkillLoader.ts ==')
edit('skill/SkillLoader.ts', [
    ("import { app } from 'electron';", "import { getHost } from '../platform/runtime';"),
    ('app.getAppPath()', 'getHost().getAppPath()'),
])

print('== TrayManager.ts ==')
edit('core/TrayManager.ts',
     [('app.quit();', 'getHost().quit();')],
     add_import="import { getHost } from '../platform/runtime';",
     after_marker="import { isOhos } from '../platform/detect';")

print('done')

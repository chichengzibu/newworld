#!/usr/bin/env python3
"""Add `import { getHost } from '<rel>/platform/runtime'` to every decoupled file
that uses getHost() but lacks the import statement. Detects the IMPORT (not the
token in call sites) so it won't skip files that already call getHost()."""
import os, re, pathlib

E = pathlib.Path(r'D:\pipiclaw\piclaw\electron')
PLATFORM_DIR = E / 'platform'
changed = """agent/AgentCheckpoint.ts agent/tools/BashTool.ts agent/tools/EditTool.ts agent/tools/ReadTool.ts agent/tools/_globInternals.ts channel/IMConfigStore.ts chat/ChatConfig.ts contentgen/DocxRenderer.ts contentgen/PdfRenderer.ts contentgen/PptxRenderer.ts contentgen/XlsxRenderer.ts core/ConfigStore.ts core/LogManager.ts hermes/HermesMemory.ts insight/CostTracker.ts insight/CrashReport.ts learning/SelfLearner.ts learning/SkillEffectivenessTracker.ts llm/LlmConfigStore.ts models/ModelConfig.ts models/ModelRatingManager.ts models/ModelUsageTracker.ts openclaw/OpenClawGateway.ts openclaw/OpenClawServer.ts permissions/PermissionConfig.ts sandbox/networkPolicy.ts sandbox/resourceLimits.ts sandbox/workspace.ts skill/ClawHubManager.ts skill/SkillManager.ts skill/SkillSigner.ts task/TaskLog.ts utils/ConversationExporter.ts""".split()

IMPORT_RE = re.compile(r"import\s*\{[^}]*getHost[^}]*\}\s*from\s*['\"][^'\"]*platform/runtime['\"]")

def has_import(text):
    return bool(IMPORT_RE.search(text))

added, already = [], []
for rel in changed:
    p = E / rel
    txt = p.read_text(encoding='utf-8')
    if has_import(txt):
        already.append(rel)
        continue
    if 'getHost' not in txt:
        continue  # not actually decoupled; skip
    relpath = os.path.relpath(str(PLATFORM_DIR), str(p.parent)).replace('\\', '/')
    spec = relpath + '/runtime'
    imp = f"import {{ getHost }} from '{spec}'"
    lines = txt.split('\n')
    first_idx = -1
    for i, l in enumerate(lines):
        if re.match(r'^import\s', l):
            first_idx = i
            break
    if first_idx == -1:
        lines.insert(0, imp)
    else:
        lines.insert(first_idx + 1, imp)
    p.write_text('\n'.join(lines), encoding='utf-8')
    added.append(rel)

print("ADDED import to", len(added), "files:")
for a in added: print("  +", a)
print("\nAlready had import:", len(already), "files:", already)

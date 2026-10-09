#!/usr/bin/env python3
"""Refined pass: remove now-unused `app` import after decoupling to getHost().
Strips comments + string/template literals AND import lines before testing for
real `app` usage, so the import declaration's own `app` token doesn't keep itself
alive. Keeps the import if `app` is genuinely used in code (e.g. app.on/app.quit)."""
import re, pathlib

E = pathlib.Path(r'D:\pipiclaw\piclaw\electron')
changed = """agent/AgentCheckpoint.ts agent/tools/BashTool.ts agent/tools/EditTool.ts agent/tools/ReadTool.ts agent/tools/_globInternals.ts channel/IMConfigStore.ts chat/ChatConfig.ts contentgen/DocxRenderer.ts contentgen/PdfRenderer.ts contentgen/PptxRenderer.ts contentgen/XlsxRenderer.ts core/ConfigStore.ts core/LogManager.ts hermes/HermesMemory.ts insight/CostTracker.ts insight/CrashReport.ts learning/SelfLearner.ts learning/SkillEffectivenessTracker.ts llm/LlmConfigStore.ts models/ModelConfig.ts models/ModelRatingManager.ts models/ModelUsageTracker.ts openclaw/OpenClawGateway.ts openclaw/OpenClawServer.ts permissions/PermissionConfig.ts sandbox/networkPolicy.ts sandbox/resourceLimits.ts sandbox/workspace.ts skill/ClawHubManager.ts skill/SkillManager.ts skill/SkillSigner.ts task/TaskLog.ts utils/ConversationExporter.ts""".split()

def strip_noise(text: str) -> str:
    t = re.sub(r'/\*[\s\S]*?\*/', ' ', text)
    t = re.sub(r"'(?:\\.|[^'\\])*'", "''", t)
    t = re.sub(r'"(?:\\.|[^"\\])*"', '""', t)
    t = re.sub(r'`(?:\\.|[^`\\])*`', '``', t)
    t = re.sub(r'//[^\n]*', ' ', t)
    return t

def app_used_in_code(text: str) -> bool:
    code_lines = [l for l in text.split('\n') if not re.match(r'^\s*import\s', l)]
    clean = strip_noise('\n'.join(code_lines))
    return bool(re.search(r'(?<![\w.])app(?![\w])', clean))

def remove_app_from_import(text: str) -> str:
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

removed, kept = [], []
for rel in changed:
    p = E / rel
    txt = p.read_text(encoding='utf-8')
    if 'getHost' not in txt:
        continue
    if app_used_in_code(txt):
        kept.append(rel)
        continue
    new = remove_app_from_import(txt)
    if new != txt:
        p.write_text(new, encoding='utf-8')
        removed.append(rel)

print("REMOVED app import in", len(removed), "files:")
for r in removed: print("  -", r)
print("\nKEPT app import (app still used in code) in", len(kept), "files:")
for k in kept: print("  -", k)

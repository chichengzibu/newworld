#!/usr/bin/env python3
import re, pathlib
E = pathlib.Path(r'D:\pipiclaw\piclaw\electron')
changed = """agent/AgentCheckpoint.ts agent/tools/BashTool.ts agent/tools/EditTool.ts agent/tools/ReadTool.ts agent/tools/_globInternals.ts channel/IMConfigStore.ts chat/ChatConfig.ts contentgen/DocxRenderer.ts contentgen/PdfRenderer.ts contentgen/PptxRenderer.ts contentgen/XlsxRenderer.ts core/ConfigStore.ts core/LogManager.ts hermes/HermesMemory.ts insight/CostTracker.ts insight/CrashReport.ts learning/SelfLearner.ts learning/SkillEffectivenessTracker.ts llm/LlmConfigStore.ts models/ModelConfig.ts models/ModelRatingManager.ts models/ModelUsageTracker.ts openclaw/OpenClawGateway.ts openclaw/OpenClawServer.ts permissions/PermissionConfig.ts sandbox/networkPolicy.ts sandbox/resourceLimits.ts sandbox/workspace.ts skill/ClawHubManager.ts skill/SkillManager.ts skill/SkillSigner.ts task/TaskLog.ts utils/ConversationExporter.ts""".split()

STRIP = [
    (r'/\*[\s\S]*?\*/', ' '),
    (r"'(?:\\.|[^'\\])*'", "''"),
    (r'"(?:\\.|[^"\\])*"', '""'),
    (r'`(?:\\.|[^`\\])*`', '``'),
    (r'//[^\n]*', ' '),
]

def strip_noise(text):
    for pat, rep in STRIP:
        text = re.sub(pat, rep, text)
    return text

problems = []
for rel in changed:
    p = E / rel
    t = p.read_text(encoding='utf-8')
    # 1) getHost must be imported
    if 'getHost' not in t:
        problems.append((rel, 'getHost NOT imported'))
        continue
    # 2) no leftover app.getPath/getVersion/isPackaged in real code
    code_lines = [l for l in t.split('\n') if not re.match(r'^\s*import\s', l)]
    clean = strip_noise('\n'.join(code_lines))
    for bad in ('app.getPath(', 'app.getVersion()', 'app.isPackaged'):
        if bad in clean:
            problems.append((rel, f'leftover {bad} in real code'))
    # 3) standalone `app` in real code (excluding comments/strings/imports)
    #    compare against whether `app` still in electron import
    has_app_import = bool(re.search(r"import\s*\{[^}]*\bapp\b[^}]*\}\s*from\s*['\"]electron['\"]", t))
    real_app = re.findall(r'(?<![\w.])app(?![\w])', clean)
    if real_app and not has_app_import:
        problems.append((rel, f'uses app in code but import removed ({len(real_app)} hits)'))

if problems:
    print("PROBLEMS FOUND:")
    for r, m in problems:
        print(f"  ! {r}: {m}")
else:
    print("OK: all 33 files -> getHost imported, no leftover app.* calls, no dangling app refs")
print(f"\nChecked {len(changed)} files.")

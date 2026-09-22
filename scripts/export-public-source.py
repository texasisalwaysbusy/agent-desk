"""Create a curated source snapshot; never initialize Git or upload anything."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
from datetime import datetime, timezone
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
roots = {"web", "server", "shared", "cli", "inject", "scripts", "test", "skills", "plugins", "licenses", "src-tauri"}
top = {"package.json", "package-lock.json", "README.md", "README.zh-CN.md", "AGENTS.md", "LICENSE", "NOTICE", "PRIVACY.md", ".gitignore"}
docs = {"docs/architecture.md", "docs/product-identity.md", "docs/publishing.md", "docs/licensing.md"}
exclude_parts = {"node_modules", "target", "resources", "binaries", "gen", ".git", ".agents", ".codex", ".hermes", "__pycache__", ".venv", ".data", "logs"}
paths = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root).decode().split("\0")
selected = []
for name in sorted(set(paths)):
    if not name: continue
    p = Path(name)
    if not (p.parts[0] in roots or name in top or name in docs or name == ".github/workflows/check.yml"): continue
    if any(part in exclude_parts for part in p.parts): continue
    source = root / p
    if not source.exists(): continue  # deleted upstream files are not exported
    if source.is_symlink() or not source.is_file(): raise RuntimeError("Unsupported source type: " + name)
    if source.stat().st_size > 50 * 1024 * 1024: raise RuntimeError("Oversized source: " + name)
    if p.suffix.lower() in {".db", ".sqlite", ".sqlite3", ".log", ".pem", ".key", ".exe", ".zip"} or p.name.startswith(".env"):
        raise RuntimeError("Sensitive or generated filename: " + name)
    selected.append((name, source))
# Emit filenames and rule names only, never suspected secret contents.
patterns = {
    "private-key": rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "credential-token": rb"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{40,})",
    "machine-private-path": rb"(?:[A-Z]:[/\\]Workplace[/\\]|" + re.escape(str(Path.home()).encode()) + rb"|" + re.escape(Path.home().as_posix().encode()) + rb")",
}
findings = []
for name, source in selected:
    content = source.read_bytes()
    if b"\0" in content: continue
    for rule, pattern in patterns.items():
        if re.search(pattern, content): findings.append({"file": name, "rule": rule})
if findings: raise RuntimeError(json.dumps(findings, ensure_ascii=False))
stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
out = root / "dist" / "public-source" / ("agent-desk-" + stamp)
out.mkdir(parents=True, exist_ok=False)
manifest = []
for name, source in selected:
    destination = out / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    manifest.append({"path": name, "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()})
(out / "SOURCE-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
with ZipFile(out.with_suffix(".zip"), "w", ZIP_DEFLATED) as archive:
    for p in sorted(out.rglob("*")):
        if p.is_file(): archive.write(p, "agent-desk/" + p.relative_to(out).as_posix())
print(json.dumps({"directory": str(out), "archive": str(out.with_suffix(".zip")), "files": len(manifest)}, ensure_ascii=False))

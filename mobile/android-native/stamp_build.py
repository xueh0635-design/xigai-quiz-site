#!/usr/bin/env python3
"""Bind a release build to a clean commit and the complete committed Web bundle."""

import argparse
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from release_artifacts import ArtifactError, git_web_bundle, verify_web_directory


ROOT = Path(__file__).resolve().parents[2]
OVERLAY = "mobile/android-native/app/"


def git(*arguments):
    return subprocess.run(["git", *arguments], cwd=ROOT, check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30).stdout


def stamp(project, output, code, version, commit=None):
    head = git("rev-parse", "HEAD").decode().strip()
    if commit is not None and commit != head:
        raise ArtifactError("构建提交与当前检出的 Git SHA 不一致。")
    if git("status", "--porcelain", "--untracked-files=no").strip():
        raise ArtifactError("正式构建需要干净的已提交源码；请先提交并通过验证。")
    bundle = git_web_bundle(head, lambda spec: git("show", spec))
    verify_web_directory(bundle, project / "src/main/assets/public")
    sources = git("ls-tree", "-r", "--name-only", head, "--", OVERLAY).decode().splitlines()
    if not sources:
        raise ArtifactError("提交缺少 Android 原生覆盖层。")
    for source in sources:
        target = project / source[len(OVERLAY):]
        if target.is_symlink() or not target.is_file() or target.read_bytes() != git("show", f"{head}:{source}"):
            raise ArtifactError(f"Android 工程与提交不一致，请重新生成工程：{source}")
    expected_code = {source[len(OVERLAY):] for source in sources if source.startswith(OVERLAY + "src/main/java/")}
    actual_code = {path.relative_to(project).as_posix() for path in (project / "src/main/java").rglob("*") if path.is_file()}
    if actual_code != expected_code or (project / "src/main/kotlin").exists() or (project / "src/release").exists():
        raise ArtifactError("Android 工程含有清单之外的原生源码，请重新生成工程。")
    output.mkdir(parents=True, exist_ok=True)
    provenance = {"schemaVersion": 1, "sourceCommit": head,
                  "webManifestSha256": bundle.manifest_sha256,
                  "catalogVersion": bundle.manifest["catalogVersion"],
                  "versionCode": code, "versionName": version}
    (output / "quiz-release-provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--version-code", required=True, type=int)
    parser.add_argument("--version-name", required=True)
    parser.add_argument("--commit")
    args = parser.parse_args()
    try:
        stamp(args.project.resolve(), args.output.resolve(), args.version_code, args.version_name, args.commit)
    except (ArtifactError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()

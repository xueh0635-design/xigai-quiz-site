#!/usr/bin/env python3
"""Publish a signed Android APK and announce it to installations of the quiz."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
from shutil import copyfile
import subprocess
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from release_artifacts import ArtifactError, git_web_bundle, verify_apk_web, verify_same_apk_payload


ROOT = Path(__file__).resolve().parents[2]
REPO = "xueh0635-design/xigai-quiz-site"
MANIFEST = "docs/android-update.json"
PACKAGE = "io.github.xueh0635.xigai"
ASSET = "xigai-quiz-android.apk"
CI_APK = "app-release-unsigned.apk"
RELEASE_GATE = "release-gate"
# Public certificate fingerprint shared by earlier installs and release APKs.
SIGNER = "224cf6da0371f5dccba807926d05220144b3ffe51bc461a1f7ee774050ea97b4"
AUTH_GIT = ("git", "-c", "http.version=HTTP/1.1", "-c", "credential.helper=", "-c",
            "credential.helper=!gh auth git-credential")


def run(*command, capture=False):
    return subprocess.run(command, cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def version_from_apk(apk, build_tools):
    info = run(build_tools / "aapt", "dump", "badging", apk, capture=True)
    package = re.search(r"^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", info)
    if not package or package[1] != PACKAGE or not re.fullmatch(r"\d{1,8}\.\d{1,8}\.\d{1,8}", package[3]):
        raise ValueError(f"需要 {PACKAGE} 的正式 APK，版本号格式为 X.Y.Z。")
    if "application-debuggable" in info:
        raise ValueError("需要 release 构建的 APK。")
    certs = run(build_tools / "apksigner", "verify", "--print-certs", apk, capture=True)
    found = re.findall(r"^Signer #\d+ certificate SHA-256 digest: (\w+)$", certs, re.MULTILINE)
    if found != [SIGNER]:
        raise ValueError("APK 签名与已安装的版本不匹配。")
    return int(package[2]), package[3]


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git_blob(spec):
    return subprocess.run(["git", "show", spec], cwd=ROOT, check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30).stdout


def release_gate(commit):
    endpoint = f"repos/{REPO}/commits/{commit}/check-runs?check_name={RELEASE_GATE}&filter=latest&per_page=100"
    response = json.loads(run("gh", "api", endpoint, capture=True))
    checks = [check for check in response.get("check_runs", [])
              if check.get("name") == RELEASE_GATE and check.get("head_sha") == commit
              and check.get("app", {}).get("slug") == "github-actions"]
    if not checks:
        raise ValueError(f"提交 {commit[:12]} 尚无 {RELEASE_GATE} 检查；请先完成 CI。")
    latest = max(checks, key=lambda check: check.get("id", 0))
    if latest.get("status") != "completed" or latest.get("conclusion") != "success":
        raise ValueError(f"提交 {commit[:12]} 的 {RELEASE_GATE} 尚未通过，不能发布。")
    match = re.fullmatch(rf"https://github\.com/{re.escape(REPO)}/actions/runs/(\d+)(?:/job/\d+)?", latest.get("details_url", ""))
    if not match:
        raise ValueError("无法核对通过检查的 GitHub Actions 运行记录。")
    return {"checkRunId": latest["id"], "workflowRunId": int(match[1]), "checkUrl": latest["details_url"]}


def verify_ci_artifact(apk, commit, gate):
    with TemporaryDirectory(prefix="quiz-ci-artifact-") as directory:
        run("gh", "run", "download", str(gate["workflowRunId"]), "--repo", REPO,
            "--name", f"android-release-{commit}", "--dir", directory)
        unsigned = Path(directory) / CI_APK
        if not unsigned.is_file():
            raise ValueError("CI 未提供正式 APK 制品，请重新运行完整检查。")
        verify_same_apk_payload(apk, unsigned)


def enqueue_configured_iphone(apk):
    if sys.platform != "darwin":
        return
    updater = ROOT / "mobile/ios-native/push_release.py"
    try:
        subprocess.run([sys.executable, updater, "--enqueue", "--apk", apk], cwd=ROOT, check=True)
    except (OSError, subprocess.SubprocessError):
        print("安卓已发布，Mac 未能保存 iPhone 待安装记录。", file=sys.stderr)


def publish(apk, notes, build_tools):
    code, version = version_from_apk(apk, build_tools)
    tag = f"android-v{version}"
    metadata = {"versionCode": code, "versionName": version, "releaseTag": tag}
    manifest = ROOT / MANIFEST
    previous = json.loads(manifest.read_text()) if manifest.exists() else None
    if previous and (code < previous["versionCode"] or (code == previous["versionCode"] and previous != metadata)):
        raise ValueError("versionCode 必须高于已发布版本。")

    if run("git", "branch", "--show-current", capture=True).strip() != "main":
        raise ValueError("请切换到发布仓库的 main 分支。")
    changed = run("git", "diff", "HEAD", "--name-only", capture=True).splitlines()
    if any(path != MANIFEST for path in changed) or (changed and metadata != previous):
        raise ValueError("发布需要干净的源码；只允许重试相同版本的更新公告。")
    run(*AUTH_GIT, "fetch", "origin", "main")
    target = run("git", "rev-parse", "origin/main", capture=True).strip()
    head = run("git", "rev-parse", "HEAD", capture=True).strip()
    if head != target:
        # Recover a previous attempt whose announcement commit was not pushed.
        parent = run("git", "rev-parse", "HEAD^", capture=True).strip()
        changes = run("git", "diff", "--name-only", target, head, capture=True).splitlines()
        if parent != target or changes != [MANIFEST] or metadata != previous:
            raise ValueError("请先同步 main，再发布当前版本。")

    remote = subprocess.run(["gh", "release", "view", tag, "--repo", REPO, "--json", "isDraft,isPrerelease,assets"],
                            cwd=ROOT, text=True, capture_output=True)
    if remote.returncode == 0:
        release = json.loads(remote.stdout)
        if release["isDraft"] or release["isPrerelease"]:
            raise ValueError("同名发布仍是草稿或预发布，需要先完成正式发布。")
        # A retry keeps the original tag's source, even after its announcement commit.
        run(*AUTH_GIT, "fetch", "--no-tags", "origin", f"refs/tags/{tag}")
        source = run("git", "rev-parse", "FETCH_HEAD^{commit}", capture=True).strip()
    elif "release not found" in remote.stderr.lower():
        source = target
    else:
        raise RuntimeError(remote.stderr.strip() or "无法读取 GitHub Release。")

    bundle = git_web_bundle(source, git_blob)
    provenance = verify_apk_web(apk, bundle, source, code=code, version=version)
    gate = release_gate(source)
    verify_ci_artifact(apk, source, gate)

    if remote.returncode == 0:
        with TemporaryDirectory() as directory:
            run("gh", "release", "download", tag, "--repo", REPO, "--pattern", ASSET, "--dir", directory)
            if digest(apk) != digest(Path(directory) / ASSET):
                raise ValueError("同版本已发布不同 APK，请提高版本号。")
    else:
        with TemporaryDirectory() as directory:
            asset = Path(directory) / ASSET
            copyfile(apk, asset)
            receipt = Path(directory) / "xigai-quiz-build.json"
            receipt.write_text(json.dumps({**provenance, "apkSha256": digest(apk), **gate},
                                          ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            run("gh", "release", "create", tag, asset, receipt, "--repo", REPO, "--target", source,
                "--title", f"习概题库 Android {version}", "--notes-file", notes, "--latest")

    if metadata != previous:
        manifest.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    if run("git", "status", "--porcelain", "--", MANIFEST, capture=True).strip():
        run("git", "add", "--", MANIFEST)
        run("git", "commit", "--only", "-m", f"Announce Android {version}", "--", MANIFEST)
    run(*AUTH_GIT, "push", "origin", "HEAD:main")
    print(f"https://github.com/{REPO}/releases/tag/{tag}", flush=True)
    enqueue_configured_iphone(apk)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("notes", type=Path)
    sdk = Path(os.environ.get("ANDROID_HOME", Path.home() / "Library/Android/sdk"))
    parser.add_argument("--build-tools", type=Path, default=sdk / "build-tools/36.0.0")
    args = parser.parse_args()
    try:
        publish(args.apk.resolve(strict=True), args.notes.resolve(strict=True), args.build_tools.expanduser().resolve())
    except (ArtifactError, OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()

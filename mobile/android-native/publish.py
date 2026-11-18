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
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[2]
REPO = "xueh0635-design/xigai-quiz-site"
MANIFEST = "docs/android-update.json"
PACKAGE = "io.github.xueh0635.xigai"
ASSET = "xigai-quiz-android.apk"
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
        with TemporaryDirectory() as directory:
            run("gh", "release", "download", tag, "--repo", REPO, "--pattern", ASSET, "--dir", directory)
            if digest(apk) != digest(Path(directory) / ASSET):
                raise ValueError("同版本已发布不同 APK，请提高版本号。")
    elif "release not found" in remote.stderr.lower():
        with TemporaryDirectory() as directory:
            asset = Path(directory) / ASSET
            copyfile(apk, asset)
            run("gh", "release", "create", tag, asset, "--repo", REPO, "--target", target,
                "--title", f"习概题库 Android {version}", "--notes-file", notes, "--latest")
    else:
        raise RuntimeError(remote.stderr.strip() or "无法读取 GitHub Release。")

    if metadata != previous:
        manifest.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    if run("git", "status", "--porcelain", "--", MANIFEST, capture=True).strip():
        run("git", "add", "--", MANIFEST)
        run("git", "commit", "--only", "-m", f"Announce Android {version}", "--", MANIFEST)
    run(*AUTH_GIT, "push", "origin", "HEAD:main")
    print(f"https://github.com/{REPO}/releases/tag/{tag}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("notes", type=Path)
    sdk = Path(os.environ.get("ANDROID_HOME", Path.home() / "Library/Android/sdk"))
    parser.add_argument("--build-tools", type=Path, default=sdk / "build-tools/36.0.0")
    args = parser.parse_args()
    try:
        publish(args.apk.resolve(strict=True), args.notes.resolve(strict=True), args.build_tools.expanduser().resolve())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()

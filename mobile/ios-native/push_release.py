#!/usr/bin/env python3
"""Queue and install matching iPhone builds for published Android releases."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
from io import BytesIO
import json
from pathlib import Path
import plistlib
import re
from shutil import rmtree
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from release_artifacts import WEB_MANIFEST, git_web_bundle, read_web_bundle, sha256, verify_apk_web, verify_web_directory
from release_queue import ReleaseQueue, apk_digest, descriptor


ROOT = Path(__file__).resolve().parents[2]
LOCAL = Path.home() / "Library/Application Support/Xigai Quiz"
REPO = "xueh0635-design/xigai-quiz-site"
BUNDLE = "io.github.xueh0635.xigai"
ASSET = "xigai-quiz-android.apk"
# Existing releases through 1.1.51 predate Web manifests and the CI artifact gate.
LEGACY_MAX_VERSION_CODE = 53
IOS_SOURCES = (
    "mobile/package.json",
    "mobile/package-lock.json",
    "mobile/capacitor.config.json",
    "mobile/art/app-icon.png",
    "mobile/ios-native",
)
AUTH_GIT = ("git", "-c", "http.version=HTTP/1.1", "-c", "credential.helper=", "-c",
            "credential.helper=!gh auth git-credential")


class UpdatePending(Exception):
    """The Android publication succeeded, but the iPhone install needs a retry."""


class PhoneUnavailable(UpdatePending):
    """Wait for the configured phone or running installer without logging each poll."""


def shell(*command, cwd=ROOT, log=None, timeout=300):
    return subprocess.run(command, cwd=cwd, check=True, timeout=timeout,
                          stdout=log or subprocess.PIPE, stderr=log or subprocess.PIPE).stdout


def release():
    return descriptor(json.loads((ROOT / "docs/android-update.json").read_text()))


def device_report(working, filename, device, operation, action, *options, timeout=15):
    report = working / filename
    try:
        shell("xcrun", "devicectl", "device", operation, action, "--device", device, *options,
              "--quiet", "--timeout", str(timeout), "--json-output", report, timeout=timeout + 5)
        result = json.loads(report.read_text())
        if result.get("info", {}).get("outcome") != "success":
            raise UpdatePending("iPhone 未完成安装或读取。")
        return result["result"]
    except (OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
        raise UpdatePending("iPhone 未完成连接或安装。请确认解锁和网络连接后重试。") from error


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,2}", value):
        raise UpdatePending("无法核对 iPhone 上的版本。")
    components = tuple(map(int, value.split(".")))
    return components + (0,) * (3 - len(components))


def check_installed(app, code, name, *, force=True):
    installed_code = version_tuple(app["bundleVersion"])
    installed_name = version_tuple(app["version"])
    target_code, target_name = (code, 0, 0), version_tuple(name)
    if installed_code > target_code or installed_name > target_name:
        if not force:
            return True
        raise UpdatePending("iPhone 已安装更高版本，保留现有版本。")
    if installed_code == target_code and installed_name != target_name:
        raise UpdatePending("iPhone 已安装版本的构建号冲突，保留现有版本。")
    return not force and (installed_code, installed_name) == (target_code, target_name)


def require_unlocked(working, device, filename):
    try:
        state = device_report(working, filename, device, "info", "lockState", timeout=7)
    except UpdatePending as error:
        raise PhoneUnavailable("iPhone 暂未连接，Mac 会自动重试待安装版本。") from error
    if state.get("passcodeRequired") is not False or state.get("unlockedSinceBoot") is False:
        raise PhoneUnavailable("iPhone 暂未解锁，Mac 会自动重试待安装版本。")


def read_installed(working, device, filename):
    result = device_report(working, filename, device, "info", "apps", "--bundle-id", BUNDLE)
    apps = result.get("apps", [])
    if len(apps) != 1 or apps[0].get("bundleIdentifier") != BUNDLE or not apps[0].get("builtByDeveloper"):
        raise UpdatePending("这台 iPhone 尚无可覆盖的习概题库开发版。")
    return apps[0]


def committed_web_bundle(commit, code):
    present = shell("git", "ls-tree", "--name-only", commit, "--", f"docs/{WEB_MANIFEST}").strip()
    if present:
        # A malformed or incomplete existing manifest must never select legacy mode.
        return git_web_bundle(commit, lambda spec: shell("git", "show", spec)), False
    if code > LEGACY_MAX_VERSION_CODE:
        raise UpdatePending("此发布缺少完整 Web 制品清单，不能构建 iPhone 版本。")
    html = shell("git", "show", f"{commit}:docs/index.html")
    manifest = json.dumps({"schemaVersion": 1, "catalogVersion": f"legacy-{commit}",
                           "files": {"index.html": sha256(html)}}, sort_keys=True).encode()
    return read_web_bundle({WEB_MANIFEST: manifest, "index.html": html}.__getitem__), True


def prepare_mobile(working, source_ref, apk, log, code, name):
    bundle, legacy = committed_web_bundle(source_ref, code)
    if legacy:
        with ZipFile(apk) as published:
            if published.read("assets/public/index.html") != bundle.files["index.html"]:
                raise UpdatePending("历史 APK 内的页面与发布标签不一致，保留 iPhone 现有版本。")
        print("兼容历史发布：已核对原有单文件页面。新版本使用完整 Web 清单与 CI 制品核验。")
    else:
        verify_apk_web(apk, bundle, source_ref, code=code, version=name)
    archive = shell("git", "archive", "--format=zip", source_ref, *IOS_SOURCES)
    with ZipFile(BytesIO(archive)) as sources:
        sources.extractall(working)
    mobile = working / "mobile"
    web = mobile / "www"
    bundle.write(web)
    shell("npm", "ci", "--prefer-offline", "--no-audit", "--no-fund", cwd=mobile, log=log)
    shell("npx", "--no-install", "cap", "add", "ios", cwd=mobile, log=log)
    shell("node", "ios-native/install.cjs", cwd=mobile, log=log)
    project = mobile / "ios/App"
    info_file = project / "App/Info.plist"
    info = plistlib.loads(info_file.read_bytes())
    info["QuizSourceCommit"] = source_ref
    info["QuizWebManifestSha256"] = bundle.manifest_sha256
    info_file.write_bytes(plistlib.dumps(info))
    return project / "App.xcodeproj", bundle


def verify_app(app, bundle, commit, device, team, code, name):
    info = plistlib.loads((app / "Info.plist").read_bytes())
    if (info["CFBundleIdentifier"], info["CFBundleShortVersionString"], info["CFBundleVersion"]) != (
        BUNDLE, name, str(code)
    ):
        raise UpdatePending("iOS 构建的应用标识或版本与发布版不一致。")
    if (info.get("QuizSourceCommit") != commit
            or info.get("QuizWebManifestSha256") != bundle.manifest_sha256):
        raise UpdatePending("iOS 构建来源与发布提交或 Web 清单不一致。")
    verify_web_directory(bundle, app / "public")
    shell("codesign", "--verify", "--deep", "--strict", app, timeout=30)
    profile = plistlib.loads(shell("security", "cms", "-D", "-i", app / "embedded.mobileprovision"))
    entitlements = profile["Entitlements"]
    if (profile.get("TeamIdentifier") != [team]
            or entitlements.get("application-identifier") != f"{team}.{BUNDLE}"
            or not entitlements.get("get-task-allow")
            or device.upper() not in {value.upper() for value in profile.get("ProvisionedDevices", [])}
            or profile["ExpirationDate"].replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc)):
        raise UpdatePending("iOS 开发签名与本机配置的团队或这台 iPhone 不匹配。")


@contextmanager
def serialized():
    with (LOCAL / "iphone-release.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise PhoneUnavailable("Mac 上已有一个 iPhone 更新在运行。") from error
        yield


def discard_prepared(cache):
    if cache.exists():
        rmtree(cache)


def prepared_commit(cache, target):
    if not cache.exists():
        return None
    try:
        metadata = json.loads((cache / "release.json").read_text())
        commit = metadata["commit"]
        if metadata["release"] == target and re.fullmatch(r"[0-9a-f]{40}", commit):
            return commit
    except (OSError, KeyError, TypeError, ValueError):
        pass
    discard_prepared(cache)
    return None


def save_prepared(cache, working, app, target, commit):
    prepared = working / "prepared"
    prepared.mkdir(mode=0o700)
    (prepared / "release.json").write_text(json.dumps({"release": target, "commit": commit}) + "\n")
    app.rename(prepared / "App.app")
    discard_prepared(cache)
    prepared.rename(cache)
    return cache / "App.app"


def tag_commit(tag):
    return shell("git", "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}").decode().strip()


def build_app(working, apk, target, device, team, packages):
    packages.mkdir(parents=True, exist_ok=True)
    code, name, tag = (target[k] for k in ("versionCode", "versionName", "releaseTag"))
    source_ref = f"refs/tags/{tag}"
    shell(*AUTH_GIT, "fetch", "--no-tags", "origin", f"{source_ref}:{source_ref}", timeout=60)
    # Build from the fetched tag's exact commit even if another process fetches refs.
    commit = tag_commit(tag)
    if apk is None:
        shell("gh", "release", "download", tag, "--repo", REPO,
              "--pattern", ASSET, "--dir", working, timeout=60)
        apk = working / ASSET
    if "apkSha256" in target and apk_digest(apk) != target["apkSha256"]:
        raise UpdatePending("发布包摘要与待安装版本不一致。")
    with (LOCAL / "iphone-release.log").open("wb") as log:
        project, bundle = prepare_mobile(working, commit, apk, log, code, name)
        derived = working / "DerivedData"
        shell("xcodebuild", "-project", project, "-scheme", "App", "-configuration", "Debug",
              "-destination", f"platform=iOS,id={device}", "-derivedDataPath", derived,
              "-clonedSourcePackagesDirPath", packages, f"DEVELOPMENT_TEAM={team}",
              f"MARKETING_VERSION={name}", f"CURRENT_PROJECT_VERSION={code}",
              "CODE_SIGN_STYLE=Automatic", "-allowProvisioningUpdates",
              "-allowProvisioningDeviceRegistration", "build", log=log, timeout=900)
    app = derived / "Build/Products/Debug-iphoneos/App.app"
    verify_app(app, bundle, commit, device, team, code, name)
    return app, commit


def install(config, apk, target, *, force, current):
    device, team = config["device"], config["team"]
    if not re.fullmatch(r"(?:[a-fA-F0-9]{8}-[a-fA-F0-9]{16}|[a-fA-F0-9]{40})", device):
        raise ValueError("本机 iPhone 更新配置中的设备标识格式有误。")
    if not re.fullmatch(r"[A-Z0-9]{10}", team):
        raise ValueError("本机 iPhone 更新配置中的签名团队格式有误。")
    code, name, tag = (target[k] for k in ("versionCode", "versionName", "releaseTag"))
    packages = Path(config.get("sourcePackages", str(LOCAL / "SourcePackages"))).expanduser()
    cache = LOCAL / "prepared-iphone-release"
    with serialized(), TemporaryDirectory(prefix="build-", dir=LOCAL) as directory:
        working = Path(directory)
        if not current():
            return False
        commit = None if force else prepared_commit(cache, target)
        require_unlocked(working, device, "lock-before.json")
        before = read_installed(working, device, "before.json")
        if check_installed(before, code, name, force=force):
            discard_prepared(cache)
            print(f"iPhone 已是 {before['version']}（构建 {before['bundleVersion']}）。")
            return True
        app = None
        if commit:
            try:
                if tag_commit(tag) != commit:
                    raise UpdatePending("暂存的构建与已发布的代码不一致。")
                candidate = cache / "App.app"
                bundle, _ = committed_web_bundle(commit, code)
                verify_app(candidate, bundle, commit, device, team, code, name)
                app = candidate
            except (KeyError, OSError, TypeError, ValueError, plistlib.InvalidFileException,
                    subprocess.SubprocessError, UpdatePending):
                discard_prepared(cache)
        if app is None:
            app, commit = build_app(working, apk, target, device, team, packages)
            if not current():
                return False
            if not force:
                # Keep a verified app to install at the next unlock if the build outlasts this one.
                app = save_prepared(cache, working, app, target, commit)
        require_unlocked(working, device, "lock-pre-install.json")
        if check_installed(read_installed(working, device, "pre-install.json"), code, name, force=force):
            discard_prepared(cache)
            return True
        if not current():
            return False
        device_report(working, "install.json", device, "install", "app", app, timeout=90)
        installed = read_installed(working, device, "after.json")
        if (installed["version"], installed["bundleVersion"]) != (name, str(code)):
            raise UpdatePending("安装后读回的 iPhone 版本与发布版不一致。")
        if not force:
            discard_prepared(cache)
    print(f"iPhone 已覆盖安装 {name}（构建 {code}）。")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--enqueue", action="store_true", help="记录刚发布的安卓版供 Mac 自动补装")
    modes.add_argument("--drain", action="store_true", help="尝试安装 Mac 已记录的最新版")
    args = parser.parse_args()
    if args.enqueue and args.apk is None:
        parser.error("--enqueue 需要发布 APK 的 --apk 路径")
    if args.drain and args.apk is not None:
        parser.error("--drain 使用已记录的发布版，无需 --apk")
    config_path = LOCAL / "iphone-release.json"
    if sys.platform != "darwin" or not config_path.is_file():
        if args.apk is None and not args.drain:
            print(f"请先配置 Mac 上的 iPhone 更新文件 {config_path}。", file=sys.stderr)
            return 1
        return 0
    queue = ReleaseQueue(LOCAL)
    try:
        if args.enqueue:
            target = {**release(), "apkSha256": apk_digest(args.apk)}
            if queue.enqueue(target):
                print(f"Mac 已记录 iPhone 待安装版本 {target['versionName']}（构建 {target['versionCode']}）。")
            return 0
        if args.drain:
            target = queue.pending()
            if target is None:
                return 0
            current = lambda: queue.pending() == target
        else:
            target = release()

            def current():
                pending = queue.pending()
                return pending is None or pending["versionCode"] <= target["versionCode"]

        config = json.loads(config_path.read_text())
        finished = install(config, args.apk, target, force=not args.drain, current=current)
        if args.drain:
            if finished:
                queue.complete(target)
        elif not finished:
            raise UpdatePending("Mac 已记录更新的发布版，会自动安装该版本。")
    except PhoneUnavailable as error:
        if args.drain:
            return 0
        print(str(error), file=sys.stderr)
        return 1
    except (BadZipFile, KeyError, OSError, TypeError, ValueError, subprocess.SubprocessError, UpdatePending) as error:
        reason = str(error) if isinstance(error, UpdatePending) else "无法完成 iPhone 发布版构建或签名。"
        print(f"iPhone 更新待完成。{reason}", file=sys.stderr)
        if not args.enqueue:
            print(f"Mac 构建日志位于 {LOCAL / 'iphone-release.log'}。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

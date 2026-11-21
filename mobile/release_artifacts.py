"""Exact Web and APK payload checks shared by Android and iPhone delivery.

This module performs no network requests, signing or installation. Callers supply
the bytes from a fixed Git commit and keep those bytes through their build.
"""

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from zipfile import BadZipFile, ZipFile


WEB_MANIFEST = "web-manifest.json"
PROVENANCE = "assets/quiz-release-provenance.json"
SHA256 = re.compile(r"[0-9a-f]{64}")
COMMIT = re.compile(r"[0-9a-f]{40}")
SIGNATURE_ENTRY = re.compile(r"META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))", re.IGNORECASE)
# Capacitor adds these runtime shims when it copies the application bundle.
CAPACITOR_FILES = frozenset({"capacitor.js", "capacitor_plugins.js", "cordova.js", "cordova_plugins.js"})


class ArtifactError(ValueError):
    """A delivery artifact does not match its declared source."""


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def object_without_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ArtifactError(f"制品清单包含重复字段：{key}")
        result[key] = value
    return result


def parse_json(value):
    try:
        return json.loads(value, object_pairs_hook=object_without_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ArtifactError("制品清单不是有效 JSON。") from error


def relative_web_path(value):
    if (not isinstance(value, str) or not value or "\\" in value or "\x00" in value
            or value.startswith("/") or any(part in {"", ".", ".."} for part in value.split("/"))
            or PurePosixPath(value).as_posix() != value):
        raise ArtifactError("制品清单包含不安全的相对路径。")
    return value


@dataclass(frozen=True)
class WebBundle:
    manifest_bytes: bytes
    manifest: dict
    files: dict

    @property
    def manifest_sha256(self):
        return sha256(self.manifest_bytes)

    def write(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        if any(directory.iterdir()):
            raise ArtifactError("Web 构建目标目录必须为空。")
        for name, value in {**self.files, WEB_MANIFEST: self.manifest_bytes}.items():
            target = directory.joinpath(*PurePosixPath(name).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(value)


def read_web_bundle(read):
    """Read a committed bundle through read(relative_path) -> bytes."""
    manifest_bytes = read(WEB_MANIFEST)
    manifest = parse_json(manifest_bytes)
    if (not isinstance(manifest, dict) or type(manifest.get("schemaVersion")) is not int
            or manifest["schemaVersion"] != 1
            or not isinstance(manifest.get("catalogVersion"), str) or not manifest["catalogVersion"]):
        raise ArtifactError("不支持的 Web 制品清单版本。")
    declared = manifest.get("files")
    if not isinstance(declared, dict) or not declared or "index.html" not in declared:
        raise ArtifactError("Web 制品清单缺少 index.html。")
    files = {}
    for name, digest in declared.items():
        relative_web_path(name)
        if name in {WEB_MANIFEST, "android-update.json"} or not isinstance(digest, str) or not SHA256.fullmatch(digest):
            raise ArtifactError(f"Web 制品清单字段无效：{name}")
        value = read(name)
        if sha256(value) != digest:
            raise ArtifactError(f"Web 制品摘要不匹配：{name}")
        files[name] = value
    return WebBundle(manifest_bytes, manifest, files)


def git_web_bundle(commit, git_read):
    if not COMMIT.fullmatch(commit):
        raise ArtifactError("需要完整的 Git 提交 SHA。")
    return read_web_bundle(lambda name: git_read(f"{commit}:docs/{name}"))


def verify_web_files(bundle, read, names):
    expected = {**bundle.files, WEB_MANIFEST: bundle.manifest_bytes}
    for name, value in expected.items():
        try:
            actual = read(name)
        except (KeyError, FileNotFoundError) as error:
            raise ArtifactError(f"构建缺少 Web 文件：{name}") from error
        if actual != value:
            raise ArtifactError(f"构建内的 Web 文件与提交不一致：{name}")
    extras = set(names) - set(expected) - CAPACITOR_FILES
    if extras:
        raise ArtifactError(f"构建中有未列入清单的 Web 文件：{sorted(extras)[0]}")


def verify_web_directory(bundle, directory):
    directory = Path(directory)
    entries = list(directory.rglob("*"))
    if any(path.is_symlink() for path in entries):
        raise ArtifactError("Web 构建不能包含符号链接。")
    names = [path.relative_to(directory).as_posix() for path in entries if path.is_file()]
    verify_web_files(bundle, lambda name: (directory / name).read_bytes(), names)


def zip_entries(archive):
    names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
    if len(names) != len(set(names)):
        raise ArtifactError("APK 包含重复 ZIP 条目。")
    return names


def verify_apk_web(apk, bundle, commit, *, code=None, version=None):
    try:
        with ZipFile(apk) as archive:
            names = zip_entries(archive)
            prefix = "assets/public/"
            verify_web_files(bundle, lambda name: archive.read(prefix + name),
                             [name[len(prefix):] for name in names if name.startswith(prefix)])
            try:
                provenance = parse_json(archive.read(PROVENANCE))
            except KeyError as error:
                raise ArtifactError("APK 缺少构建来源记录，请签署本次通过检查的 CI 制品。") from error
            expected = {"schemaVersion": 1, "sourceCommit": commit,
                        "webManifestSha256": bundle.manifest_sha256,
                        "catalogVersion": bundle.manifest["catalogVersion"]}
            if not isinstance(provenance, dict) or any(provenance.get(key) != value for key, value in expected.items()):
                raise ArtifactError("APK 构建来源与发布提交或 Web 清单不一致。")
            if code is not None and (type(provenance.get("versionCode")) is not int or provenance["versionCode"] != code):
                raise ArtifactError("APK 构建来源中的版本号不一致。")
            if version is not None and provenance.get("versionName") != version:
                raise ArtifactError("APK 构建来源中的版本名称不一致。")
            return provenance
    except BadZipFile as error:
        raise ArtifactError("APK 不是有效 ZIP 制品。") from error


def verify_same_apk_payload(signed, unsigned):
    """Allow APK signing/zipalign to alter signatures, never application bytes."""
    try:
        with ZipFile(signed) as left, ZipFile(unsigned) as right:
            left_names = {name for name in zip_entries(left) if not SIGNATURE_ENTRY.fullmatch(name)}
            right_names = {name for name in zip_entries(right) if not SIGNATURE_ENTRY.fullmatch(name)}
            if left_names != right_names:
                raise ArtifactError("签名 APK 的文件集合与通过检查的 CI 制品不同。")
            for name in sorted(left_names):
                if left.read(name) != right.read(name):
                    raise ArtifactError(f"签名 APK 与通过检查的 CI 制品不同：{name}")
    except BadZipFile as error:
        raise ArtifactError("无法核对 APK 与 CI 制品。") from error

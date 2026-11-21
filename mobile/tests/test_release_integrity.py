"""Offline release tests. All publication/network calls are replaced with fixtures."""

from contextlib import ExitStack
from io import BytesIO
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import warnings
from zipfile import ZIP_DEFLATED, ZipFile

MOBILE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MOBILE))
sys.path.insert(0, str(MOBILE / "ios-native"))
from release_artifacts import (
    ArtifactError, PROVENANCE, WEB_MANIFEST, read_web_bundle, sha256,
    verify_apk_web, verify_same_apk_payload, verify_web_directory,
)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


publisher = load("quiz_publisher_test", MOBILE / "android-native/publish.py")
stamper = load("quiz_stamper_test", MOBILE / "android-native/stamp_build.py")
iphone = load("quiz_iphone_test", MOBILE / "ios-native/push_release.py")
COMMIT = "a" * 40
FILES = {"index.html": b'<script src="assets/app.js"></script>', "assets/app.js": b'console.log("fixture");'}
MANIFEST = json.dumps({"schemaVersion": 1, "catalogVersion": "fixture-v1",
                       "files": {name: sha256(value) for name, value in FILES.items()}}).encode()
BUNDLE_FILES = {**FILES, WEB_MANIFEST: MANIFEST}


def bundle():
    return read_web_bundle(BUNDLE_FILES.__getitem__)


def apk_payload(commit=COMMIT):
    provenance = {"schemaVersion": 1, "sourceCommit": commit, "webManifestSha256": sha256(MANIFEST),
                  "catalogVersion": "fixture-v1", "versionCode": 53, "versionName": "1.1.51"}
    return {**{"assets/public/" + name: value for name, value in BUNDLE_FILES.items()},
            PROVENANCE: json.dumps(provenance).encode(), "classes.dex": b"fixture native code"}


def write_zip(path, entries, *, signature=False, compress=False):
    with ZipFile(path, "w", compression=ZIP_DEFLATED if compress else 0) as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
        if signature:
            archive.writestr("META-INF/MANIFEST.MF", b"signing metadata")
            archive.writestr("META-INF/QUIZ.SF", b"signature file")
            archive.writestr("META-INF/QUIZ.RSA", b"signature certificate")


def successful_gate(check_id=7, commit=COMMIT):
    return {"id": check_id, "name": "release-gate", "head_sha": commit,
            "status": "completed", "conclusion": "success", "app": {"slug": "github-actions"},
            "details_url": f"https://github.com/{publisher.REPO}/actions/runs/123/job/456"}


class WebIntegrityTests(unittest.TestCase):
    def test_complete_bundle_round_trip_and_asset_tampering(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "www"
            original = bundle()
            original.write(target)
            verify_web_directory(original, target)
            (target / "assets/app.js").write_bytes(b"stale asset")
            with self.assertRaisesRegex(ArtifactError, "assets/app.js"):
                verify_web_directory(original, target)

    def test_missing_and_unlisted_assets_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "www"
            original = bundle()
            original.write(target)
            extra = target / "old.js"
            extra.write_bytes(b"old script")
            with self.assertRaisesRegex(ArtifactError, "未列入"):
                verify_web_directory(original, target)
            extra.unlink()
            (target / "assets/app.js").unlink()
            with self.assertRaisesRegex(ArtifactError, "缺少"):
                verify_web_directory(original, target)

    def test_manifest_path_traversal_and_duplicate_keys_are_rejected(self):
        for bad in ("../escape.js", "/absolute.js", "assets/../escape.js", "assets\\escape.js", "./index.html"):
            raw = json.dumps({"schemaVersion": 1, "catalogVersion": "v1",
                              "files": {"index.html": sha256(b""), bad: sha256(b"")}}).encode()
            with self.subTest(path=bad), self.assertRaises(ArtifactError):
                read_web_bundle(lambda path: raw if path == WEB_MANIFEST else b"")
        duplicate = b'{"schemaVersion":1,"schemaVersion":2,"catalogVersion":"v1","files":{}}'
        with self.assertRaisesRegex(ArtifactError, "重复"):
            read_web_bundle(lambda _: duplicate)

    def test_manifest_checks_every_asset_digest(self):
        corrupted = {**BUNDLE_FILES, "assets/app.js": b"uncommitted code"}
        with self.assertRaisesRegex(ArtifactError, "摘要不匹配"):
            read_web_bundle(corrupted.__getitem__)

    def test_copy_refuses_to_overwrite_nonempty_destination(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            (target / "keep.txt").write_text("keep")
            with self.assertRaisesRegex(ArtifactError, "必须为空"):
                bundle().write(target)
            self.assertEqual((target / "keep.txt").read_text(), "keep")


class ApkIntegrityTests(unittest.TestCase):
    def test_web_and_provenance_must_match_exact_commit(self):
        with tempfile.TemporaryDirectory() as folder:
            apk = Path(folder) / "app.apk"
            write_zip(apk, apk_payload())
            verify_apk_web(apk, bundle(), COMMIT, code=53, version="1.1.51")
            with self.assertRaisesRegex(ArtifactError, "构建来源"):
                verify_apk_web(apk, bundle(), "b" * 40)
            with self.assertRaisesRegex(ArtifactError, "版本号"):
                verify_apk_web(apk, bundle(), COMMIT, code=54)
            write_zip(apk, {**apk_payload(), "assets/public/assets/app.js": b"different"})
            with self.assertRaisesRegex(ArtifactError, "assets/app.js"):
                verify_apk_web(apk, bundle(), COMMIT)

    def test_signing_and_zip_alignment_changes_preserve_accepted_payload(self):
        with tempfile.TemporaryDirectory() as folder:
            unsigned, signed = Path(folder) / "unsigned.apk", Path(folder) / "signed.apk"
            write_zip(unsigned, apk_payload())
            write_zip(signed, apk_payload(), signature=True, compress=True)
            verify_same_apk_payload(signed, unsigned)

    def test_native_code_change_is_rejected_even_when_web_matches(self):
        with tempfile.TemporaryDirectory() as folder:
            unsigned, signed = Path(folder) / "unsigned.apk", Path(folder) / "signed.apk"
            write_zip(unsigned, apk_payload())
            write_zip(signed, {**apk_payload(), "classes.dex": b"locally rebuilt native code"}, signature=True)
            with self.assertRaisesRegex(ArtifactError, "classes.dex"):
                verify_same_apk_payload(signed, unsigned)

    def test_duplicate_zip_entries_and_missing_provenance_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            apk = Path(folder) / "app.apk"
            payload = apk_payload()
            del payload[PROVENANCE]
            write_zip(apk, payload)
            with self.assertRaisesRegex(ArtifactError, "缺少构建来源"):
                verify_apk_web(apk, bundle(), COMMIT)
            write_zip(apk, apk_payload())
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with ZipFile(apk, "a") as archive:
                    archive.writestr("classes.dex", b"ambiguous native code")
            with self.assertRaisesRegex(ArtifactError, "重复 ZIP"):
                verify_apk_web(apk, bundle(), COMMIT)


class GateTests(unittest.TestCase):
    def test_only_a_successful_matching_github_actions_gate_is_accepted(self):
        with patch.object(publisher, "run", return_value=json.dumps({"check_runs": [successful_gate()]})):
            self.assertEqual(publisher.release_gate(COMMIT)["workflowRunId"], 123)
        for changed in ({"conclusion": "failure"}, {"status": "in_progress"},
                        {"head_sha": "b" * 40}, {"app": {"slug": "external-app"}},
                        {"details_url": "https://elsewhere.example/actions/runs/123"}):
            gate = {**successful_gate(), **changed}
            with self.subTest(change=changed), patch.object(publisher, "run", return_value=json.dumps({"check_runs": [gate]})):
                with self.assertRaises(ValueError):
                    publisher.release_gate(COMMIT)

    def test_new_failed_gate_cannot_reuse_old_success(self):
        gates = [successful_gate(), {**successful_gate(8), "conclusion": "failure"}]
        with patch.object(publisher, "run", return_value=json.dumps({"check_runs": gates})):
            with self.assertRaisesRegex(ValueError, "尚未通过"):
                publisher.release_gate(COMMIT)

    def test_absent_gate_is_not_treated_as_success(self):
        with patch.object(publisher, "run", return_value='{"check_runs":[]}'):
            with self.assertRaisesRegex(ValueError, "尚无"):
                publisher.release_gate(COMMIT)


class PublisherIntegrationTests(unittest.TestCase):
    def exercise(self, *, change_native=False, fail_gate=False):
        with tempfile.TemporaryDirectory() as folder, ExitStack() as mocks:
            root = Path(folder)
            (root / "docs").mkdir()
            (root / "docs/android-update.json").write_text(json.dumps({"versionCode": 52, "versionName": "1.1.50", "releaseTag": "android-v1.1.50"}))
            signed, unsigned, notes = root / "signed.apk", root / "unsigned.apk", root / "notes.md"
            notes.write_text("Fixture release")
            write_zip(unsigned, apk_payload())
            payload = apk_payload()
            if change_native:
                payload["classes.dex"] = b"different native code"
            write_zip(signed, payload, signature=True)
            calls = []

            def run(*command, capture=False):
                args = list(map(str, command))
                calls.append(args)
                if Path(args[0]).name == "aapt":
                    return "package: name='io.github.xueh0635.xigai' versionCode='53' versionName='1.1.51'\n"
                if Path(args[0]).name == "apksigner":
                    return f"Signer #1 certificate SHA-256 digest: {publisher.SIGNER}\n"
                if args[:3] == ["git", "branch", "--show-current"]:
                    return "main\n"
                if args[:2] == ["git", "diff"]:
                    return ""
                if args[:2] == ["git", "rev-parse"]:
                    return COMMIT + "\n"
                if args[:2] == ["gh", "api"]:
                    gate = successful_gate()
                    if fail_gate:
                        gate["conclusion"] = "failure"
                    return json.dumps({"check_runs": [gate]})
                if args[:3] == ["gh", "run", "download"]:
                    shutil.copyfile(unsigned, Path(args[args.index("--dir") + 1]) / publisher.CI_APK)
                    return ""
                if args[:3] == ["git", "status", "--porcelain"]:
                    return " M docs/android-update.json\n"
                if args[:2] in (["git", "add"], ["git", "commit"]) or args[:3] == ["gh", "release", "create"]:
                    return ""
                if args[0] == "git" and ("fetch" in args or "push" in args):
                    return ""
                raise AssertionError(f"Unexpected external command: {args}")

            mocks.enter_context(patch.object(publisher, "ROOT", root))
            mocks.enter_context(patch.object(publisher, "run", side_effect=run))
            mocks.enter_context(patch.object(publisher, "git_blob", side_effect=lambda spec: BUNDLE_FILES[spec.split(":docs/", 1)[1]]))
            mocks.enter_context(patch.object(publisher, "enqueue_configured_iphone"))
            mocks.enter_context(patch.object(publisher.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="release not found")))
            if change_native or fail_gate:
                with self.assertRaises(ValueError):
                    publisher.publish(signed, notes, root / "build-tools")
                self.assertFalse(any(args[:3] == ["gh", "release", "create"] for args in calls))
                self.assertEqual(json.loads((root / "docs/android-update.json").read_text())["versionCode"], 52)
            else:
                publisher.publish(signed, notes, root / "build-tools")
                creates = [args for args in calls if args[:3] == ["gh", "release", "create"]]
                self.assertEqual(len(creates), 1)
                self.assertIn(COMMIT, creates[0])
                self.assertEqual(json.loads((root / "docs/android-update.json").read_text())["versionCode"], 53)

    def test_publish_uses_exact_successful_ci_payload(self):
        self.exercise()

    def test_rebuilt_native_apk_is_stopped_before_publication(self):
        self.exercise(change_native=True)

    def test_failed_gate_is_stopped_before_publication(self):
        self.exercise(fail_gate=True)


class IPhoneBundleTests(unittest.TestCase):
    def test_preparation_copies_every_manifest_file_and_records_source(self):
        with tempfile.TemporaryDirectory() as folder:
            working = Path(folder)
            apk = working / "source.apk"
            write_zip(apk, apk_payload())
            archive = BytesIO()
            with ZipFile(archive, "w") as files:
                files.writestr("mobile/package.json", "{}")

            def shell(*command, **kwargs):
                if command[:2] == ("git", "ls-tree"):
                    return b"docs/web-manifest.json\n"
                if command[:2] == ("git", "show"):
                    return BUNDLE_FILES[command[2].split(":docs/", 1)[1]]
                if command[:2] == ("git", "archive"):
                    return archive.getvalue()
                if command[:2] == ("node", "ios-native/install.cjs"):
                    info = working / "mobile/ios/App/App/Info.plist"
                    info.parent.mkdir(parents=True)
                    info.write_bytes(plistlib.dumps({"CFBundleIdentifier": iphone.BUNDLE}))
                    return b""
                if command[0] in {"npm", "npx"}:
                    return b""
                raise AssertionError(f"Unexpected external command: {command}")

            with patch.object(iphone, "shell", side_effect=shell):
                _, copied = iphone.prepare_mobile(working, COMMIT, apk, None, 53, "1.1.51")
            verify_web_directory(copied, working / "mobile/www")
            info = plistlib.loads((working / "mobile/ios/App/App/Info.plist").read_bytes())
            self.assertEqual(info["QuizSourceCommit"], COMMIT)
            self.assertEqual(info["QuizWebManifestSha256"], sha256(MANIFEST))

    def test_legacy_is_limited_to_existing_versions_without_a_manifest(self):
        def absent_manifest(*command, **kwargs):
            if command[:2] == ("git", "ls-tree"):
                return b""
            if command[:2] == ("git", "show") and command[2] == f"{COMMIT}:docs/index.html":
                return FILES["index.html"]
            raise AssertionError(command)

        with patch.object(iphone, "shell", side_effect=absent_manifest):
            old, legacy = iphone.committed_web_bundle(COMMIT, 53)
            self.assertTrue(legacy)
            self.assertEqual(old.files, {"index.html": FILES["index.html"]})
            with self.assertRaisesRegex(iphone.UpdatePending, "缺少完整"):
                iphone.committed_web_bundle(COMMIT, 54)

        def malformed_manifest(*command, **kwargs):
            if command[:2] == ("git", "ls-tree"):
                return b"docs/web-manifest.json\n"
            if command[:2] == ("git", "show") and command[2].endswith(WEB_MANIFEST):
                return b"broken manifest"
            raise AssertionError(command)

        with patch.object(iphone, "shell", side_effect=malformed_manifest), self.assertRaises(ArtifactError):
            iphone.committed_web_bundle(COMMIT, 53)


class BuildStampTests(unittest.TestCase):
    def test_clean_source_is_stamped_and_stale_native_overlay_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, value in BUNDLE_FILES.items():
                target = root / "docs" / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(value)
            overlay = root / "mobile/android-native/app"
            java = overlay / "src/main/java/quiz/Main.java"
            java.parent.mkdir(parents=True)
            java.write_text("class Main {}")
            (overlay / "build.gradle").write_text("// fixture build")
            for args in (("init", "-q"), ("config", "user.name", "Fixture"),
                         ("config", "user.email", "fixture@example.invalid"),
                         ("add", "."), ("commit", "-qm", "Fixture source")):
                subprocess.run(["git", *args], cwd=root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root).decode().strip()
            project = root / "mobile/android/app"
            shutil.copytree(overlay, project)
            bundle().write(project / "src/main/assets/public")
            output = root / "generated-assets"
            with patch.object(stamper, "ROOT", root):
                stamper.stamp(project, output, 53, "1.1.51", commit)
                self.assertEqual(json.loads((output / "quiz-release-provenance.json").read_text())["sourceCommit"], commit)
                (project / "src/main/java/quiz/Main.java").write_text("class Stale {}")
                with self.assertRaisesRegex(ArtifactError, "Android 工程与提交不一致"):
                    stamper.stamp(project, output, 53, "1.1.51", commit)
                java.write_text("class Uncommitted {}")
                with self.assertRaisesRegex(ArtifactError, "干净"):
                    stamper.stamp(project, output, 53, "1.1.51", commit)


if __name__ == "__main__":
    unittest.main()

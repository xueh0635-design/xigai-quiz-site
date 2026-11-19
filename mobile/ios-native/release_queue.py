"""Mac-local state for the latest paired iPhone release."""

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
import re
from tempfile import NamedTemporaryFile


def apk_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def descriptor(value, require_digest=False):
    if not isinstance(value, dict):
        raise ValueError("安卓版本清单格式有误。")
    code, name, tag = (value[key] for key in ("versionCode", "versionName", "releaseTag"))
    if type(code) is not int or code < 1 or not re.fullmatch(r"[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}", name):
        raise ValueError("安卓版本清单格式有误。")
    if tag != f"android-v{name}":
        raise ValueError("安卓版本号和发布标签不一致。")
    release = {"versionCode": code, "versionName": name, "releaseTag": tag}
    digest = value.get("apkSha256")
    if digest is not None or require_digest:
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("待安装版本的 APK 摘要格式有误。")
        release["apkSha256"] = digest
    return release


class ReleaseQueue:
    def __init__(self, local):
        self.local = local
        self.path = local / "iphone-release-queue.json"

    @contextmanager
    def state(self):
        self.local.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (self.local / "iphone-release-queue.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                raw = json.loads(self.path.read_text())
            except FileNotFoundError:
                raw = {}
            if not isinstance(raw, dict):
                raise ValueError("等待安装的版本队列格式有误。")
            yield {
                key: descriptor(raw[key], require_digest=True) if raw.get(key) is not None else None
                for key in ("pending", "completed")
            }

    def write(self, state):
        # The file is only replaced once the fully written snapshot is durable.
        with NamedTemporaryFile(mode="w", dir=self.local, prefix=".iphone-release-queue-", delete=False) as stream:
            temporary = stream.name
            try:
                json.dump(state, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
                os.replace(temporary, self.path)
                directory = os.open(self.local, os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)

    def enqueue(self, value):
        release = descriptor(value, require_digest=True)
        with self.state() as state:
            latest = state["pending"] or state["completed"]
            if latest and release["versionCode"] <= latest["versionCode"]:
                if release["versionCode"] == latest["versionCode"] and release != latest:
                    raise ValueError("相同的构建号已有不同的待安装记录。")
                return False
            state["pending"] = release
            self.write(state)
        return True

    def pending(self):
        with self.state() as state:
            return state["pending"]

    def complete(self, release):
        with self.state() as state:
            # A release enqueued during the install takes precedence.
            if state["pending"] == release:
                state["pending"] = None
                state["completed"] = release
                self.write(state)

#!/usr/bin/env python3
"""Register the iPhone release queue as a per-user macOS LaunchAgent."""

import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
from tempfile import NamedTemporaryFile


LABEL = "io.github.xueh0635.xigai.iphone-release-queue"
LOCAL = Path.home() / "Library/Application Support/Xigai Quiz"
WORKER = LOCAL / "release-repo"
AGENTS = Path.home() / "Library/LaunchAgents"


def register():
    updater = WORKER / "mobile/ios-native/push_release.py"
    if not updater.is_file() or not (LOCAL / "iphone-release.json").is_file():
        raise ValueError("请先配置本机 iPhone，并把发布仓库放到应用支持目录的 release-repo。")
    python = shutil.which("python3")
    if python is None:
        raise ValueError("Mac 上找不到 Python 3。")
    command_paths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    for tool in ("npm", "node", "gh"):
        command = shutil.which(tool)
        if command is None:
            raise ValueError(f"Mac 上找不到 {tool}。")
        command_paths.append(str(Path(command).parent))

    AGENTS.mkdir(mode=0o700, parents=True, exist_ok=True)
    file = AGENTS / f"{LABEL}.plist"
    domain = f"gui/{os.getuid()}"
    service = f"{domain}/{LABEL}"
    log = str(LOCAL / "iphone-queue-worker.log")
    configuration = {
        "Label": LABEL,
        "ProgramArguments": [python, str(updater), "--drain"],
        "WorkingDirectory": str(WORKER),
        "EnvironmentVariables": {
            "PATH": ":".join(dict.fromkeys(command_paths)),
            "PYTHONDONTWRITEBYTECODE": "1",
            "GIT_TERMINAL_PROMPT": "0",
        },
        "LimitLoadToSessionType": "Aqua",
        "RunAtLoad": True,
        "StartInterval": 20,
        "ProcessType": "Background",
        "StandardOutPath": log,
        "StandardErrorPath": log,
        "Umask": 0o077,
    }
    current = subprocess.run(["/bin/launchctl", "print", service], capture_output=True, text=True)
    if current.returncode == 0:
        if file.is_file() and plistlib.loads(file.read_bytes()) == configuration:
            print("iPhone 待更新队列已启用。")
            return
        if any(line.strip() == "state = running" for line in current.stdout.splitlines()):
            raise ValueError("iPhone 队列正在处理。处理完成后可重新注册。")
        subprocess.run(["/bin/launchctl", "bootout", service], check=True)

    with NamedTemporaryFile(dir=AGENTS, delete=False) as pending:
        temp = Path(pending.name)
        try:
            plistlib.dump(configuration, pending)
            pending.flush()
            os.replace(temp, file)
        finally:
            temp.unlink(missing_ok=True)
    subprocess.run(["/bin/launchctl", "bootstrap", domain, str(file)], check=True)
    print("iPhone 待更新队列已启用。")


if __name__ == "__main__":
    try:
        if sys.platform != "darwin":
            raise ValueError("此安装脚本适用于 macOS。")
        register()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        sys.exit(str(error))

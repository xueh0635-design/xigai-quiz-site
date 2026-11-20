#!/usr/bin/env bash
set -euo pipefail
adb install mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.github.xueh0635.xigai/.MainActivity
for attempt in {1..15}; do
  sleep 2
  adb shell uiautomator dump /sdcard/option-ui.xml >/dev/null || true
  adb exec-out cat /sdcard/option-ui.xml > android-option-ui.xml || true
  adb exec-out screencap -p > android-option-proof.png
  if rg -q 'XIGAI PASS' android-option-ui.xml; then
    echo 'Android emulator passed the long-press, selection, source and study-flow checks.'
    exit 0
  fi
  if rg -o 'XIGAI FAIL[^"]*' android-option-ui.xml; then exit 1; fi
done
exit 1

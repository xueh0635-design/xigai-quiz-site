#!/usr/bin/env bash
set -euo pipefail

adb install mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.github.xueh0635.xigai/.MainActivity
for attempt in {1..15}; do
  sleep 2
  adb shell uiautomator dump /sdcard/xigai-sync-ui.xml >/dev/null || true
  adb exec-out cat /sdcard/xigai-sync-ui.xml > android-sync-ui.xml || true
  adb exec-out screencap -p > android-sync-proof.png
  if grep -Fq 'XIGAI SYNC UI PASS' android-sync-ui.xml; then
    echo 'Android emulator verified exact synced answer options and resuming across devices.'
    exit 0
  fi
  if grep -Eo 'XIGAI SYNC UI FAIL[^"<]*' android-sync-ui.xml; then
    exit 1
  fi
done
exit 1

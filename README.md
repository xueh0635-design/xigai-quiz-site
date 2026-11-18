# 习概题库

[打开网页版](https://xueh0635-design.github.io/xigai-quiz-site/)。收录 1,221 道题。首页点章节即可开始练习，每轮优先练最多 20 道未答题。作答后显示完整答案、考点速记、解析和可定位的教材页码。部分题目提供同考点练习。自定义测验支持按范围、题型和顺序组卷。用邮箱和密码注册后，可在自己的多台设备同步学习进度。

`docs/index.html` 是可独立运行的发布文件。原始截图和教材保存在本机。

## 模拟器构建

在 `mobile` 中执行 `npm ci`，把 `docs/index.html` 复制到 `mobile/www/index.html`，再按目标平台执行 `npx cap add ios` 或 `npx cap add android`。已有平台目录时执行 `npx cap sync`。

iOS 工程生成后，从 `mobile` 执行 `node ios-native/install.cjs`，再用 Xcode 打开 `ios/App/App.xcodeproj`。iOS 26 及以上使用苹果系统的液态玻璃底栏和弹层。Android 工程生成后，从 `mobile` 执行 `node android-native/install.cjs`，再用 Android Studio 打开 `android`。

## 安卓更新

到 [GitHub Releases](https://github.com/xueh0635-design/xigai-quiz-site/releases/latest) 下载 `xigai-quiz-android.apk`。在应用里打开「我的 → 应用更新」可以检查新版并开启更新通知。开启后，系统约每两小时安排一次后台检查，实际时间依设备的联网和省电设置而定。通知会打开对应的 GitHub Release 页面。

发布后续版本时，先把源码和网页推送到 `main`。构建 APK 时提高 `quizVersionCode` 并设置 `quizVersionName`，例如在 `mobile/android` 执行 `./gradlew :app:assembleRelease -PquizVersionCode=3 -PquizVersionName=1.1.1`。用同一个 Android 签名密钥签署 release APK，从仓库根目录运行 `python3 mobile/android-native/publish.py 已签名.apk 发布说明.md`。脚本先校验签名和版本，再发布 APK 并更新客户端读取的版本清单。APK 与发布清单会通过同一 GitHub 仓库提供。

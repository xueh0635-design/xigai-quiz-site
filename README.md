# 习概题库

[打开网页版](https://xueh0635-design.github.io/xigai-quiz-site/)。收录 1,221 道题。首页点章节即可连续练完整章，可随时退出并续做。作答后显示完整答案、考点速记、解析和可定位的教材页码。部分题目提供同考点练习。自定义测验支持按范围、题型和顺序组卷。用邮箱和密码注册后，可在自己的多台设备同步学习进度。

`docs/index.html` 是可独立运行的发布文件。原始截图和教材保存在本机。

答题页全屏支持右滑回上一题、左滑到下一题，也可以点翻题按钮。在本章内可回看已提交的作答、判分和解析，未提交的选项和填空会保留。

首页和同桌营地可拖动 3D 视角，外观支持晨雾、日间、暮色、夜间和随时间切换。

在「一起学」邀请同桌开一场实时双塔擂台。发起方选择题目数量，同桌应战前能看到题量和限时。答对积攒能量，可打出护阵、破阵、回炉和蓄势，连击触发暴击。首次达成卡牌收藏条件后，可以在集卡册打开原创插画。场内支持快捷消息和双方自愿加入的点对点语音。新对局统一实时开始，已提交的旧试卷在「旧场次记录」回看。

## 模拟器构建

在 `mobile` 中执行 `npm ci`，把 `docs/index.html` 复制到 `mobile/www/index.html`，再按目标平台执行 `npx cap add ios` 或 `npx cap add android`。已有平台目录时执行 `npx cap sync`。

iOS 工程生成后，从 `mobile` 执行 `node ios-native/install.cjs`，再用 Xcode 打开 `ios/App/App.xcodeproj`。iOS 26 及以上使用苹果系统的液态玻璃底栏和弹层。Android 工程生成后，从 `mobile` 执行 `node android-native/install.cjs`，再用 Android Studio 打开 `android`。

## 安卓更新

[下载最新安卓版 APK](https://github.com/xueh0635-design/xigai-quiz-site/releases/latest/download/xigai-quiz-android.apk) · [查看版本说明](https://github.com/xueh0635-design/xigai-quiz-site/releases/latest)

在应用里打开「我的 → 应用更新」可以检查新版、打开 GitHub 发布页并开启更新通知。开启后，系统约每两小时安排一次后台检查，实际时间依设备的联网和省电设置而定。通知会打开对应的 GitHub Release 页面。

发布后续版本时，先把源码和网页推送到 `main`。构建 APK 时提高 `quizVersionCode` 并设置 `quizVersionName`，例如在 `mobile/android` 执行 `./gradlew :app:assembleRelease -PquizVersionCode=18 -PquizVersionName=1.1.16`。用同一个 Android 签名密钥签署 release APK，从仓库根目录运行 `python3 mobile/android-native/publish.py 已签名.apk 发布说明.md`。脚本先校验签名和版本，再发布 APK 并更新客户端读取的版本清单。APK 与发布清单会通过同一 GitHub 仓库提供。

## 同步更新已配对的 iPhone

在负责发布的 Mac 上，通过 Xcode 配对 iPhone，用本机原有的开发团队签名。创建本机配置 `~/Library/Application Support/Xigai Quiz/iphone-release.json`，填写这台 iPhone 在 Xcode 中的设备标识和签名团队标识。

```json
{
  "device": "设备的 Xcode UDID",
  "team": "Xcode 签名团队标识"
}
```

在这台 Mac 上运行安卓发布命令时，GitHub 上传成功后，脚本从对应发布标签构建 iPhone 版本并覆盖安装。同一局域网或数据线均可使用。iPhone 需要解锁且 Xcode 能连接。若安装待完成，等设备可用后，在同步了 `main` 的发布仓库根目录运行 `python3 mobile/ios-native/push_release.py`。安卓发布会先完成。

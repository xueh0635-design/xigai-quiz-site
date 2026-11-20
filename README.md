# 习概题库

[打开网页版](https://xueh0635-design.github.io/xigai-quiz-site/)。收录 1,685 道题。新增「章节自测」题目已并入各章。首页点章节即可连续练完整章，可随时退出并续做。作答后显示完整答案、考点速记、解析和可定位的教材页码。部分题目提供同考点练习。自定义测验支持按范围、题型和顺序组卷。用邮箱和密码注册后，可在自己的多台设备同步学习进度。

练习页顶部可切换「全部题库」「思政云」「学习通」，也可以点「只刷常考题」，按章节练习两库共有的 218 道题。同一道题的不同来源版本只出现一次，优先选用最近答过的版本。答题页和个人题目列表会标注「常考」。「我的旅程」可进入已答题、错题及收藏列表。

`docs/index.html` 是可独立运行的发布文件。原始截图和教材保存在本机。

答题页全屏支持右滑回上一题、左滑到下一题，也可以点翻题按钮。在本章内可回看已提交的作答、判分和解析，未提交的选项和填空会保留。

错题本按章节汇总待复练题。点进章节可查看原作答和解析，复练单题或本章全部错题。答对后题目自动退出待复练，仍答错的题可接着练。左滑题目或点「···」可移除并撤销，也可在做题页手动加入。

本章练完且错题清零后，结算页会提供「整章测验」。题目按当前题库范围出题，题序随机，交卷后一起判分。全对即通过，答错的题会回到本章待复练。错题本内也可主动发起测验。

「章节路线」里的「会议时间线」按日期整理题库涉及的会议和关键决定。可按记忆线索筛选，也可打开「专题原题」集中练。作答提交后，关联题目可以直接定位到对应会议。

首页和同桌营地可拖动 3D 视角，外观支持晨雾、日间、暮色、夜间和随时间切换。

「一起学」页首先显示同桌头像和在线状态，下方可发起五题共学或实时双塔擂台。共学时两人提交后一起看解析。擂台发起方可设置题量，同桌应战前能看到题量和限时。答对积攒能量，可使用战术卡牌和连击。场内提供快捷消息和双方自愿加入的点对点语音。「对局记录与收藏」里可查看双塔战绩、旧试卷和集卡册。

在「学习进度」直接点「我」或「同桌」的卡片，可看对应的题库完成度、正确率、待复练题数和已练完章节。图表展示近 7 天作答、各章节与题型的答题表现，以及各章节最近的整章测验成绩。自己的详情可以打开个人作答记录。可在进度卡片下给同桌打气或击掌。

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

在这台 Mac 上运行安卓发布命令时，GitHub 发布成功后，同版本的 iPhone 更新会记录到本机队列。Mac 已登录且唤醒时，后台队列约每 20 秒检查一次。iPhone 通过同一局域网或数据线连通并解锁后，Mac 会从对应发布标签构建并覆盖安装。构建后重新锁屏时，Mac 会保留已签名的安装包，等下次解锁再装。若期间发布了更新版本，队列会优先处理最新版。队列日志保存在应用支持目录下的 `iphone-queue-worker.log`。

新 Mac 的一次性设置是在上述应用支持目录中把发布仓库克隆为 `release-repo`，再运行其中的 `python3 mobile/ios-native/install_queue_agent.py`。需要立即给当前手机重新签名时，仍可在同步了 `main` 的发布仓库运行 `python3 mobile/ios-native/push_release.py`。

日常开发可以先用 Xcode 模拟器验证。跑真机时把 Xcode 顶栏的运行目标切换到已配对的 iPhone，再按 `⌘R`。如果修改的是内嵌网页，先更新 `mobile/www/index.html` 并从 `mobile` 执行 `npx cap copy ios`。

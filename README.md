# 习概题库

[打开网页版](https://xueh0635-design.github.io/xigai-quiz-site/)。收录 1,685 道题。新增「章节自测」题目已并入各章。首页点章节即可连续练完整章，可随时退出并续做。作答后显示完整答案、考点速记、解析和可定位的教材页码。部分题目提供同考点练习。自定义测验支持按范围、题型和顺序组卷。用邮箱和密码注册后，可在自己的多台设备同步学习进度。

练习页顶部可切换「全部题库」「思政云」「学习通」，也可以点「只刷常考题」，按章节练习两库共有的 218 道题。同一道题的不同来源版本只出现一次，优先选用最近答过的版本。答题页和个人题目列表会标注「常考」。「我的旅程」可进入已答题、错题及收藏列表。

源码按职责保存在 `web/`、`content/` 和 `mobile/`；`docs/` 是可重建的静态发布目录。部署或打包时必须携带整个目录及 `web-manifest.json`，不能只复制 `index.html`。原始截图和教材仍保存在维护者本机，仓库不包含这些来源文件。

答题页全屏支持右滑回上一题、左滑到下一题，也可以点翻题按钮。在本章内可回看已提交的作答、判分和解析，未提交的选项和填空会保留。

错题本按章节汇总待复练题。点进章节可查看原作答和解析，复练单题或本章全部错题。答对后题目自动退出待复练，仍答错的题可接着练。左滑题目或点「···」可移除并撤销，也可在做题页手动加入。

本章练完且错题清零后，结算页会提供「整章测验」。题目按当前题库范围出题，题序随机，交卷后一起判分。全对即通过，答错的题会回到本章待复练。错题本内也可主动发起测验。

「章节路线」里的「会议时间线」按日期整理题库涉及的会议和关键决定。可按记忆线索筛选，也可打开「专题原题」集中练。作答提交后，关联题目可以直接定位到对应会议。

底部导航为「路线、错题、知识、一起学、我的」。「知识」内嵌知识图谱、背诵卡片和薄弱分析，按当前登录账号或访客的错题记录更新。可以搜索、按章节筛选、拖动与缩放图谱，或切换等价的知识点列表。知识点支持直接进入关联错题和全量关联题练习，沿用原有草稿、答案记录及跨设备同步；收藏仍可从首页统计和「我的」进入。

知识图谱包含 133 张通用知识卡片及 157 条概念关系。题目依据题干与正确答案的公开关键词关联；不够明确的题目按章节标为「待细分」，不会从统计中丢弃。计数区分当前答错与手动保留，不将关键词关联当作确诊错因或掌握率。背诵自评仅保存在本机当前账号下，不会直接清除错题。知识内容随安装包离线提供，不依赖另一个网页服务。

首页和同桌营地可拖动 3D 视角，外观支持晨雾、日间、暮色、夜间和随时间切换。

「一起学」页首先显示同桌头像和在线状态，下方可发起五题共学或实时双塔擂台。共学时两人提交后一起看解析。擂台发起方可设置题量，同桌应战前能看到题量和限时。答对积攒能量，可使用战术卡牌和连击。场内提供快捷消息和双方自愿加入的点对点语音。「对局记录与收藏」里可查看双塔战绩、旧试卷和集卡册。

在「学习进度」直接点「我」或「同桌」的卡片，可看对应的题库完成度、正确率、待复练题数和已练完章节。图表展示近 7 天作答、各章节与题型的答题表现，以及各章节最近的整章测验成绩。自己的详情可以打开个人作答记录。可在进度卡片下给同桌打气或击掌。

## 模拟器构建

使用 Node.js 22 或更新的兼容版本。在仓库根目录执行：

```sh
npm --prefix mobile ci
npm --prefix mobile run build:web
npm --prefix mobile run verify
npm --prefix mobile run test:database
npm --prefix mobile run copy:web
```

再进入 `mobile`，按目标平台执行 `npx --no-install cap add ios` 或 `npx --no-install cap add android`。已有平台目录时执行 `npm run sync`，这会重新构建、校验并复制完整 Web 目录，再运行 Capacitor 同步。

iOS 工程生成后，从 `mobile` 执行 `node ios-native/install.cjs`，再用 Xcode 打开 `ios/App/App.xcodeproj`。iOS 26 及以上使用苹果系统的液态玻璃底栏和弹层。Android 工程生成后，从 `mobile` 执行 `node android-native/install.cjs`，再用 Android Studio 打开 `android`。

## 安卓更新

[下载最新安卓版 APK](https://github.com/xueh0635-design/xigai-quiz-site/releases/latest/download/xigai-quiz-android.apk) · [查看版本说明](https://github.com/xueh0635-design/xigai-quiz-site/releases/latest)

在应用里打开「我的 → 应用更新」可以检查新版、打开 GitHub 发布页并开启更新通知。开启后，系统约每两小时安排一次后台检查，实际时间依设备的联网和省电设置而定。通知会打开对应的 GitHub Release 页面。

发布后续版本时，先在 `mobile/android-native/app/build.gradle` 提高 `quizVersionCode` 和 `quizVersionName` 的默认值，提交源码、Web 产物及版本号到 `main`。等这个提交的完整 `release-gate` 成功后，从 Actions 下载 `android-release-<提交 SHA>` 中的 `app-release-unsigned.apk`，用同一个 Android 签名密钥执行 zipalign/签名。不要在本机重新构建替换该产物，也不要提前修改 `docs/android-update.json`。

从与该源码提交一致的干净仓库运行：

```sh
python3 mobile/android-native/publish.py 已签名.apk 发布说明.md
```

发布器会验证签名、版本、源码 SHA、完整 Web 资源哈希、该提交的成功 CI 检查，以及 APK 与 CI 制品的非签名内容一致性。校验通过后才发布 APK 并更新客户端版本清单；缺失、失败或跳过的检查都不能放行。签名密钥只保存在维护者自己的签名环境。

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

日常开发可以先用 Xcode 模拟器验证。跑真机时把 Xcode 顶栏的运行目标切换到已配对的 iPhone，再按 `⌘R`。修改内嵌网页后，从 `mobile` 执行 `npm run sync`；不要手工覆盖单个 HTML 文件。


## 源码、题库与校验

- `web/index.template.html`：页面结构；`web/styles/`：样式；`web/scripts/`：按功能拆分的现有脚本。
- `content/`：题目、会议时间线、错误选项解析。内容修改后运行 `npm --prefix mobile run check:content`。
- `content/knowledge-concepts.json`：通用知识定义、关键词和概念关系；`web/scripts/knowledge-model.js`：去重及当前账号的知识映射；`web/scripts/knowledge.js`：图谱、卡片和练习入口。该目录不包含个人错题快照或账户凭据。
- `mobile/account.js` 与存储模块：账号、离线持久化、同步协议；原生覆层位于 `mobile/ios-native/`、`mobile/android-native/`。
- `backend/supabase/`：数据库迁移与云函数；本地 SQL 验证使用 PGlite，不连接生产数据库。
- `docs/`：`npm --prefix mobile run build:web` 生成的静态产物。提交时一并提交；CI 会重建并逐字节检查，拒绝源码与发布文件漂移。

题库标识由 `content/questions.json` 的 SHA-256 生成。题目原始条目、去重后的题目与可判分题目是不同概念；完成度只统计去重后的可练习客观题。修改题目答案或身份规则时，必须同步更新后端题库版本迁移，并运行数据库测试。历史答题事实保留当时的题库版本。

CI 分别执行源码与内容校验、数据库权限/迁移测试、真实浏览器测试、Android 构建和 iOS 模拟器流程；全部成功才产生 `release-gate`。手动跳过 iOS 的运行不能用于正式发布。

详细的源码边界、兼容策略与上线顺序见 [工程维护说明](engineering/architecture-reliability.md)。

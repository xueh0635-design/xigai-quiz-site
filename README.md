# 习概题库

[打开网页版](https://xueh0635-design.github.io/xigai-quiz-site/)。收录 1,221 道题，支持按章节和题型组卷、错题重练、收藏与背诵。解析标注可定位的教材印刷页码。用邮箱和密码注册后，可在自己的多台设备同步学习进度。底部可切换练习、错题、收藏和个人页。

`docs/index.html` 是可独立运行的发布文件。原始截图和教材保存在本机。

## 模拟器构建

在 `mobile` 中执行 `npm ci`，把 `docs/index.html` 复制到 `mobile/www/index.html`，再按目标平台执行 `npx cap add ios` 或 `npx cap add android`。已有平台目录时执行 `npx cap sync`。使用 Xcode 或 Android Studio 打开对应的工程。

(() => {
  "use strict";

  const capacitor = window.Capacitor;
  if (capacitor?.getPlatform?.() !== "android" || !capacitor.isPluginAvailable?.("QuizUpdate")) return;
  const updates = capacitor.Plugins.QuizUpdate;
  const panel = document.getElementById("android-updates");
  const statusText = document.getElementById("update-status");
  const checkButton = document.getElementById("update-check");
  const notifyButton = document.getElementById("update-notify");
  const downloadButton = document.getElementById("update-download");
  let lastStatus;

  function render(status, checked = false) {
    lastStatus = status;
    const current = `当前版本 ${status.currentVersionName}`;
    statusText.textContent = status.available
      ? `${current} · 可更新至 ${status.versionName}`
      : status.checkFailed ? `${current} · 暂时无法检查更新`
      : checked ? `${current} · 已是最新版` : current;
    notifyButton.textContent = status.notificationsEnabled ? "关闭更新通知"
      : status.notificationsBlocked ? "前往系统开启通知" : "开启更新通知";
    downloadButton.hidden = !status.available;
    panel.hidden = false;
  }

  async function act(button, action, done) {
    button.disabled = true;
    try {
      done?.(await action());
    } catch {
      statusText.textContent = "操作未完成，请稍后重试。";
    } finally {
      button.disabled = false;
    }
  }

  checkButton.onclick = () => {
    statusText.textContent = "正在检查更新…";
    return act(checkButton, () => updates.check(), (status) => render(status, true));
  };
  notifyButton.onclick = () => act(notifyButton, async () => {
    if (lastStatus?.notificationsEnabled) return updates.disableNotifications();
    if (lastStatus?.notificationsBlocked) {
      await updates.openNotificationSettings();
      return updates.getStatus();
    }
    return updates.enableNotifications();
  }, render);
  downloadButton.onclick = () => act(downloadButton, () => updates.openRelease());

  updates.getStatus().then((status) => { if (!lastStatus) render(status); }).catch(() => {});
  Promise.resolve().then(() => updates.addListener("updateStatus", (status) => render(status))).catch(() => {});
})();

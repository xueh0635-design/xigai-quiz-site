package io.github.xueh0635.xigai;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "QuizUpdate", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class QuizUpdatePlugin extends Plugin {
    @Override
    protected void handleOnResume() {
        Context context = getContext().getApplicationContext();
        QuizUpdateChecker.updateSchedule(context);
        refresh(context, false, null);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status(getContext()));
    }

    @PluginMethod
    public void check(PluginCall call) {
        refresh(getContext().getApplicationContext(), true, call);
    }

    @PluginMethod
    public void enableNotifications(PluginCall call) {
        Context context = getContext();
        QuizUpdateChecker.setNotificationsOptedIn(context, true);
        QuizUpdateChecker.createChannel(context);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            getBridge().executeOnMainThread(() -> requestPermissionForAlias("notifications", call, "onNotificationPermission"));
        } else {
            onNotificationPermission(call);
        }
    }

    @PermissionCallback
    private void onNotificationPermission(PluginCall call) {
        if (call == null) return;
        Context context = getContext().getApplicationContext();
        QuizUpdateChecker.updateSchedule(context);
        call.resolve(status(context));
        if (QuizUpdateChecker.notificationsEnabled(context)) refresh(context, false, null);
    }

    @PluginMethod
    public void disableNotifications(PluginCall call) {
        Context context = getContext();
        QuizUpdateChecker.setNotificationsOptedIn(context, false);
        QuizUpdateChecker.updateSchedule(context);
        call.resolve(status(context));
    }

    @PluginMethod
    public void openRelease(PluginCall call) {
        Context context = getContext();
        startActivity(QuizUpdateChecker.releaseIntent(QuizUpdateChecker.latestVersion(context)), call);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getContext().getPackageName(), null));
        }
        startActivity(intent, call);
    }

    private void startActivity(Intent intent, PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            try {
                getActivity().startActivity(intent);
                call.resolve();
            } catch (ActivityNotFoundException | SecurityException error) {
                call.reject("系统暂时无法打开这个页面。", error);
            }
        });
    }

    private void refresh(Context context, boolean manual, PluginCall call) {
        QuizUpdateChecker.enqueue(() -> {
            QuizUpdateChecker.refresh(context, manual);
            getBridge().execute(() -> {
                JSObject result = status(context);
                if (call != null) call.resolve(result);
                notifyListeners("updateStatus", result);
            });
        });
    }

    private JSObject status(Context context) {
        QuizUpdateChecker.Version installed = QuizUpdateChecker.installedVersion(context);
        QuizUpdateChecker.Version latest = QuizUpdateChecker.latestVersion(context);
        boolean notificationsEnabled = QuizUpdateChecker.notificationsEnabled(context);
        JSObject result = new JSObject()
            .put("available", latest.code > installed.code)
            .put("currentVersionCode", installed.code)
            .put("currentVersionName", installed.name)
            .put("notificationsEnabled", notificationsEnabled)
            .put("notificationsBlocked", !notificationsEnabled && QuizUpdateChecker.notificationsOptedIn(context))
            .put("checked", latest.code > 0)
            .put("checkFailed", QuizUpdateChecker.lastCheckFailed(context));
        if (latest.code > 0) result.put("versionCode", latest.code).put("versionName", latest.name);
        return result;
    }
}

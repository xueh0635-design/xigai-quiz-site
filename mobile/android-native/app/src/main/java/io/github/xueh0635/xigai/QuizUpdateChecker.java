package io.github.xueh0635.xigai;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.pm.PackageInfoCompat;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONException;
import org.json.JSONObject;

final class QuizUpdateChecker {
    private static final String MANIFEST_URL = "https://xueh0635-design.github.io/xigai-quiz-site/android-update.json";
    private static final String RELEASES_URL = "https://github.com/xueh0635-design/xigai-quiz-site/releases/";
    private static final String PREFERENCES = "quiz_app_updates";
    private static final String OPT_IN = "notifications_opted_in";
    private static final String CHANNEL_ID = "quiz_updates";
    private static final int UPDATE_ID = 4100;
    private static final int JOB_ID = 4101;
    private static final int MAX_MANIFEST_BYTES = 4096;
    private static final long PERIOD = TimeUnit.HOURS.toMillis(2);
    private static final long CHECK_COOLDOWN = TimeUnit.MINUTES.toMillis(30);
    private static final long FAILURE_COOLDOWN = TimeUnit.MINUTES.toMillis(2);
    private static final Pattern VERSION_NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9. +\\-]{0,39}");
    private static final Pattern RELEASE_TAG = Pattern.compile("android-v[0-9]{1,8}\\.[0-9]{1,8}\\.[0-9]{1,8}");
    private static final ExecutorService executor = Executors.newSingleThreadExecutor();

    private QuizUpdateChecker() {}

    static Future<?> enqueue(Runnable task) {
        return executor.submit(task);
    }

    static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    static Version installedVersion(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return new Version(PackageInfoCompat.getLongVersionCode(info), info.versionName, "");
        } catch (PackageManager.NameNotFoundException error) {
            throw new IllegalStateException("Cannot read the installed application version", error);
        }
    }

    static Version latestVersion(Context context) {
        SharedPreferences saved = preferences(context);
        return new Version(saved.getLong("version_code", 0), saved.getString("version_name", ""), saved.getString("release_tag", ""));
    }

    static boolean lastCheckFailed(Context context) {
        return preferences(context).getBoolean("check_failed", false);
    }

    static void refresh(Context context, boolean manual) {
        SharedPreferences saved = preferences(context);
        long now = System.currentTimeMillis();
        long elapsed = now - saved.getLong("last_attempt", 0);
        long cooldown = lastCheckFailed(context) ? FAILURE_COOLDOWN : CHECK_COOLDOWN;
        if (!manual && elapsed >= 0 && elapsed < cooldown) {
            notifyOnUpdate(context);
            return;
        }

        try {
            Version latest = fetch();
            saved.edit()
                .putLong("version_code", latest.code)
                .putString("version_name", latest.name)
                .putString("release_tag", latest.tag)
                .putLong("last_attempt", now)
                .putBoolean("check_failed", false)
                .apply();
        } catch (IOException | JSONException error) {
            saved.edit().putLong("last_attempt", now).putBoolean("check_failed", true).apply();
        }
        if (!Thread.currentThread().isInterrupted()) notifyOnUpdate(context);
    }

    private static Version fetch() throws IOException, JSONException {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(MANIFEST_URL).openConnection();
        try {
            connection.setConnectTimeout(6000);
            connection.setReadTimeout(6000);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Cache-Control", "no-cache");
            if (connection.getResponseCode() != HttpsURLConnection.HTTP_OK) {
                throw new IOException("Update manifest could not be loaded");
            }
            try (InputStream body = connection.getInputStream()) {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] buffer = new byte[1024];
                int count;
                while ((count = body.read(buffer)) != -1) {
                    if (bytes.size() + count > MAX_MANIFEST_BYTES) throw new IOException("Update manifest is too large");
                    bytes.write(buffer, 0, count);
                }
                return parseManifest(new JSONObject(bytes.toString(StandardCharsets.UTF_8.name())));
            }
        } finally {
            connection.disconnect();
        }
    }

    static Version parseManifest(JSONObject manifest) throws JSONException {
        Object value = manifest.get("versionCode");
        Object label = manifest.get("versionName");
        if (!(value instanceof Number) || !(label instanceof String)) throw new JSONException("Expected a version code and name");
        String name = (String) label;
        Number number = (Number) value;
        long code = number.longValue();
        if (number.doubleValue() != code || code < 1 || code > Integer.MAX_VALUE || !VERSION_NAME.matcher(name).matches()) {
            throw new JSONException("Invalid version metadata");
        }
        String tag = manifest.optString("releaseTag");
        return new Version(code, name, RELEASE_TAG.matcher(tag).matches() ? tag : "");
    }

    static boolean notificationsOptedIn(Context context) {
        return preferences(context).getBoolean(OPT_IN, false);
    }

    static boolean notificationsEnabled(Context context) {
        return notificationsOptedIn(context) && canPostNotifications(context);
    }

    private static boolean canPostNotifications(Context context) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = context.getSystemService(NotificationManager.class).getNotificationChannel(CHANNEL_ID);
            return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
        }
        return true;
    }

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, context.getString(R.string.updates_channel), NotificationManager.IMPORTANCE_DEFAULT);
            context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    static void setNotificationsOptedIn(Context context, boolean enabled) {
        preferences(context).edit().putBoolean(OPT_IN, enabled).apply();
        if (!enabled) NotificationManagerCompat.from(context).cancel(UPDATE_ID);
    }

    static void updateSchedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (!notificationsEnabled(context)) {
            scheduler.cancel(JOB_ID);
        } else if (scheduler.getPendingJob(JOB_ID) == null) {
            JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(context, QuizUpdateJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(PERIOD)
                .setPersisted(true)
                .build();
            scheduler.schedule(job);
        }
    }

    private static void notifyOnUpdate(Context context) {
        Version current = installedVersion(context);
        Version latest = latestVersion(context);
        if (latest.code <= current.code) {
            NotificationManagerCompat.from(context).cancel(UPDATE_ID);
            return;
        }
        SharedPreferences saved = preferences(context);
        if (!notificationsEnabled(context) || saved.getLong("notified_version", 0) >= latest.code) return;

        createChannel(context);
        PendingIntent openRelease = PendingIntent.getActivity(context, UPDATE_ID, releaseIntent(latest),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String text = context.getString(R.string.update_notification_text, latest.name);
        NotificationCompat.Builder notification = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_update_notification)
            .setContentTitle(context.getString(R.string.update_notification_title))
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openRelease)
            .setAutoCancel(true);
        try {
            NotificationManagerCompat.from(context).notify(UPDATE_ID, notification.build());
            saved.edit().putLong("notified_version", latest.code).apply();
        } catch (SecurityException ignored) {
            // Android can revoke notification permission between the check and posting the message.
        }
    }

    static Intent releaseIntent(Version latest) {
        String release = RELEASE_TAG.matcher(latest.tag).matches() ? "tag/" + latest.tag : "latest";
        return new Intent(Intent.ACTION_VIEW, Uri.parse(RELEASES_URL + release));
    }

    static final class Version {
        final long code;
        final String name;
        final String tag;

        Version(long code, String name, String tag) {
            this.code = code;
            this.name = name;
            this.tag = tag;
        }
    }
}

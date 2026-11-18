package io.github.xueh0635.xigai;

import android.content.res.Configuration;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "QuizAppearance")
public class QuizAppearancePlugin extends Plugin {
    private enum Theme {
        DAWN(0xffe9efea, true),
        DAY(0xffe7efe5, true),
        DUSK(0xff1a1b2a, false),
        NIGHT(0xff0f1d2b, false);

        final int background;
        final boolean darkIcons;

        Theme(int background, boolean darkIcons) {
            this.background = background;
            this.darkIcons = darkIcons;
        }
    }

    private Theme currentTheme;

    @PluginMethod
    public void setTheme(PluginCall call) {
        Theme theme = switch (call.getString("theme", "")) {
            case "dawn" -> Theme.DAWN;
            case "day" -> Theme.DAY;
            case "dusk" -> Theme.DUSK;
            case "night" -> Theme.NIGHT;
            default -> null;
        };
        if (theme == null) {
            call.reject("未知的营地主题。");
            return;
        }

        getBridge().executeOnMainThread(() -> {
            currentTheme = theme;
            applyTheme();
            call.resolve();
        });
    }

    @Override
    protected void handleOnResume() {
        getBridge().executeOnMainThread(this::applyTheme);
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration configuration) {
        // SystemBars reapplies its own default during this callback.
        getBridge().executeOnMainThread(this::applyTheme);
    }

    private void applyTheme() {
        Theme theme = currentTheme;
        if (theme == null) return;
        Window window = getActivity().getWindow();
        window.setBackgroundDrawable(new ColorDrawable(theme.background));
        window.getDecorView().setBackgroundColor(theme.background);
        getBridge().getWebView().setBackgroundColor(theme.background);
        if (Build.VERSION.SDK_INT < 35) {
            window.setStatusBarColor(theme.background);
            window.setNavigationBarColor(theme.background);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }

        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(theme.darkIcons);
        controller.setAppearanceLightNavigationBars(theme.darkIcons);
    }
}

package io.github.xueh0635.xigai;

import android.webkit.WebView;
import androidx.core.view.HapticFeedbackConstantsCompat;
import androidx.core.view.ViewCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "QuizHaptics")
public class QuizHapticsPlugin extends Plugin {
    @PluginMethod
    public void answer(PluginCall call) {
        int effect = switch (call.getString("outcome", "")) {
            case "correct" -> HapticFeedbackConstantsCompat.CONFIRM;
            case "incorrect" -> HapticFeedbackConstantsCompat.REJECT;
            default -> -1;
        };
        if (effect == -1) {
            call.reject("Unknown answer outcome.");
            return;
        }

        getBridge().executeOnMainThread(() -> {
            WebView webView = getBridge().getWebView();
            if (webView.isShown() && webView.hasWindowFocus()) {
                ViewCompat.performHapticFeedback(webView, effect);
            }
            call.resolve();
        });
    }
}

package io.github.xueh0635.xigai;

import android.Manifest;
import android.animation.ValueAnimator;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.PermissionRequest;
import android.webkit.WebView;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private static final long LAUNCH_TIMEOUT_MS = 2_500;
    private boolean pageVisible;
    private PermissionRequest pendingMicrophone;
    private boolean requestingMicrophone;
    private final ActivityResultLauncher<String> requestMicrophone = registerForActivityResult(
        new ActivityResultContracts.RequestPermission(), this::completeMicrophoneRequest
    );

    @Override
    protected void onCreate(Bundle state) {
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        long launchDeadline = SystemClock.uptimeMillis() + LAUNCH_TIMEOUT_MS;
        bridgeBuilder.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                pageVisible = true;
            }
        });
        registerPlugin(QuizAppearancePlugin.class);
        registerPlugin(QuizUpdatePlugin.class);
        super.onCreate(state);
        if (getBridge() != null) {
            splash.setKeepOnScreenCondition(() -> !pageVisible && SystemClock.uptimeMillis() < launchDeadline);
        }
        splash.setOnExitAnimationListener(provider -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ValueAnimator.areAnimatorsEnabled()) {
                provider.remove();
                return;
            }
            provider.getView().animate().alpha(0f).setDuration(160).withEndAction(provider::remove).start();
        });
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        webView.getSettings().setSupportZoom(false);
        webView.setWebChromeClient(new BridgeWebChromeClient(getBridge()) {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                String[] resources = request.getResources();
                if (!isBundledOrigin(request.getOrigin()) || !isBundledPage() || resources.length != 1
                    || !PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[0]) || requestingMicrophone) {
                    request.deny();
                    return;
                }

                if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED) {
                    grantMicrophone(request);
                    return;
                }

                pendingMicrophone = request;
                requestingMicrophone = true;
                requestMicrophone.launch(Manifest.permission.RECORD_AUDIO);
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (request == pendingMicrophone) pendingMicrophone = null;
            }
        });
    }

    private void completeMicrophoneRequest(boolean granted) {
        PermissionRequest request = pendingMicrophone;
        pendingMicrophone = null;
        requestingMicrophone = false;
        if (request == null) return;
        if (granted && isBundledPage()) grantMicrophone(request);
        else request.deny();
    }

    private boolean isBundledPage() {
        String url = getBridge().getWebView().getUrl();
        return url != null && isBundledOrigin(Uri.parse(url));
    }

    private static boolean isBundledOrigin(Uri origin) {
        return origin != null && "https".equals(origin.getScheme()) && "localhost".equals(origin.getHost())
            && origin.getUserInfo() == null && (origin.getPort() == -1 || origin.getPort() == 443);
    }

    private static void grantMicrophone(PermissionRequest request) {
        request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
    }
}

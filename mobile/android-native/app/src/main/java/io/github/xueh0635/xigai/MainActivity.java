package io.github.xueh0635.xigai;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle state) {
        registerPlugin(QuizUpdatePlugin.class);
        super.onCreate(state);
    }
}

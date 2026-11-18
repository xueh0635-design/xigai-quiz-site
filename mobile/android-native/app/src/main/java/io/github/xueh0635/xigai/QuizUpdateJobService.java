package io.github.xueh0635.xigai;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import java.util.concurrent.Future;

public class QuizUpdateJobService extends JobService {
    private final Handler main = new Handler(Looper.getMainLooper());
    private JobParameters running;
    private Future<?> pending;

    @Override
    public boolean onStartJob(JobParameters parameters) {
        Context context = getApplicationContext();
        if (!QuizUpdateChecker.notificationsEnabled(context)) return false;
        running = parameters;
        pending = QuizUpdateChecker.enqueue(() -> {
            try {
                QuizUpdateChecker.refresh(context, false);
            } finally {
                main.post(() -> {
                    if (running != parameters) return;
                    running = null;
                    pending = null;
                    jobFinished(parameters, false);
                });
            }
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters parameters) {
        if (running == parameters) {
            running = null;
            pending.cancel(true);
            pending = null;
        }
        return false;
    }
}

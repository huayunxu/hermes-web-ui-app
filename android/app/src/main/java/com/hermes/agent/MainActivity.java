package com.hermes.agent;

import android.Manifest;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.util.Log;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.BridgeActivity;
import android.webkit.WebView;
import android.webkit.WebChromeClient;
import android.webkit.PermissionRequest;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.content.pm.PackageManager;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "HermesUpdate";
    private static final String GITHUB_API_RELEASES =
        "https://api.github.com/repos/huayunxu/hermes-web-ui/releases/latest";
    // The GH Action publishes APK as: hermes-web-ui-debug.apk
    // Tag format: build-{run_number}
    private static final String APK_ASSET_NAME = "hermes-web-ui-debug.apk";

    private ProgressBar progressBar;
    private TextView progressText;
    private AlertDialog updateDialog;
    private AlertDialog downloadDialog;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    // Permission launcher for Android 8+ (REQUEST_INSTALL_PACKAGES is auto-granted for debug)
    private final ActivityResultLauncher<String> installPermissionLauncher =
        registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            if (granted) {
                installApkFromDownload();
            } else {
                Log.e(TAG, "Install permission denied");
            }
        });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Enable WebView debugging for Chrome DevTools
        WebView.setWebContentsDebuggingEnabled(true);
        
        // Request microphone permission at runtime
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) 
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, 
                new String[]{android.Manifest.permission.RECORD_AUDIO}, 1001);
        }
        
        // Check for updates after the app has started
        executor.execute(this::checkForUpdates);
        
        // Setup WebView with WebChromeClient for permission handling
        // This is needed for Web Speech API (STT) to work on Android
        try {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.setWebChromeClient(new WebChromeClient() {
                    @Override
                    public void onPermissionRequest(final PermissionRequest request) {
                        runOnUiThread(() -> {
                            request.grant(request.getResources());
                        });
                    }
                });
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to setup WebChromeClient: " + e.getMessage());
        }
    }

    private void checkForUpdates() {
        try {
            Log.d(TAG, "Checking for updates at " + GITHUB_API_RELEASES);
            HttpURLConnection conn = (HttpURLConnection) new URL(GITHUB_API_RELEASES).openConnection();
            conn.setRequestProperty("Accept", "application/vnd.github+json");
            conn.setRequestProperty("User-Agent", "HermesAndroid/1.0");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            conn.setRequestMethod("GET");

            int responseCode = conn.getResponseCode();
            Log.d(TAG, "GitHub API response: " + responseCode);

            if (responseCode == HttpURLConnection.HTTP_OK) {
                String body = readStream(conn.getInputStream());
                JSONObject release = new JSONObject(body);
                String latestTag = release.optString("tag_name", "");
                String latestVersion = latestTag.replace("build-", "");
                String downloadUrl = findApkUrl(release);

                int currentBuild = getCurrentBuildNumber();

                Log.d(TAG, "Latest tag: " + latestTag + ", current build: " + currentBuild);
                Log.d(TAG, "Download URL: " + downloadUrl);

                if (!latestTag.isEmpty() && !downloadUrl.isEmpty()) {
                    if (compareBuilds(latestTag, currentBuild) > 0) {
                        runOnUiThread(() -> showUpdateDialog(latestTag, downloadUrl));
                    }
                }
            } else {
                Log.w(TAG, "Non-200 response from GitHub: " + responseCode);
            }
            conn.disconnect();
        } catch (Exception e) {
            Log.e(TAG, "Update check failed", e);
        }
    }

    private int compareBuilds(String latestTag, int currentBuild) {
        try {
            String latestNumStr = latestTag.replace("build-", "");
            int latestNum = Integer.parseInt(latestNumStr);
            return Integer.compare(latestNum, currentBuild);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private String findApkUrl(JSONObject release) {
        // Try to find APK in release assets
        try {
            var assets = release.optJSONArray("assets");
            if (assets != null) {
                for (int i = 0; i < assets.length(); i++) {
                    var asset = assets.getJSONObject(i);
                    String name = asset.optString("name", "");
                    if (name.endsWith(".apk")) {
                        return asset.optString("browser_download_url", "");
                    }
                }
            }
            // Fallback: construct URL from tag name
            String tag = release.optString("tag_name", "");
            if (!tag.isEmpty()) {
                String baseUrl = "https://github.com/huayunxu/hermes-web-ui/releases/download/" + tag + "/" + APK_ASSET_NAME;
                return baseUrl;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error parsing release assets", e);
        }
        return "";
    }

    private int getCurrentBuildNumber() {
        try {
            PackageInfo pInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
            // Use versionCode for comparison (set by CI build)
            // Version name is e.g. "1.0.0" but we compare by build number
            // Store the build number in PackageManager via BuildConfig or metadata
            // For now, use a simple approach: compare the numeric portion of versionName
            String versionName = pInfo.versionName != null ? pInfo.versionName : "0";
            // Try to extract build number from versionName if it's in format "x.y.z-N"
            if (versionName.matches(".*-(\\d+).*")) {
                String num = versionName.replaceAll(".*-(\\d+).*", "$1");
                return Integer.parseInt(num);
            }
            return 0;
        } catch (PackageManager.NameNotFoundException e) {
            return 0;
        }
    }

    private void showUpdateDialog(String version, String downloadUrl) {
        new AlertDialog.Builder(this)
            .setTitle("发现新版本")
            .setMessage("Hermes Web UI " + version + " 已发布。\n\n是否下载并安装更新？")
            .setPositiveButton("下载", (dialog, which) -> {
                downloadAndInstallApk(downloadUrl);
            })
            .setNegativeButton("暂不", null)
            .setCancelable(true)
            .show();
    }

    private void downloadAndInstallApk(String downloadUrl) {
        // Build the download view
        android.widget.LinearLayout layout = new android.widget.LinearLayout(this);
        layout.setOrientation(android.widget.LinearLayout.VERTICAL);
        layout.setPadding(48, 32, 48, 32);
        layout.setGravity(android.view.Gravity.CENTER);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgress(0);
        progressBar.setLayoutParams(new android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT));

        progressText = new TextView(this);
        progressText.setText("正在下载...");
        progressText.setTextSize(14);
        progressText.setLayoutParams(new android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT));

        layout.addView(progressText);
        layout.addView(progressBar);

        downloadDialog = new AlertDialog.Builder(this)
            .setTitle("下载更新")
            .setView(layout)
            .setCancelable(false)
            .create();
        downloadDialog.show();

        executor.execute(() -> downloadApk(downloadUrl));
    }

    private void downloadApk(String downloadUrl) {
        try {
            URL url = new URL(downloadUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestProperty("User-Agent", "HermesAndroid/1.0");
            conn.setConnectTimeout(30000);
            conn.setReadTimeout(30000);
            conn.setRequestMethod("GET");

            int responseCode = conn.getResponseCode();
            if (responseCode != HttpURLConnection.HTTP_OK) {
                Log.e(TAG, "Download failed: HTTP " + responseCode);
                runOnUiThread(() -> {
                    if (downloadDialog != null) downloadDialog.dismiss();
                    showDownloadError();
                });
                return;
            }

            String contentLengthStr = conn.getHeaderField("Content-Length");
            long totalBytes = 0;
            if (contentLengthStr != null) {
                totalBytes = Long.parseLong(contentLengthStr);
            }

            // Save to cache dir (FileProvider accessible)
            final File apkFile = new File(getCacheDir(), APK_ASSET_NAME);
            long downloadedBytes = 0;

            try (InputStream in = conn.getInputStream();
                 FileOutputStream out = new FileOutputStream(apkFile)) {
                byte[] buffer = new byte[8192];
                int bytesRead;
                while ((bytesRead = in.read(buffer)) != -1) {
                    out.write(buffer, 0, bytesRead);
                    downloadedBytes += bytesRead;
                    if (totalBytes > 0) {
                        int progress = (int) (downloadedBytes * 100 / totalBytes);
                        final int p = progress;
                        runOnUiThread(() -> {
                            if (progressBar != null) progressBar.setProgress(p);
                            if (progressText != null) progressText.setText("正在下载... " + p + "%");
                        });
                    }
                }
            }

            conn.disconnect();

            Log.d(TAG, "APK downloaded: " + apkFile.getAbsolutePath());
            runOnUiThread(() -> {
                if (downloadDialog != null) downloadDialog.dismiss();
                promptInstall(apkFile);
            });

        } catch (Exception e) {
            Log.e(TAG, "Download failed", e);
            runOnUiThread(() -> {
                if (downloadDialog != null) downloadDialog.dismiss();
                showDownloadError();
            });
        }
    }

    private void promptInstall(File apkFile) {
        Uri apkUri = FileProvider.getUriForFile(
            this, getPackageName() + ".fileprovider", apkFile);

        new AlertDialog.Builder(this)
            .setTitle("下载完成")
            .setMessage("APK 已下载，是否安装？")
            .setPositiveButton("安装", (dialog, which) -> {
                requestInstallPermission(apkUri);
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void requestInstallPermission(Uri apkUri) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (getPackageManager().canRequestPackageInstalls()) {
                installApkFromUri(apkUri);
            } else {
                // Show dialog explaining the user needs to enable install permission
                new AlertDialog.Builder(this)
                    .setTitle("需要授权")
                    .setMessage("请在设置中允许安装未知来源应用，然后重新下载更新。")
                    .setPositiveButton("打开设置", (dialog, which) -> {
                        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                        intent.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(intent);
                    })
                    .setNegativeButton("取消", null)
                    .show();
            }
        } else {
            installApkFromUri(apkUri);
        }
    }

    private void installApkFromUri(Uri apkUri) {
        try {
            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(installIntent);
        } catch (Exception e) {
            Log.e(TAG, "Install failed", e);
        }
    }

    private void installApkFromDownload() {
        // Called back after permission granted
        File apkFile = new File(getCacheDir(), APK_ASSET_NAME);
        if (apkFile.exists()) {
            Uri apkUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apkFile);
            installApkFromUri(apkUri);
        }
    }

    private void showDownloadError() {
        new AlertDialog.Builder(this)
            .setTitle("下载失败")
            .setMessage("APK 下载失败，请检查网络连接后重试。")
            .setPositiveButton("确定", null)
            .show();
    }

    private String readStream(InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream result = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int len;
        while ((len = in.read(buffer)) != -1) {
            result.write(buffer, 0, len);
        }
        return result.toString("UTF-8");
    }
}
package com.makagic.jplm.warehouse;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.stream.Collectors;

public final class MainActivity extends Activity {
    private static final int BLUE = 0xff1858ab;
    private static final int INK = 0xff172539;
    private static final int MUTED = 0xff415977;
    private static final int BACKGROUND = 0xfff0f4f9;
    private static final int SECONDARY = 0xffe5edf7;
    private static final int CAMERA_PERMISSION = 1;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Plm plm = new Plm();
    private WebView web;
    private PermissionRequest cameraRequest;
    private boolean signingIn;
    private boolean showingPassword;
    private String touchStyle = "";

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        try (BufferedReader css = new BufferedReader(
                new InputStreamReader(getAssets().open("touch.css"), StandardCharsets.UTF_8))) {
            touchStyle = css.lines().collect(Collectors.joining("\n"));
        } catch (IOException ignored) {
            // The warehouse page has its own touch styles.
        }
        CookieManager.getInstance().removeAllCookies(null);
        showAccounts("");
    }

    private void showAccounts(String message) {
        JSONArray roster = loadRoster();
        if (roster.length() == 0) {
            showPassword(null);
            return;
        }
        showingPassword = false;
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        LinearLayout panel = screen("JPLM 出入库", "选择操作员");
        if (!message.isEmpty()) add(panel, label(message, 16, MUTED), 0, 6);
        for (int i = 0; i < roster.length(); i++) {
            JSONObject account = roster.optJSONObject(i);
            if (account == null) continue;
            Button user = button(account.optString("name"), 72, 24, true);
            user.setOnClickListener(view -> showPassword(account));
            add(panel, user, 0, 10);
        }
        Button sync = button("刷新操作员名单", 60, 18, false);
        sync.setOnClickListener(view -> showPassword(null));
        add(panel, sync, 0, 12);
    }

    private void showPassword(JSONObject account) {
        showingPassword = true;
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        boolean sync = account == null;
        LinearLayout panel = screen(sync ? "JPLM 出入库" : account.optString("name"),
                sync ? "登录以加载操作员名单" : "输入 JPLM 密码");
        EditText email = edit("JPLM 邮箱", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        if (sync) {
            email.setImeOptions(EditorInfo.IME_ACTION_NEXT);
            add(panel, email, 60, 12);
        }
        EditText password = edit("密码", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setImeOptions(EditorInfo.IME_ACTION_GO);
        add(panel, password, 60, 12);
        TextView status = label("", 16, 0xff9c222b);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        add(panel, status, 0, 4);
        Button submit = button(sync ? "登录并加载名单" : "进入出入库登记", 70, 22, true);
        add(panel, submit, 0, 8);
        Button back = button("返回账号列表", 58, 18, false);
        back.setOnClickListener(view -> showAccounts(""));
        add(panel, back, 0, 12);
        back.setVisibility(loadRoster().length() > 0 ? View.VISIBLE : View.GONE);

        submit.setOnClickListener(view -> {
            if (signingIn) return;
            String loginEmail = sync ? email.getText().toString().trim() : account.optString("email");
            String loginPassword = password.getText().toString();
            if (loginEmail.isEmpty() || loginPassword.isEmpty()) {
                status.setText(sync ? "请输入 JPLM 邮箱和密码。" : "请输入密码。");
                return;
            }
            signingIn = true;
            status.setText("");
            submit.setText(sync ? "正在加载名单…" : "正在登录…");
            submit.setEnabled(false);
            back.setEnabled(false);
            email.setEnabled(false);
            password.setEnabled(false);
            password.setText("");
            getSystemService(InputMethodManager.class).hideSoftInputFromWindow(password.getWindowToken(), 0);

            worker.execute(() -> {
                Plm.Session session = null;
                try {
                    session = plm.login(loginEmail, loginPassword);
                    if (sync) {
                        if (session.user().optInt("must_change") != 0 || session.user().optBoolean("must_change")) {
                            throw new Plm.Failure("请先在 JPLM 网页修改初始密码。");
                        }
                        JSONArray roster = plm.users(session);
                        getPreferences(MODE_PRIVATE).edit().putString("roster", roster.toString()).apply();
                        plm.logout(session.cookie());
                        runOnUiThread(() -> {
                            if (!isDestroyed()) {
                                signingIn = false;
                                showAccounts("");
                            }
                        });
                    } else {
                        Plm.Session signedIn = session;
                        runOnUiThread(() -> {
                            if (!isDestroyed()) startWarehouse(signedIn, status, submit, back, email, password);
                        });
                    }
                } catch (Plm.Failure e) {
                    if (session != null) plm.logout(session.cookie());
                    runOnUiThread(() -> {
                        if (!isDestroyed()) restoreLogin(status, submit, back, email, password, sync, e.getMessage());
                    });
                }
            });
        });
        password.setOnEditorActionListener((view, action, event) -> {
            if (action != EditorInfo.IME_ACTION_GO) return false;
            submit.performClick();
            return true;
        });
        openSystemKeyboard(sync ? email : password);
    }

    private void restoreLogin(TextView status, Button submit, Button back, EditText email, EditText password,
                              boolean sync, String message) {
        signingIn = false;
        status.setText(message);
        submit.setText(sync ? "登录并加载名单" : "进入出入库登记");
        submit.setEnabled(true);
        back.setEnabled(true);
        email.setEnabled(true);
        password.setEnabled(true);
        openSystemKeyboard(password);
    }

    private void startWarehouse(Plm.Session session, TextView status, Button submit, Button back, EditText email,
                                EditText password) {
        CookieManager cookies = CookieManager.getInstance();
        cookies.removeAllCookies(removed -> {
            if (isDestroyed()) return;
            cookies.setCookie(Plm.BASE, session.setCookie(), saved -> {
                if (isDestroyed()) return;
                if (!Boolean.TRUE.equals(saved)) {
                    worker.execute(() -> plm.logout(session.cookie()));
                    restoreLogin(status, submit, back, email, password, false, "无法保存登录会话，请重试。");
                    return;
                }
                signingIn = false;
                showWarehouse(session.name());
            });
        });
    }

    private void showWarehouse(String user) {
        showingPassword = false;
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        LinearLayout content = column();
        content.setBackgroundColor(BACKGROUND);
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(14), dp(6), dp(10), dp(6));
        header.setBackgroundColor(Color.WHITE);
        TextView name = label(user, 19, INK);
        name.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        name.setSingleLine(true);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        header.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button switchUser = button("切换账号", 52, 17, false);
        header.addView(switchUser);
        switchUser.setOnClickListener(view -> confirmSwitch());
        content.addView(header, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        web = new WebView(this) {
            @Override public InputConnection onCreateInputConnection(EditorInfo editor) {
                InputConnection connection = super.onCreateInputConnection(editor);
                int variation = editor.inputType & InputType.TYPE_MASK_VARIATION;
                boolean password = (editor.inputType & InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_TEXT
                        && (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
                        || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
                        || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
                // Warehouse fields use the page keypad and still accept hardware key events.
                return password ? connection : null;
            }
        };
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return request.isForMainFrame() && !isWarehousePage(request.getUrl());
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (isWarehousePage(Uri.parse(url))) {
                    view.evaluateJavascript("(function(){var s=document.getElementById('jplm-android-touch');"
                            + "if(!s){s=document.createElement('style');s.id='jplm-android-touch';"
                            + "document.head.appendChild(s);}s.textContent=" + JSONObject.quote(touchStyle) + ";})()", null);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                boolean video = Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
                if (!video || !isPlmOrigin(request.getOrigin()) || cameraRequest != null || web == null) {
                    request.deny();
                } else if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                } else {
                    cameraRequest = request;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION);
                }
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (cameraRequest == request) cameraRequest = null;
            }
        });
        web.setFocusableInTouchMode(true);
        content.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(content);
        web.requestFocus();
        web.loadUrl(Plm.WAREHOUSE);
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (web != null && !web.hasFocus() && hasWindowFocus()
                && event.getAction() == KeyEvent.ACTION_DOWN && event.isFromSource(InputDevice.SOURCE_KEYBOARD)
                && !event.isCtrlPressed() && !event.isAltPressed() && !event.isMetaPressed()) {
            int character = event.getUnicodeChar();
            if (character >= ' ' && character <= '~') web.requestFocus();
        }
        return super.dispatchKeyEvent(event);
    }

    private static boolean isPlmOrigin(Uri uri) {
        return "https".equals(uri.getScheme()) && "work.makagic.com".equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null;
    }

    private static boolean isWarehousePage(Uri uri) {
        return isPlmOrigin(uri) && "/JPLM/".equals(uri.getPath()) && "warehouse".equals(uri.getFragment());
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != CAMERA_PERMISSION || cameraRequest == null) return;
        PermissionRequest request = cameraRequest;
        cameraRequest = null;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            request.deny();
        }
    }

    private void confirmSwitch() {
        new AlertDialog.Builder(this)
                .setMessage("退出当前账号并返回账号列表？")
                .setNegativeButton("继续登记", null)
                .setPositiveButton("切换账号", (dialog, choice) -> leaveWarehouse())
                .show();
    }

    private void leaveWarehouse() {
        CookieManager cookies = CookieManager.getInstance();
        String cookie = cookies.getCookie(Plm.BASE);
        closeWeb();
        cookies.removeAllCookies(removed -> cookies.flush());
        if (cookie != null) worker.execute(() -> plm.logout(cookie));
        showAccounts("");
    }

    private void closeWeb() {
        if (cameraRequest != null) {
            cameraRequest.deny();
            cameraRequest = null;
        }
        if (web == null) return;
        web.stopLoading();
        ((ViewGroup) web.getParent()).removeView(web);
        web.destroy();
        web = null;
    }

    @Override public void onBackPressed() {
        if (signingIn) return;
        if (web != null) confirmSwitch();
        else if (showingPassword && loadRoster().length() > 0) showAccounts("");
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        closeWeb();
        worker.shutdown();
        super.onDestroy();
    }

    private JSONArray loadRoster() {
        try {
            return new JSONArray(getPreferences(MODE_PRIVATE).getString("roster", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private LinearLayout screen(String title, String subtitle) {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BACKGROUND);
        LinearLayout panel = column();
        panel.setPadding(dp(18), dp(22), dp(18), dp(22));
        TextView heading = label(title, 30, INK);
        heading.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) heading.setAccessibilityHeading(true);
        add(panel, heading, 0, 0);
        add(panel, label(subtitle, 17, MUTED), 0, 7);
        scroll.addView(panel);
        setContentView(scroll);
        return panel;
    }

    private LinearLayout column() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        return view;
    }

    private TextView label(String text, int size, int color) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private EditText edit(String hint, int type) {
        EditText edit = new EditText(this);
        edit.setSingleLine(true);
        edit.setInputType(type);
        edit.setHint(hint);
        edit.setTextSize(22);
        edit.setTextColor(INK);
        edit.setPadding(dp(14), 0, dp(14), 0);
        GradientDrawable border = background(Color.WHITE);
        border.setStroke(dp(1), 0xffa8bbd3);
        edit.setBackground(border);
        edit.setShowSoftInputOnFocus(true);
        edit.setOnClickListener(view -> openSystemKeyboard(edit));
        return edit;
    }

    private void openSystemKeyboard(EditText field) {
        field.requestFocus();
        field.post(() -> {
            if (field.isFocused() && field.isShown()) {
                getSystemService(InputMethodManager.class).showSoftInput(field, 0);
            }
        });
    }

    private Button button(String text, int height, int size, boolean primary) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextSize(size);
        button.setTextColor(primary ? Color.WHITE : INK);
        button.setAllCaps(false);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setMinHeight(dp(height));
        button.setPadding(dp(16), dp(8), dp(16), dp(8));
        button.setBackground(new android.graphics.drawable.RippleDrawable(
                ColorStateList.valueOf(primary ? 0x40ffffff : 0x221858ab),
                background(primary ? BLUE : SECONDARY), null));
        return button;
    }

    private GradientDrawable background(int color) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(dp(10));
        return background;
    }

    private void add(LinearLayout parent, View view, int height, int margin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                height == 0 ? ViewGroup.LayoutParams.WRAP_CONTENT : dp(height));
        params.topMargin = dp(margin);
        parent.addView(view, params);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}

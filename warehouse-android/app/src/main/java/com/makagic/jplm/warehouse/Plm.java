package com.makagic.jplm.warehouse;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;

final class Plm {
    static final String BASE = "https://work.makagic.com/JPLM/";
    static final String WAREHOUSE = BASE + "#warehouse";

    static final class Failure extends Exception {
        Failure(String message) { super(message); }
    }

    record Session(String setCookie, String cookie, JSONObject user) {
        String name() { return user.optString("name"); }
    }

    private record Response(Object body, List<String> cookies) {}

    Session login(String email, String password) throws Failure {
        JSONObject data = new JSONObject();
        try {
            data.put("email", email);
            data.put("password", password);
        } catch (JSONException e) {
            throw new Failure("无法读取登录信息。");
        }
        Response response = request("auth/login", null, data);
        String setCookie = response.cookies.stream()
                .filter(value -> value.startsWith("plm_session_") || value.startsWith("plm_session="))
                .findFirst()
                .orElseThrow(() -> new Failure("登录会话建立失败，请重试。"));
        String cookie = setCookie.split(";", 2)[0];
        try {
            Object body = request("auth/status", cookie, null).body;
            if (!(body instanceof JSONObject status)) throw new Failure("无法读取 JPLM 登录状态。");
            JSONObject user = status.optJSONObject("user");
            if (!status.optBoolean("authenticated") || user == null) {
                throw new Failure("登录会话建立失败，请重试。");
            }
            return new Session(setCookie, cookie, user);
        } catch (Failure e) {
            logout(cookie);
            throw e;
        }
    }

    JSONArray users(Session session) throws Failure {
        Object body = request("users", session.cookie, null).body;
        if (!(body instanceof JSONArray rows)) throw new Failure("无法读取 JPLM 账号名单。");
        JSONArray result = new JSONArray();
        try {
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                String name = row.getString("name");
                String email = row.getString("email");
                if (!name.trim().isEmpty() && !email.trim().isEmpty()) {
                    result.put(new JSONObject().put("name", name).put("email", email));
                }
            }
        } catch (JSONException e) {
            throw new Failure("JPLM 账号名单格式有误。");
        }
        if (result.length() == 0) throw new Failure("JPLM 没有可用账号。");
        return result;
    }

    void logout(String cookie) {
        try {
            request("auth/logout", cookie, new JSONObject());
        } catch (Failure ignored) {
            // Local access to the session is removed even if the server is unreachable.
        }
    }

    private Response request(String path, String cookie, JSONObject data) throws Failure {
        HttpsURLConnection connection = null;
        try {
            connection = (HttpsURLConnection) new URL(BASE + "api/" + path).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(12000);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            if (cookie != null) connection.setRequestProperty("Cookie", cookie);
            if (data != null) {
                byte[] bytes = data.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(bytes);
                }
            }
            int status = connection.getResponseCode();
            boolean ok = status >= 200 && status < 300;
            Object body;
            try (InputStream input = ok ? connection.getInputStream() : connection.getErrorStream()) {
                body = input == null ? null : new JSONTokener(readBody(input)).nextValue();
            } catch (JSONException e) {
                body = null;
            }
            if (!ok) {
                String message = body instanceof JSONObject error ? error.optString("error") : "";
                throw new Failure(message.trim().isEmpty() ? "JPLM 请求失败（" + status + "）。" : message);
            }
            if (body == null) throw new Failure("无法读取 JPLM 响应。");
            List<String> cookies = Collections.emptyList();
            for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
                if ("Set-Cookie".equalsIgnoreCase(header.getKey())) cookies = header.getValue();
            }
            return new Response(body, cookies);
        } catch (IOException e) {
            throw new Failure("无法连接 JPLM，请检查网络后重试。");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readBody(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int size;
        while ((size = input.read(buffer)) != -1) {
            if (output.size() + size > 2 * 1024 * 1024) throw new IOException("Response too large");
            output.write(buffer, 0, size);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }
}

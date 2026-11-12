"""PLM transport and the device's locally provisioned account list."""
import http.cookiejar
import json
import os
from pathlib import Path
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, Request, build_opener

BASE_URL = "https://work.makagic.com/JPLM/"
ROSTER = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "jplm-warehouse" / "users.json"


class ApiError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class PLM:
    def __init__(self, base=BASE_URL):
        self.base = base
        self.cookies = http.cookiejar.CookieJar()
        self.opener = build_opener(NoRedirect(), HTTPCookieProcessor(self.cookies))

    def request(self, path, method="GET", data=None, *, image=False):
        req = Request(
            self.base + ("" if image else "api/") + path,
            data=None if data is None else json.dumps(data).encode(),
            headers={"Content-Type": "application/json"},
            method=method,
        )
        try:
            with self.opener.open(req, timeout=8) as response:
                if image:
                    return response.read(5 * 1024 * 1024)
                return json.load(response)
        except HTTPError as exc:
            with exc:
                try:
                    message = json.load(exc).get("error")
                except (ValueError, AttributeError):
                    message = None
            raise ApiError(message or f"PLM 请求失败（{exc.code}）", exc.code) from exc
        except (OSError, URLError) as exc:
            raise ApiError("无法连接 PLM。请检查网络后重试。") from exc
        except ValueError as exc:
            raise ApiError("PLM 返回的数据无法读取。") from exc

    def login(self, email, password):
        self.cookies.clear()
        self.request("auth/login", "POST", {"email": email, "password": password})
        user = self.request("auth/status")["user"]
        if not user:
            raise ApiError("登录会话建立失败，请重试。")
        return user

    def logout(self):
        try:
            self.request("auth/logout", "POST")
        finally:
            self.cookies.clear()


def load_roster():
    try:
        return json.loads(ROSTER.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def save_roster(users):
    roster = [{"name": user["name"], "email": user["email"]} for user in users]
    ROSTER.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=ROSTER.parent, delete=False) as output:
        temporary = Path(output.name)
    try:
        temporary.write_text(json.dumps(roster, ensure_ascii=False), encoding="utf-8")
        temporary.replace(ROSTER)
    finally:
        temporary.unlink(missing_ok=True)

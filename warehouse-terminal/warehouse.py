#!/usr/bin/env python3
"""Touch-first desktop client for the JPLM warehouse workflow."""
from datetime import datetime
import logging
from pathlib import Path
import re
from threading import Thread
from time import monotonic
from urllib.parse import urlencode
from uuid import uuid4

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk

from plm import ApiError, PLM, load_roster, save_roster

ROOT = Path(__file__).resolve().parent
SCAN = re.compile(r"JC\d{6}|https?://\S+#(?:projects/[^/]+/)?parts/[a-f0-9]{24}", re.I)
QUANTITY = re.compile(r"[0-9]{1,10}(?:\.[0-9]{0,6})?")
ACTIONS = (("出库", "blue"), ("入库", "green"), ("报废", "warn"))
NUMBER_KEYS = ("123", "456", "789", ("删除", "0", "确认"))
SCAN_PAUSE_MS = 150
SCAN_KEY_GAP = 0.055


def box(vertical=True, spacing=10):
    return Gtk.Box(orientation=Gtk.Orientation.VERTICAL if vertical else Gtk.Orientation.HORIZONTAL, spacing=spacing)


def label(text, style=None):
    item = Gtk.Label(label=text, xalign=0, wrap=True)
    if style:
        item.get_style_context().add_class(style)
    return item


def button(text, action, style=None):
    item = Gtk.Button(label=text)
    item.set_focus_on_click(False)
    item.connect("clicked", lambda _: action())
    for name in (style or "").split():
        item.get_style_context().add_class(name)
    return item


def number(value):
    return f"{value:,.6f}".rstrip("0").rstrip(".")


def scroller(content):
    scroll = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER)
    scroll.add(content)
    return scroll


def type_key(entry, value):
    if not entry.has_focus():
        entry.grab_focus_without_selecting()
    text = entry.get_text()
    start = end = entry.get_position()
    selected = entry.get_selection_bounds()
    if selected:
        start, end = sorted(selected)
    if value == "⌫":
        if not selected:
            start = max(0, start - 1)
        value = ""
    limit = entry.get_max_length()
    if limit and len(text) - (end - start) + len(value) > limit:
        return
    entry.set_text(text[:start] + value + text[end:])
    entry.set_position(start + len(value))


def keypad(entry, rows, *, confirm=None):
    large = confirm is not None
    grid = Gtk.Grid(column_homogeneous=True, row_homogeneous=large, column_spacing=8, row_spacing=8)
    for row_index, row in enumerate(rows):
        for column, key in enumerate(row):
            style = "key large-key" if large else "key"
            value = "⌫" if key == "删除" else key
            action = confirm if key == "确认" else lambda value=value: type_key(entry, value)
            if key in ("删除", "确认"):
                style += " key-command"
            if key == "确认":
                style += " blue"
            item = button(key, action, style)
            item.set_hexpand(large)
            item.set_vexpand(large)
            grid.attach(item, column, row_index, 1, 1)
    return grid


class Terminal(Gtk.Application):
    def __init__(self, api=None, roster_loader=load_roster):
        super().__init__(application_id="com.makagic.jplm.warehouse")
        self.api = api or PLM()
        self.roster_loader = roster_loader
        self.window = None
        self.user = None
        self.busy = False
        self.scan_enabled = False
        self.scan_timer = 0
        self.scan_buffer = ""
        self.scan_focus = None
        self.scan_last = 0
        self.scan_fast = True
        self.pending = None
        self.history_open = False
        self.history_rows = None

    def do_activate(self):
        if self.window:
            self.window.present()
            return
        provider = Gtk.CssProvider()
        provider.load_from_path(str(ROOT / "terminal.css"))
        Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        self.window = Gtk.ApplicationWindow(application=self, title="出入库登记", default_width=960, default_height=530)
        self.window.set_icon_from_file(str(ROOT / "warehouse.png"))
        self.window.connect("key-press-event", self.scanner_key)
        self.window.maximize()
        self.accounts()

    def page(self, heading, actions=(), *, warehouse=False):
        self.clear_scan()
        self.scan_enabled = warehouse
        self.search_entry = None
        self.quantity_entry = None
        self.displayed_part = None
        self.history_open = False
        previous = self.window.get_child()
        if previous:
            self.window.remove(previous)
            previous.destroy()
        root = box(spacing=12)
        root.set_border_width(18)
        self.window.add(root)
        header = box(False)
        header.pack_start(label(heading, "heading"), True, True, 0)
        if warehouse:
            self.history_toggle = button("我的出入库记录", self.toggle_history, "toolbar history-toggle")
            header.pack_start(self.history_toggle, False, False, 0)
        for title, action in actions:
            header.pack_start(button(title, action, "toolbar"), False, False, 0)
        root.pack_start(header, False, False, 0)
        self.body = box(spacing=12)
        if warehouse:
            self.warehouse_views = Gtk.Stack(hhomogeneous=False, vhomogeneous=False)
            self.warehouse_views.add_named(scroller(self.body), "registration")
            self.history_items = box(spacing=8)
            self.warehouse_views.add_named(scroller(self.history_items), "history")
            root.pack_start(self.warehouse_views, True, True, 0)
        else:
            root.pack_start(self.body, True, True, 0)
        self.status = label("", "status")
        root.pack_end(self.status, False, False, 0)

    def input_columns(self, entry, confirm):
        layout = Gtk.Grid(column_homogeneous=True, column_spacing=14)
        controls = box(spacing=12)
        layout.attach(controls, 0, 0, 2, 1)
        layout.attach(keypad(entry, NUMBER_KEYS, confirm=confirm), 2, 0, 3, 1)
        self.body.pack_start(layout, True, True, 0)
        return controls

    def clear_entry(self, entry):
        self.clear_scan()
        entry.set_text("")
        entry.grab_focus_without_selecting()

    def show(self, focus=None, message=""):
        self.window.show_all()
        self.status.set_text(message)
        if focus:
            focus.grab_focus()

    def run_task(self, work, done, *, error=None, message="处理中…", preserve_401=False):
        if self.busy:
            return
        self.busy = True
        self.window.set_sensitive(False)
        self.status.set_text(message)

        def finish(result, failure):
            self.busy = False
            if not self.window.get_realized():
                return False
            self.window.set_sensitive(True)
            self.status.set_text("")
            if failure is None:
                done(result)
            elif isinstance(failure, ApiError) and failure.status == 401 and self.user and not preserve_401:
                self.api.cookies.clear()
                self.accounts("登录已过期，请重新选择人员。")
            elif error:
                error(str(failure))
            else:
                self.status.set_text(str(failure))
            return False

        def worker():
            try:
                result = work()
            except (ApiError, OSError) as failure:
                GLib.idle_add(finish, None, failure)
            except Exception:
                logging.exception("Warehouse request failed")
                GLib.idle_add(finish, None, ApiError("处理失败，请重试。"))
            else:
                GLib.idle_add(finish, result, None)

        Thread(target=worker, daemon=True).start()

    def accounts(self, message=""):
        self.user = None
        self.pending = None
        self.history_rows = None
        self.page("出入库登记")
        self.body.pack_start(label("请选择操作员", "subheading"), False, False, 0)
        grid = Gtk.Grid(column_homogeneous=True, column_spacing=14, row_spacing=14)
        users = self.roster_loader()
        for index, user in enumerate(users):
            grid.attach(button(user["name"], lambda user=user: self.password(user), "account"), index % 2, index // 2, 1, 1)
        self.body.pack_start(scroller(grid), True, True, 0)
        self.show(message=message or ("" if users else "账号名单尚未同步，请联系管理员。"))

    def password(self, account):
        self.page("登录 · " + account["name"], (("返回选人", self.accounts),))
        entry = Gtk.Entry(visibility=False, placeholder_text="输入 PLM 密码", activates_default=False)
        entry.set_input_purpose(Gtk.InputPurpose.PASSWORD)
        self.body.pack_start(entry, False, False, 0)
        rows = ("1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm")
        symbols = ("!@#$%^&*()", "~`-_=+[]{}", "\\|;:'\",.<>/?")
        keyboards = Gtk.Stack()
        for name, chars in (("小写", rows), ("大写", tuple(row.upper() for row in rows)), ("符号", symbols)):
            keyboards.add_named(keypad(entry, chars), name)
        self.body.pack_start(keyboards, False, False, 0)
        controls = box(False)
        for name in ("小写", "大写", "符号"):
            controls.pack_start(button(name, lambda name=name: keyboards.set_visible_child_name(name)), False, False, 0)
        controls.pack_start(button("空格", lambda: type_key(entry, " ")), True, True, 0)
        controls.pack_start(button("⌫", lambda: type_key(entry, "⌫")), False, False, 0)
        controls.pack_end(button("登录", lambda: submit(), "blue"), False, False, 0)
        self.body.pack_start(controls, False, False, 0)

        def submit():
            password = entry.get_text()
            if not password or self.busy:
                return
            entry.set_text("")
            self.run_task(
                lambda: self.api.login(account["email"], password), self.signed_in,
                error=lambda message: (self.status.set_text(message), entry.grab_focus()), message="正在登录…",
            )

        entry.connect("activate", lambda _: submit())
        self.show(entry)

    def signed_in(self, user):
        self.user = user
        if user.get("must_change"):
            self.run_task(
                self.api.logout,
                lambda _: self.accounts("请先在 PLM 网页修改初始密码，再来本机登录。"),
                error=lambda _: self.accounts("请先在 PLM 网页修改初始密码，再来本机登录。"),
            )
            return
        self.search()

    def sign_out(self):
        self.run_task(self.api.logout, lambda _: self.accounts(), error=lambda _: self.accounts())

    def sync_roster(self):
        def sync():
            save_roster(self.api.request("users"))

        self.run_task(sync, lambda _: self.search("账号名单已同步。"), message="正在同步账号…")

    def search(self, message="", seed=""):
        self.pending = None
        actions = [("换人", self.sign_out)]
        if self.user.get("role") == "admin":
            actions.insert(0, ("同步账号", self.sync_roster))
        self.page("出入库登记 · " + self.user["name"], actions, warehouse=True)
        entry = self.search_entry = Gtk.Entry(placeholder_text="扫码或输入编号数字", max_length=1000)
        entry.set_text(seed)

        def query():
            self.lookup(entry.get_text())

        controls = self.input_columns(entry, query)
        controls.pack_start(label("扫码或输入料号", "subheading"), False, False, 0)
        controls.pack_start(entry, False, False, 0)
        controls.pack_start(button("清空", lambda: self.clear_entry(entry)), False, False, 0)
        controls.pack_start(button("查询", query, "blue primary-operation"), False, False, 0)
        entry.connect("activate", lambda _: query())
        self.show(entry, message)

    def clear_scan(self):
        if self.scan_timer:
            GLib.source_remove(self.scan_timer)
            self.scan_timer = 0
        self.scan_buffer = ""
        self.scan_focus = None
        self.scan_fast = True

    def finish_scan(self, terminated=False):
        code = self.scan_buffer
        focus = self.scan_focus
        scanned = SCAN.fullmatch(code) or (
            terminated and self.scan_fast and len(code) >= 4
        )
        self.clear_scan()
        if scanned:
            self.lookup(code, exact=not code.isdecimal())
            return True
        if focus is self.window.get_focus() and focus is not None:
            if focus is self.search_entry or (focus is self.quantity_entry and re.fullmatch(r"[0-9.]+", code)):
                type_key(focus, code)
        return False

    def scan_idle(self):
        self.scan_timer = 0
        self.finish_scan()
        return False

    def scanner_key(self, _, event):
        if not self.scan_enabled or self.busy:
            return False
        suffix = event.keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter, Gdk.KEY_Tab)
        if suffix and self.scan_buffer:
            return self.finish_scan(terminated=True)
        modifiers = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.MOD1_MASK | Gdk.ModifierType.SUPER_MASK
        character = Gdk.keyval_to_unicode(event.keyval)
        if event.state & modifiers or not 32 <= character <= 126:
            if self.scan_buffer:
                self.finish_scan()
            return False

        now = monotonic()
        if self.scan_buffer:
            self.scan_fast = self.scan_fast and now - self.scan_last <= SCAN_KEY_GAP
            GLib.source_remove(self.scan_timer)
        else:
            self.scan_focus = self.window.get_focus()
        self.scan_last = now
        self.scan_buffer += chr(character)
        self.scan_timer = GLib.timeout_add(SCAN_PAUSE_MS, self.scan_idle)
        return True

    def lookup(self, value, exact=False):
        term = value.strip()
        if not term or self.busy:
            return
        self.clear_scan()
        exact = exact or term.startswith(("http://", "https://"))
        query = {"q": term} if exact else {"q": term, "fuzzy": "1"}

        def found(result):
            rows = [result] if exact else result["rows"]
            if len(rows) == 1:
                self.material(rows[0])
            elif rows:
                self.matches(rows, term)
            else:
                self.status.set_text("没有找到匹配物料。")

        self.run_task(lambda: self.api.request("warehouse/material?" + urlencode(query)), found,
                      message="正在查询物料…")

    def matches(self, rows, term):
        self.page("请选择物料", (("返回查询", lambda: self.search(seed=term)),), warehouse=True)
        for part in rows:
            description = " · ".join(filter(None, (part["code"], part["name"], part["spec"], part["project_name"])))
            self.body.pack_start(button(description, lambda part=part: self.material(part)), False, False, 0)
        self.show()

    def material(self, part, kind=None):
        self.pending = None
        self.page("出入库登记", (("重新扫码", self.search),), warehouse=True)
        self.displayed_part = part
        detail = box(vertical=bool(kind), spacing=12)
        detail.get_style_context().add_class("card")
        description = box(spacing=5)
        description.pack_start(label(part["code"] + "   " + part["name"], "subheading"), False, False, 0)
        description.pack_start(label(" · ".join(filter(None, (part["project_name"], part["spec"], part["location"])))), False, False, 0)
        image = Gtk.Image()
        if part.get("image_id") and not kind:
            detail.pack_start(image, False, False, 0)
        detail.pack_start(description, True, True, 0)
        self.stock_label = label(self.stock_text(part), "stock")
        detail.pack_start(self.stock_label, False, False, 0)
        if not kind:
            self.body.pack_start(detail, False, False, 0)
            actions = box(False, spacing=14)
            for title, tone in ACTIONS:
                actions.pack_start(button(title, lambda title=title: self.material(part, title), "action " + tone), True, True, 0)
            self.body.pack_start(actions, False, False, 0)
            self.show()
            if part.get("image_id"):
                self.material_image(part["image_id"], image)
            return

        entry = self.quantity_entry = Gtk.Entry(placeholder_text=f"输入{kind}数量（{part['unit']}）", max_length=18)

        def confirm():
            self.register(part, kind, entry)

        controls = self.input_columns(entry, confirm)
        controls.pack_start(detail, False, False, 0)
        controls.pack_start(entry, False, False, 0)
        edit = box(False)
        edit.pack_start(button("小数点 .", lambda: type_key(entry, ".")), True, True, 0)
        edit.pack_start(button("清空", lambda: self.clear_entry(entry)), True, True, 0)
        controls.pack_start(edit, False, False, 0)
        controls.pack_start(button("返回", lambda: self.material(part)), False, False, 0)
        controls.pack_start(button("确认" + kind, confirm, "blue primary-operation"), False, False, 0)
        self.show(entry)

    @staticmethod
    def stock_text(part):
        return "当前库存\n" + number(part["stock"]) + " " + part["unit"]

    def material_image(self, image_id, image):
        if not re.fullmatch(r"[a-f0-9]{24}", image_id):
            return

        def display(data):
            if image.get_parent() is not None:
                try:
                    loader = GdkPixbuf.PixbufLoader()
                    loader.connect("size-prepared", lambda p, w, h: p.set_size(max(1, 64 * w // max(w, h)), max(1, 64 * h // max(w, h))))
                    loader.write(data)
                    loader.close()
                    image.set_from_pixbuf(loader.get_pixbuf())
                except GLib.Error:
                    pass
            return False

        # Copy the cookie jar so an image fetch never races login or logout.
        client = PLM(self.api.base)
        for cookie in self.api.cookies:
            client.cookies.set_cookie(cookie)

        def fetch():
            try:
                data = client.request("files/" + image_id, image=True)
            except ApiError:
                return
            GLib.idle_add(display, data)

        Thread(target=fetch, daemon=True).start()

    def register(self, part, kind, entry):
        value = entry.get_text().strip()
        if not QUANTITY.fullmatch(value) or not 0 < float(value) <= 1e9:
            self.status.set_text("请输入大于 0 的有效数量，最多 6 位小数。")
            return
        qty = float(value)
        if self.pending is None or self.pending[0] != qty:
            self.pending = (qty, uuid4().hex)
        data = dict(project_id=part["project_id"], part_id=part["id"], type=kind, qty=qty, request_id=self.pending[1])

        def registered(result):
            unit = part["unit"]
            self.history_rows = None
            self.search(f"已登记 {part['name']} · {kind} {number(qty)} {unit} · 结余 {number(result['stock'])} {unit}")

        self.run_task(lambda: self.api.request("warehouse/movements", "POST", data), registered, message="正在登记…")

    def toggle_history(self):
        self.history_open = not self.history_open
        if self.history_open:
            self.history_toggle.set_label("返回登记")
            self.warehouse_views.set_visible_child_name("history")
            self.load_history()
        else:
            self.history_toggle.set_label("我的出入库记录")
            self.warehouse_views.set_visible_child_name("registration")
            entry = self.search_entry or self.quantity_entry
            if entry:
                entry.grab_focus_without_selecting()

    def load_history(self):
        message = self.status.get_text()
        self.show_history("正在读取记录…")

        def loaded(rows):
            self.history_rows = rows
            self.status.set_text(message)
            self.show_history()

        def failed(reason):
            self.status.set_text(message)
            self.show_history(reason)

        self.run_task(lambda: self.api.request("warehouse/movements"), loaded, error=failed,
                      message="正在读取记录…")

    def show_history(self, notice=None):
        for child in self.history_items.get_children():
            child.destroy()
        if notice or not self.history_rows:
            self.history_items.pack_start(label(notice or "暂无登记记录"), False, False, 6)
            self.history_items.show_all()
            return
        for row in self.history_rows:
            item = box(False)
            item.get_style_context().add_class("card")
            details = box(spacing=3)
            details.pack_start(label(f"{row['type']} {number(row['qty'])} {row['unit']} · {row['part_name']}", "subheading"), False, False, 0)
            timestamp = datetime.fromisoformat(row["created_at"]).astimezone().strftime("%m-%d %H:%M")
            details.pack_start(label(f"{timestamp} · {row['part_code']} · {row['project_name']}"), False, False, 0)
            item.pack_start(details, True, True, 0)
            if row["can_delete"]:
                item.pack_start(button("删除", lambda row=row: self.confirm_delete(row), "warn"), False, False, 0)
            self.history_items.pack_start(item, False, False, 0)
        self.history_items.show_all()

    def confirm_delete(self, row):
        dialog = Gtk.MessageDialog(transient_for=self.window, modal=True, message_type=Gtk.MessageType.WARNING,
                                   text=f"删除 {row['part_name']} 的{row['type']}记录？", secondary_text="删除后会重新计算库存。")
        dialog.add_button("取消", Gtk.ResponseType.CANCEL)
        dialog.add_button("确认删除", Gtk.ResponseType.OK)
        response = dialog.run()
        dialog.destroy()
        if response == Gtk.ResponseType.OK:
            data = {key: row[key] for key in ("project_id", "expected")}

            def deleted(result):
                part = self.displayed_part
                if part and part["id"] == result["part_id"]:
                    part["stock"] = result["stock"]
                    self.stock_label.set_text(self.stock_text(part))
                self.history_rows = None
                self.status.set_text(f"记录已删除 · 结余 {number(result['stock'])} {row['unit']}")
                self.load_history()

            self.run_task(lambda: self.api.request("warehouse/movements/" + row["id"], "DELETE", data),
                          deleted)


if __name__ == "__main__":
    raise SystemExit(Terminal().run())

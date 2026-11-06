#!/usr/bin/env python3
"""在服务器本机管理 JPLM 数据。手动清理前请停止服务。"""
import argparse
import getpass
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'server'))
import app

parser = argparse.ArgumentParser(description='捷程未来PLM 本机管理')
parser.add_argument('command', choices=['reset-password', 'cleanup-files'])
parser.add_argument('--email', help='要重置密码的账户邮箱')
parser.add_argument('--data-dir', default=os.environ.get('PLM_DATA_DIR', str(ROOT / 'data')))
args = parser.parse_args()
app.DATA = Path(args.data_dir).resolve()
if not (app.DATA / 'plm.sqlite3').is_file():
    raise SystemExit('数据库不存在，请核对 --data-dir')
if args.command == 'cleanup-files':
    print(f'已清理 {app.cleanup_orphan_images()} 张超过保留期的无引用图片。')
    raise SystemExit(0)
if not args.email:
    parser.error('重置密码需要 --email')
password = getpass.getpass('临时密码（至少 10 个字符）：')
if password != getpass.getpass('再次输入：'):
    raise SystemExit('两次密码不一致')
try:
    record = app.password_record(password)
    with app.transaction() as db:
        user = db.execute('SELECT id FROM users WHERE email=?', (app.account_email(args.email),)).fetchone()
        if not user:
            raise SystemExit('未找到此邮箱对应的账户')
        db.execute('UPDATE users SET password=?,must_change=1 WHERE id=?', (record, user['id']))
        db.execute('DELETE FROM sessions WHERE user_id=?', (user['id'],))
except app.Problem as exc:
    raise SystemExit(exc.message)
print('密码已重置，已有会话已失效。')

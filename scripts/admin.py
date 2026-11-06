#!/usr/bin/env python3
"""服务器本机管理工具。重置密码需要停止服务后由服务器管理员执行。"""
import argparse, getpass, hashlib, json, os, secrets, sqlite3
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser(description='捷程未来PLM 本机管理')
parser.add_argument('command',choices=['reset-password','cleanup-files'])
parser.add_argument('--data-dir',default=os.environ.get('PLM_DATA_DIR',str(ROOT/'data')))
args=parser.parse_args();data=Path(args.data_dir).resolve()
if not (data/'plm.sqlite3').is_file():raise SystemExit('数据库不存在，请核对 --data-dir')
db=sqlite3.connect(data/'plm.sqlite3');db.execute('BEGIN IMMEDIATE')
try:
    if args.command=='reset-password':
        a=getpass.getpass('新管理员密码（至少 10 个字符）：');b=getpass.getpass('再次输入：')
        if a!=b or not 10<=len(a)<=256:raise SystemExit('两次密码不一致，或长度不符合要求')
        salt=secrets.token_hex(16);hashed=hashlib.pbkdf2_hmac('sha256',a.encode(),bytes.fromhex(salt),310000).hex()
        db.execute("INSERT INTO settings VALUES('password',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(json.dumps({'salt':salt,'hash':hashed}),))
        db.execute('DELETE FROM sessions');db.commit();print('密码已重置，已有会话已失效。')
    else:
        referenced={r[0] for r in db.execute('SELECT id FROM files')};removed=0
        for file in (data/'uploads').iterdir():
            if file.is_file() and file.name not in referenced:file.unlink();removed+=1
        db.commit();print(f'已清理 {removed} 个未被引用的遗留文件。')
finally:db.close()

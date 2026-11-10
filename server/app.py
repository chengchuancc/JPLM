#!/usr/bin/env python3
"""捷程未来PLM：仅依赖 Python 3.10+ 标准库。"""
import argparse, hashlib, hmac, io, json, math, mimetypes, os, re, secrets, sqlite3, sys, time, threading, shutil, tempfile, zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer as BaseThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse, unquote
from electronic_import import parse_electronic_file, ElectronicBomError
import inspection
import shipping
from projects import (
    VERSION, PROJECT_VERSION, LEGACY_PROJECT_ID, BUSINESS_TABLES,
    SCOPED_TABLES, COVER_TABLE, migrate_projects,
)

ROOT = Path(__file__).resolve().parent.parent
BASE_PATH = os.environ.get("PLM_BASE_PATH", "").rstrip("/")
SESSION_COOKIE = ('plm_session_' + hashlib.sha256(BASE_PATH.encode()).hexdigest()[:8]
                  if BASE_PATH else 'plm_session')
DATA = Path(os.environ.get('PLM_DATA_DIR', str(ROOT / 'data'))).resolve()
MAX_UPLOAD = 20 * 1024 * 1024
MAX_COVER = 4 * 1024 * 1024
MAX_RESTORE = 1024 ** 3
FILE_LOCK = threading.RLock()
IMAGE_MIMES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
}
UPLOAD_ID = re.compile(r'[0-9a-f]{24}')
CLEANUP_INTERVAL = 24 * 60 * 60
ORPHAN_IMAGE_GRACE = 7 * CLEANUP_INTERVAL
QUOTES_SCHEMA = """CREATE TABLE IF NOT EXISTS quotes(
    id TEXT PRIMARY KEY,
    part_id TEXT NOT NULL REFERENCES parts(id),
    supplier_id TEXT NOT NULL REFERENCES suppliers(id),
    price REAL CHECK(price >= 0),
    url TEXT NOT NULL DEFAULT '',
    UNIQUE(part_id, supplier_id)
);"""
SCHEMA = '''
CREATE TABLE IF NOT EXISTS import_runs(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('admin','member')), phone TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 0 CHECK(must_change IN (0,1)),
    avatar BLOB, avatar_mime TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires REAL NOT NULL,user_id TEXT REFERENCES users(id));
CREATE TABLE IF NOT EXISTS activity(
    id INTEGER PRIMARY KEY, actor_id TEXT, actor_name TEXT NOT NULL,
    action TEXT NOT NULL, subject_id TEXT NOT NULL, subject TEXT NOT NULL,
    detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppliers(id TEXT PRIMARY KEY,name TEXT NOT NULL,contact TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',address TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '研发中',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS parts(id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,name TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('结构物料','电子物料')),spec TEXT NOT NULL DEFAULT '',unit TEXT NOT NULL DEFAULT 'PCS',price REAL NOT NULL DEFAULT 0 CHECK(price>=0),stock REAL NOT NULL DEFAULT 0 CHECK(stock>=0),min_stock REAL NOT NULL DEFAULT 0 CHECK(min_stock>=0),location TEXT NOT NULL DEFAULT '',sub_product_id TEXT REFERENCES products(id),notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS material_links(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,child_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,qty REAL NOT NULL DEFAULT 1 CHECK(qty>0),created_at TEXT NOT NULL,UNIQUE(parent_id,child_id),CHECK(parent_id<>child_id));
CREATE TABLE IF NOT EXISTS material_code_aliases(code TEXT PRIMARY KEY,part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_material_links_child ON material_links(child_id);

CREATE TABLE IF NOT EXISTS bom_versions(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),name TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,UNIQUE(product_id,name));
CREATE TABLE IF NOT EXISTS bom_lines(id TEXT PRIMARY KEY,version_id TEXT NOT NULL REFERENCES bom_versions(id) ON DELETE CASCADE,part_id TEXT NOT NULL REFERENCES parts(id),qty REAL NOT NULL CHECK(qty>0),reference TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',UNIQUE(version_id,part_id));
CREATE TABLE IF NOT EXISTS purchases(id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,supplier_id TEXT NOT NULL REFERENCES suppliers(id),date TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS purchase_lines(id TEXT PRIMARY KEY,purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,part_id TEXT NOT NULL REFERENCES parts(id),qty REAL NOT NULL CHECK(qty>0),price REAL NOT NULL CHECK(price>=0),received REAL NOT NULL DEFAULT 0 CHECK(received>=0 AND received<=qty),UNIQUE(purchase_id,part_id));
CREATE TABLE IF NOT EXISTS movements(id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,type TEXT NOT NULL CHECK(type IN ('入库','出库','退库','报废')),part_id TEXT NOT NULL REFERENCES parts(id),qty REAL NOT NULL CHECK(qty>0),balance REAL NOT NULL CHECK(balance>=0),product_id TEXT REFERENCES products(id),purchase_line_id TEXT REFERENCES purchase_lines(id),original_id TEXT REFERENCES movements(id),reason TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,owner_type TEXT NOT NULL CHECK(owner_type IN ('products','parts')),owner_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_movements_part ON movements(part_id);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_type,owner_id);
'''

class Problem(Exception):
    def __init__(self, message, status=400): self.message, self.status = message, status

def now(): return datetime.now(timezone.utc).isoformat()
def uid(): return secrets.token_hex(12)
def num(value, positive=False):
    try: n = float(value)
    except (TypeError, ValueError): raise Problem('请输入有效数字')
    if not math.isfinite(n) or n < 0 or n > 1e9 or (positive and n == 0): raise Problem('数量或价格超出有效范围')
    rounded=round(n,6)
    if positive and rounded<=0: raise Problem('数量至少为 0.000001')
    return rounded
def required(v, label='名称'):
    s = str(v or '').strip()
    if not s: raise Problem(f'请填写{label}')
    if len(s) > 1000: raise Problem(f'{label}过长')
    return s

def init_db(directory=None, bootstrap=None):
    directory = DATA if directory is None else directory
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'uploads').mkdir(exist_ok=True)
    with connect(directory) as db:
        version = db.execute('PRAGMA user_version').fetchone()[0]
        if version > VERSION:
            raise RuntimeError('数据库版本高于当前程序版本')
        if version == VERSION:
            if bootstrap:
                if db.execute('SELECT 1 FROM users LIMIT 1').fetchone():
                    raise Problem('管理员已初始化')
                create_account(db, bootstrap, 'admin')
            return
    if version < 8 or (version == 8 and bootstrap):
        init_legacy_db(directory, bootstrap)
    with connect(directory) as db:
        if version < PROJECT_VERSION:
            migrate_projects(db, now())
        db.execute('BEGIN IMMEDIATE')
        db.execute(COVER_TABLE)
        if 'deleted_at' not in {row['name'] for row in db.execute('PRAGMA table_info(projects)')}:
            db.execute('ALTER TABLE projects ADD COLUMN deleted_at TEXT '
                       'CHECK(deleted_at IS NULL OR archived_at IS NOT NULL)')
        for statement in (*inspection.SCHEMA, *shipping.SCHEMA):
            db.execute(statement)
        if 'deleted_at' not in {row['name'] for row in db.execute('PRAGMA table_info(inspection_records)')}:
            db.execute('ALTER TABLE inspection_records ADD COLUMN deleted_at TEXT')
        if version == 12:
            inspection.backfill_from_records(db)
        db.execute(f'PRAGMA user_version={VERSION}')
        if bootstrap and version >= PROJECT_VERSION:
            if db.execute('SELECT 1 FROM users LIMIT 1').fetchone():
                raise Problem('管理员已初始化')
            create_account(db, bootstrap, 'admin')

def init_legacy_db(directory=None, bootstrap=None):
    directory = DATA if directory is None else directory
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'uploads').mkdir(exist_ok=True)
    with connect(directory) as db:
        db.executescript(SCHEMA + QUOTES_SCHEMA)
        columns={r[1] for r in db.execute('PRAGMA table_info(parts)')}
        product_columns={r[1] for r in db.execute('PRAGMA table_info(products)')}
        version=db.execute('PRAGMA user_version').fetchone()[0]
        if version>8: raise RuntimeError('数据库版本高于当前程序版本')
        if version<5 and (db.execute('SELECT 1 FROM parts LIMIT 1').fetchone() or db.execute('SELECT 1 FROM products LIMIT 1').fetchone()):
            backup_path=directory/'plm.before-v5.sqlite3'
            if not backup_path.exists():
                backup=sqlite3.connect(backup_path)
                try: db.backup(backup)
                finally: backup.close()
        if version == 5:
            backup_path = directory / 'plm.before-v6.sqlite3'
            if not backup_path.exists():
                backup = sqlite3.connect(backup_path)
                try:
                    db.backup(backup)
                finally:
                    backup.close()
        if version == 6 and not (directory / 'plm.before-v7.sqlite3').exists():
            with sqlite3.connect(directory / 'plm.before-v7.sqlite3', factory=ClosingConnection) as target:
                db.backup(target)
        if version == 7 and not (directory / 'plm.before-v8.sqlite3').exists():
            with sqlite3.connect(directory / 'plm.before-v8.sqlite3', factory=ClosingConnection) as target:
                db.backup(target)
        db.execute('BEGIN IMMEDIATE')
        if 'deleted_at' not in columns:
            db.execute('ALTER TABLE parts ADD COLUMN deleted_at TEXT')
        if 'material_level' not in columns:
            db.execute('ALTER TABLE parts ADD COLUMN material_level INTEGER NOT NULL DEFAULT 1 CHECK(material_level IN (1,2))')
            db.execute("UPDATE parts SET material_level=CASE WHEN category='电子物料' AND sub_product_id IS NULL THEN 2 ELSE 1 END")
        if 'english_code' not in product_columns: db.execute("ALTER TABLE products ADD COLUMN english_code TEXT NOT NULL DEFAULT ''")
        if 'numbering_product_id' not in columns: db.execute('ALTER TABLE parts ADD COLUMN numbering_product_id TEXT REFERENCES products(id)')
        if 'material_serial' not in columns: db.execute('ALTER TABLE parts ADD COLUMN material_serial INTEGER')
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_product_english_code ON products(english_code) WHERE english_code<>''")
        db.execute('UPDATE parts SET sub_product_id=NULL WHERE sub_product_id IS NOT NULL')
        if version<4:
            db.execute("UPDATE parts SET unit='PCS' WHERE TRIM(unit)=''")
            # A single unambiguous product provides the numbering prefix. Shared records stay common.
            owners={}
            for part in db.execute('SELECT id FROM parts').fetchall():
                product_ids={r[0] for r in db.execute('SELECT DISTINCT v.product_id FROM bom_lines l JOIN bom_versions v ON v.id=l.version_id WHERE l.part_id=?',(part['id'],))}
                owners[part['id']]=product_ids
                if len(product_ids)==1: db.execute('UPDATE parts SET numbering_product_id=? WHERE id=?',(next(iter(product_ids)),part['id']))
            for child in db.execute('SELECT id FROM parts WHERE material_level=2 AND numbering_product_id IS NULL').fetchall():
                parent_owners={r[0] for r in db.execute('SELECT DISTINCT p.numbering_product_id FROM material_links l JOIN parts p ON p.id=l.parent_id WHERE l.child_id=?',(child['id'],))}
                if len(owners[child['id']])<=1 and len(parent_owners)==1 and None not in parent_owners:
                    db.execute('UPDATE parts SET numbering_product_id=? WHERE id=?',(next(iter(parent_owners)),child['id']))
            materials=[dict(r) for r in db.execute('SELECT * FROM parts ORDER BY rowid').fetchall()]
            for part in materials:
                db.execute('INSERT OR IGNORE INTO material_code_aliases VALUES(?,?)',(part['code'],part['id']))
                serial=part['material_serial'] if part['material_serial'] is not None else next_material_serial(db)
                db.execute('UPDATE parts SET material_serial=?,code=? WHERE id=?',(serial,'__migration_'+part['id'],part['id']))
            for part in db.execute('SELECT * FROM parts ORDER BY rowid').fetchall():
                db.execute('UPDATE parts SET code=? WHERE id=?',(material_code(db,part['category'],part['material_level'],part['numbering_product_id'],part['material_serial']),part['id']))
        for field in ('external_code','brand'):
            if field not in columns: db.execute(f"ALTER TABLE parts ADD COLUMN {field} TEXT NOT NULL DEFAULT ''")
        link_columns={r[1] for r in db.execute('PRAGMA table_info(material_links)')}
        for field in ('reference','notes'):
            if field not in link_columns: db.execute(f"ALTER TABLE material_links ADD COLUMN {field} TEXT NOT NULL DEFAULT ''")
        db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_material_serial ON parts(material_serial)')
        quote_columns = {row['name']: row for row in db.execute('PRAGMA table_info(quotes)')}
        if quote_columns['price']['notnull']:
            db.execute('ALTER TABLE quotes RENAME TO quotes_v5')
            db.execute(QUOTES_SCHEMA)
            db.execute('INSERT INTO quotes SELECT id,part_id,supplier_id,price,url FROM quotes_v5')
            db.execute('DROP TABLE quotes_v5')
        for table, column in RESPONSIBILITIES.items():
            if column not in {r['name'] for r in db.execute(f'PRAGMA table_info({table})')}:
                db.execute(f'ALTER TABLE {table} ADD COLUMN {column} TEXT REFERENCES users(id)')
        if 'user_id' not in {r['name'] for r in db.execute('PRAGMA table_info(sessions)')}:
            db.execute('ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)')
            db.execute('DELETE FROM sessions')
        legacy = db.execute("SELECT value FROM settings WHERE key='password'").fetchone()
        if bootstrap or legacy:
            if db.execute('SELECT 1 FROM users LIMIT 1').fetchone():
                if bootstrap:
                    raise Problem('管理员已初始化')
            else:
                identity = bootstrap or {
                    'name': os.environ.get('PLM_ADMIN_NAME', '管理员'),
                    'email': os.environ.get('PLM_ADMIN_EMAIL', 'admin@localhost'),
                }
                create_account(db, identity, 'admin', legacy_password=legacy[0] if legacy and not bootstrap else None,
                               must_change=bool(bootstrap))
            db.execute("DELETE FROM settings WHERE key='password'")
        db.execute('PRAGMA user_version=8')

class ClosingConnection(sqlite3.Connection):
    project_id = None

    def __exit__(self, exc_type, exc_value, traceback):
        try: return super().__exit__(exc_type, exc_value, traceback)
        finally: self.close()

def connect(directory=None):
    db = sqlite3.connect((DATA if directory is None else directory) / 'plm.sqlite3', timeout=15, factory=ClosingConnection)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA journal_mode=WAL')
    return db

@contextmanager
def transaction():
    db = connect()
    try:
        db.execute('BEGIN IMMEDIATE')
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally: db.close()

def exists(db, table, id):
    if db.project_id and table in SCOPED_TABLES:
        r = db.execute(f'SELECT * FROM {table} WHERE id=? AND project_id=?', (id, db.project_id)).fetchone()
    else:
        r = db.execute(f'SELECT * FROM {table} WHERE id=?', (id,)).fetchone()
    if not r: raise Problem('关联记录不存在', 404)
    return dict(r)

def active_part(db, id):
    part = exists(db, 'parts', id)
    if part['deleted_at']:
        raise Problem('物料已删除，请先恢复物料', 409)
    return part

def insert_scoped(db, table, values, conflict=''):
    columns = ','.join(('project_id', *values))
    placeholders = ','.join('?' for _ in range(len(values) + 1))
    db.execute(f'INSERT INTO {table} ({columns}) VALUES ({placeholders}) {conflict}',
               (db.project_id, *values.values()))

def insert_bom_line(db, version, part, qty, reference='', notes='', upsert=False):
    id = uid()
    insert_scoped(db, 'bom_lines', dict(id=id, version_id=version, part_id=part, qty=qty,
                                        reference=reference, notes=notes),
                  'ON CONFLICT(version_id,part_id) DO UPDATE SET qty=excluded.qty,'
                  'reference=excluded.reference,notes=excluded.notes' if upsert else '')
    return id

def find_part_code(db, code):
    return db.execute(
        '''SELECT id FROM parts WHERE code=? AND project_id=?
           UNION ALL SELECT part_id FROM material_code_aliases WHERE code=? AND project_id=?''',
        (code, db.project_id, code, db.project_id),
    ).fetchone()

def electronic_candidates(db):
    return [dict(row) for row in db.execute(
        'SELECT * FROM parts WHERE project_id=? AND material_level=2 AND deleted_at IS NULL',
        (db.project_id,))]

def image_mime(header):
    if header.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if header.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if header[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif'
    if header.startswith(b'RIFF') and header[8:12] == b'WEBP':
        return 'image/webp'
    if header.startswith(b'BM'):
        return 'image/bmp'
    return None

def owner_file_name(original, owner_code, owner_name, position):
    if not owner_code:
        return original
    label = re.sub(r'[\x00-\x1f\x7f<>:"/\\|?*]+', ' ', owner_name)
    label = ' '.join(label.split()).strip(' .')
    # Bound the filename by UTF-8 bytes without cutting a character in half.
    label = label.encode('utf-8')[:150].decode('utf-8', errors='ignore').rstrip(' .')
    extension = Path(original).suffix
    if not re.fullmatch(r'\.[A-Za-z0-9]{1,15}', extension):
        extension = ''
    stem = f'{owner_code} {label}' if label else owner_code
    return f'{stem}（{position:02d}）{extension.lower()}'

def remove_upload(id):
    try:
        (DATA / 'uploads' / id).unlink(missing_ok=True)
        return True
    except OSError as exc:
        print(f'无法清理上传文件 {id}：{exc}', file=sys.stderr)
        return False

def cleanup_orphan_images():
    cutoff = time.time() - ORPHAN_IMAGE_GRACE
    removed = 0
    # The upload and backup paths take the same lock. The transaction also
    # excludes writers from the local admin tool while we check references.
    with FILE_LOCK, transaction() as db, os.scandir(DATA / 'uploads') as entries:
        referenced = {row[0] for row in db.execute('SELECT id FROM files')}
        for entry in entries:
            if entry.name in referenced or not UPLOAD_ID.fullmatch(entry.name):
                continue
            try:
                if not entry.is_file(follow_symlinks=False):
                    continue
                if entry.stat(follow_symlinks=False).st_mtime >= cutoff:
                    continue
                with open(entry.path, 'rb') as file:
                    is_image = image_mime(file.read(12)) is not None
                if is_image and remove_upload(entry.name):
                    removed += 1
            except FileNotFoundError:
                continue
            except OSError as exc:
                print(f'无法检查上传文件 {entry.name}：{exc}', file=sys.stderr)
    return removed

def run_image_cleanup(stop, interval=CLEANUP_INTERVAL):
    while not stop.is_set():
        try:
            removed = cleanup_orphan_images()
            if removed:
                print(f'已清理 {removed} 张无引用图片。', flush=True)
        except (OSError, sqlite3.Error) as exc:
            print(f'图片清理失败：{exc}', file=sys.stderr)
        stop.wait(interval)

def next_code(db, prefix):
    return prefix + '-' + datetime.now().strftime('%Y%m%d') + '-' + secrets.token_hex(3).upper()

def password_hash(password, salt): return hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 310000).hex()

RESPONSIBILITIES = {
    'products': 'manager_id', 'parts': 'custodian_id',
    'purchases': 'responsible_id', 'movements': 'handler_id',
}
PUBLIC_USER = 'id,name,email,role,phone,must_change,(avatar IS NOT NULL) AS has_avatar'

def account_email(value):
    value = str(value or '').strip().lower()
    if len(value) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+', value):
        raise Problem('请填写有效邮箱')
    return value

def account_name(value):
    name = required(value, '用户名')
    if len(name) > 80:
        raise Problem('用户名最多 80 个字符')
    return name

def password_record(value):
    if not isinstance(value, str) or not value:
        raise Problem('请输入密码')
    salt = secrets.token_hex(16)
    return json.dumps({'salt': salt, 'hash': password_hash(value, salt)})

def check_password(value, stored):
    if not isinstance(value, str) or not value:
        return False
    stored = json.loads(stored)
    return hmac.compare_digest(stored['hash'], password_hash(value, stored['salt']))

def create_account(db, data, role='member', legacy_password=None, must_change=True):
    email = account_email(data.get('email'))
    if db.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone():
        raise Problem('邮箱已使用', 409)
    id = uid()
    db.execute('INSERT INTO users(id,name,email,role,password,must_change,created_at) VALUES(?,?,?,?,?,?,?)',
               (id, account_name(data.get('name')), email, role,
                legacy_password or password_record(data.get('password')), int(must_change), now()))
    return id

def assign_user(db, id):
    if id:
        user = exists(db, 'users', id)
        if db.project_id and user['role'] != 'admin' and not db.execute(
            'SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', (db.project_id, id),
        ).fetchone():
            raise Problem('请选择当前项目成员')
    return id or None

def log_activity(db, actor, action, subject_id, subject, detail=''):
    if actor:
        db.execute('INSERT INTO activity(actor_id,actor_name,action,subject_id,subject,detail,created_at,project_id) VALUES(?,?,?,?,?,?,?,?)',
                   (actor['id'], actor['name'], action, subject_id, subject, detail, now(), db.project_id))

def record_movement(db, data, actor=None):
    kind = data.get('type')
    if kind not in ('入库','出库','退库','报废'): raise Problem('无效的库存操作')
    part = active_part(db, data.get('part_id'))
    qty = num(data.get('qty'), True)
    purchase_line = data.get('purchase_line_id') or None
    original_id = data.get('original_id') or None
    product_id = data.get('product_id') or None
    if product_id: exists(db, 'products', product_id)
    if purchase_line:
        if kind != '入库': raise Problem('仅入库可以关联采购明细')
        line = exists(db, 'purchase_lines', purchase_line)
        if line['part_id'] != part['id']: raise Problem('采购物料与入库物料不一致')
        if qty > round(line['qty'] - line['received'],6): raise Problem('入库数量超过待入库数量')
        db.execute('UPDATE purchase_lines SET received=ROUND(received+?,6) WHERE id=?',(qty,purchase_line))
    if original_id:
        if kind != '退库': raise Problem('只有退库可以关联原出库记录')
        original = exists(db, 'movements', original_id)
        if original['type'] != '出库' or original['part_id'] != part['id']: raise Problem('请选择该物料的原出库记录')
        returned = db.execute("SELECT COALESCE(SUM(qty),0) FROM movements WHERE original_id=?",(original_id,)).fetchone()[0]
        if qty > round(original['qty'] - returned,6): raise Problem('退库数量超过原出库尚未退回的数量')
        product_id = original['product_id']
    if kind == '退库' and not original_id: raise Problem('退库需关联原出库记录')
    reason = str(data.get('reason','')).strip()
    if kind == '报废' and not reason: raise Problem('请填写报废原因')
    delta = qty if kind in ('入库','退库') else -qty
    balance = round(part['stock'] + delta,6)
    if balance < 0: raise Problem('库存不足，无法完成此操作')
    mid = uid()
    db.execute('UPDATE parts SET stock=?,updated_at=? WHERE id=?',(balance,now(),part['id']))
    handler = assign_user(db, data.get('handler_id') or (actor['id'] if actor else None))
    code = next_code(db, 'ST')
    insert_scoped(db, 'movements', dict(id=mid, code=code, type=kind, part_id=part['id'], qty=qty,
                                      balance=balance, product_id=product_id, purchase_line_id=purchase_line,
                                      original_id=original_id, reason=reason, created_at=now(), handler_id=handler))
    handler_name = exists(db, 'users', handler)['name'] if handler else ''
    log_activity(db, actor, kind, part['id'], f"{part['code']} {part['name']}",
                 f'{code} · {qty:g} {part["unit"]} · 结余 {balance:g} · 经办人 {handler_name}')
    return mid

def material_level(value):
    if str(value) not in ('1','2'): raise Problem('物料级别只能是一级或二级')
    return int(value)

def automatic_code(db, table, prefix):
    key='sequence_'+table
    row=db.execute('SELECT value FROM settings WHERE key=?',(key,)).fetchone()
    sequence=int(row[0]) if row else 0
    while True:
        sequence+=1
        code=f'{prefix}-{sequence:06d}'
        if not db.execute(f'SELECT 1 FROM {table} WHERE code=?',(code,)).fetchone(): break
    db.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,str(sequence)))
    return code

def normalize_english_code(value):
    code=str(value or '').strip().upper()
    if not code: return ''
    if len(code)>32 or any(c not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in code) or sum(c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' for c in code)<2:
        raise Problem('英文代号需含至少 2 个英文字母，可使用数字、连字符或下划线，最多 32 位')
    return code

def product_prefix(db,product_id):
    if not product_id: return 'CM'
    product=exists(db,'products',product_id)
    letters=''.join(c for c in product['english_code'] if c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    return letters[:2] if len(letters)>=2 else 'CM'

def material_prefix(category,level,prefix='CM'): return prefix+('1' if category=='结构物料' else '2')+str(level)

def next_material_serial(db):
    key='sequence_material_global'
    row=db.execute('SELECT value FROM settings WHERE key=?',(key,)).fetchone()
    existing=db.execute('SELECT COALESCE(MAX(material_serial),0) FROM parts').fetchone()[0]
    sequence=max(int(row[0]) if row else 0,existing)+1
    if sequence>9999: raise Problem('4 位物料流水号已用完',409)
    db.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,str(sequence)))
    return sequence

def material_code(db,category,level,product_id,serial):
    if not isinstance(serial,int) or not 1<=serial<=9999: raise Problem('物料流水号无效')
    return f'{material_prefix(category,level,product_prefix(db,product_id))}{serial:04d}'

def link_material(db,parent_id,child_id,qty=1):
    parent=active_part(db,parent_id);child=active_part(db,child_id)
    if parent['material_level']!=1 or child['material_level']!=2: raise Problem('只能将一级物料关联到二级物料')
    quantity=num(qty,True);id=uid()
    insert_scoped(db, 'material_links', dict(id=id, parent_id=parent_id, child_id=child_id,
                                            qty=quantity, created_at=now()),
                  'ON CONFLICT(parent_id,child_id) DO UPDATE SET qty=excluded.qty')
    db.execute('UPDATE parts SET updated_at=? WHERE id IN (?,?)',(now(),parent_id,child_id))
    return db.execute('SELECT id FROM material_links WHERE parent_id=? AND child_id=?',(parent_id,child_id)).fetchone()[0]

def set_material_parents(db,child_id,parent_ids):
    child=active_part(db,child_id)
    if child['material_level']!=2: raise Problem('关联一级物料仅适用于二级物料')
    if not isinstance(parent_ids,list) or len(parent_ids)>1000 or any(not isinstance(p,str) for p in parent_ids): raise Problem('关联记录格式错误')
    selected=list(dict.fromkeys(parent_ids))
    for parent_id in selected:
        if exists(db,'parts',parent_id)['material_level']!=1: raise Problem('请选择一级物料')
    existing={r['parent_id']:dict(r) for r in db.execute('SELECT * FROM material_links WHERE child_id=?',(child_id,))}
    for parent_id,link in existing.items():
        if parent_id not in selected and not exists(db, 'parts', parent_id)['deleted_at']: db.execute('DELETE FROM material_links WHERE id=?',(link['id'],))
    for parent_id in selected:
        if parent_id not in existing: link_material(db,parent_id,child_id)
    db.execute('UPDATE parts SET updated_at=? WHERE id=?',(now(),child_id))

def set_material_children(db,parent_id,child_ids):
    if active_part(db,parent_id)['material_level']!=1: raise Problem('二级物料列表仅适用于一级物料')
    if not isinstance(child_ids,list) or len(child_ids)>1000 or any(not isinstance(c,str) for c in child_ids): raise Problem('关联记录格式错误')
    selected=list(dict.fromkeys(child_ids))
    for child_id in selected:
        if exists(db,'parts',child_id)['material_level']!=2: raise Problem('请选择二级物料')
    existing={r['child_id']:dict(r) for r in db.execute('SELECT * FROM material_links WHERE parent_id=?',(parent_id,))}
    for child_id,link in existing.items():
        if child_id not in selected and not exists(db, 'parts', child_id)['deleted_at']: db.execute('DELETE FROM material_links WHERE id=?',(link['id'],))
    for child_id in selected:
        if child_id not in existing: link_material(db,parent_id,child_id)
    db.execute('UPDATE parts SET updated_at=? WHERE id=?',(now(),parent_id))

def automatic_version(db, product_id):
    existing={r[0] for r in db.execute('SELECT name FROM bom_versions WHERE product_id=?',(product_id,))}
    n=1
    while f'V{n}.0' in existing: n+=1
    return f'V{n}.0'

TABLES = BUSINESS_TABLES

def get_state(db):
    if not db.in_transaction:
        db.execute('BEGIN')
    state = {t: [{k:r[k] for k in r.keys() if k != 'sub_product_id'}
                 for r in db.execute(f'SELECT * FROM {t} WHERE project_id=? ORDER BY rowid',
                                     (db.project_id,))] for t in TABLES}
    owners = {(table, row['id']): row
              for table in ('parts', 'products') for row in state[table]}
    positions = {}
    for file in state['files']:
        owner = (file['owner_type'], file['owner_id'])
        positions[owner] = positions.get(owner, 0) + 1
        record = owners.get(owner)
        if record:
            file['original_name'] = file['name']
            file['name'] = owner_file_name(file['name'], record['code'], record['name'], positions[owner])
    state['deleted_parts'] = [p for p in state['parts'] if p['deleted_at']]
    state['parts'] = [p for p in state['parts'] if not p['deleted_at']]
    state['users'] = [dict(row) for row in db.execute(
        """SELECT id,name FROM users WHERE role='admin' OR id IN (
               SELECT user_id FROM project_members WHERE project_id=?
           ) ORDER BY name,id""", (db.project_id,))]
    responsible_ids = {row.get(column) for table, column in RESPONSIBILITIES.items()
                       for row in (state[table] + state['deleted_parts'] if table == 'parts' else state[table])}
    current_ids = {row['id'] for row in state['users']}
    state['former_users'] = [dict(row) for id in responsible_ids - current_ids - {None}
                             if (row := db.execute('SELECT id,name FROM users WHERE id=?', (id,)).fetchone())]
    return state

def enter_project(db, project_id, user, write=False):
    project = db.execute('SELECT * FROM projects WHERE id=? AND deleted_at IS NULL', (project_id,)).fetchone()
    if not project or (user['role'] != 'admin' and not db.execute(
        'SELECT 1 FROM project_members WHERE project_id=? AND user_id=?',
        (project_id, user['id']),
    ).fetchone()):
        raise Problem('项目不存在或无权访问', 404)
    if write and project['archived_at']:
        raise Problem('项目已归档，只能查看', 409)
    db.project_id = project_id
    return dict(project)

def list_projects(db, user):
    return [dict(row) for row in db.execute("""
        SELECT p.*, u.name AS owner_name, c.updated_at AS cover_version,
            CASE WHEN c.project_id IS NULL THEN (
                SELECT f.id FROM files AS f
                WHERE f.project_id=p.id AND f.owner_type='products' AND f.kind='image'
                ORDER BY f.rowid DESC LIMIT 1
            ) END AS cover_file_id,
            (SELECT COUNT(*) FROM purchases AS po WHERE po.project_id=p.id AND EXISTS (
                SELECT 1 FROM purchase_lines AS l WHERE l.purchase_id=po.id AND l.received<l.qty
            )) AS pending_purchases
        FROM projects AS p LEFT JOIN users AS u ON u.id=p.owner_id
        LEFT JOIN project_covers AS c ON c.project_id=p.id
        WHERE p.deleted_at IS NULL AND (? OR EXISTS (
            SELECT 1 FROM project_members AS m WHERE m.project_id=p.id AND m.user_id=?
        ))
        ORDER BY p.archived_at IS NOT NULL, p.updated_at DESC, p.code
    """, (user['role'] == 'admin', user['id']))]

def touch_project(db):
    db.execute('UPDATE projects SET updated_at=? WHERE id=?', (now(), db.project_id))


def write_backup(output):
    with tempfile.TemporaryDirectory(dir=DATA) as folder:
        database = Path(folder) / 'plm.sqlite3'
        with sqlite3.connect(database, factory=ClosingConnection) as target:
            with connect() as source:
                source.backup(target)
            target.execute('DELETE FROM sessions')
            files = target.execute('SELECT id FROM files').fetchall()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.write(database, 'plm.sqlite3')
            for (id,) in files:
                file = DATA / 'uploads' / id
                if not UPLOAD_ID.fullmatch(id) or not file.is_file():
                    raise Problem('备份失败：有附件文件缺失，请检查存储', 409)
                archive.write(file, 'uploads/' + id)

def stage_restore(archive_path, directory):
    # Import records into our own schema. Uploaded triggers, views and sessions
    # are never installed, and ZIP paths are never extracted directly.
    unpacked = directory / 'incoming.sqlite3'
    staged = directory / 'staged'
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        names = {entry.filename for entry in entries}
        if len(names) != len(entries) or len(names) > 100000 or sum(item.file_size for item in entries) > 2 * MAX_RESTORE:
            raise Problem('备份内容过大或包含重复文件')
        if 'plm.sqlite3' not in names or any(
            name not in ('plm.sqlite3', 'uploads/') and
            (not name.startswith('uploads/') or not UPLOAD_ID.fullmatch(name[8:]))
            for name in names
        ):
            raise Problem('不是有效的 JPLM ZIP 备份')
        with archive.open('plm.sqlite3') as source, unpacked.open('wb') as target:
            shutil.copyfileobj(source, target, 1024 * 1024)
        with sqlite3.connect(unpacked.as_uri() + '?mode=ro&immutable=1', uri=True, factory=ClosingConnection) as source:
            source.row_factory = sqlite3.Row
            source.execute('PRAGMA trusted_schema=OFF')
            version = source.execute('PRAGMA user_version').fetchone()[0]
            if not 6 <= version <= VERSION:
                raise Problem(f'请使用数据库版本 6 至 {VERSION} 的 JPLM 备份')
            if source.execute('PRAGMA quick_check(1)').fetchone()[0] != 'ok':
                raise Problem('备份数据库已损坏')
            source_tables = {row['name'] for row in source.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'")}
            project_tables = ('projects', 'project_members') if version >= PROJECT_VERSION else ()
            if version >= 10:
                project_tables += ('project_covers',)
            inspection_tables = inspection.TABLES if version >= 13 else inspection.INITIAL_TABLES if version == 12 else ()
            shipping_tables = shipping.TABLES if version >= shipping.VERSION else ()
            required_tables = set(TABLES) | {'settings', 'import_runs', *project_tables, *inspection_tables, *shipping_tables}
            if version >= 7:
                required_tables |= {'users', 'activity'}
            if not required_tables <= source_tables:
                raise Problem('备份缺少业务数据表')
            (init_db if project_tables else init_legacy_db)(staged)
            with connect(staged) as db:
                db.execute('BEGIN')
                db.execute('PRAGMA defer_foreign_keys=ON')
                for table in ('users', *project_tables, *TABLES, *inspection_tables, *shipping_tables,
                              'settings', 'import_runs', 'activity'):
                    if table not in source_tables or (version == 6 and table in ('users', 'activity')):
                        continue
                    target_columns = [row['name'] for row in db.execute(f'PRAGMA table_info({table})')]
                    source_columns = {row['name'] for row in source.execute(f'PRAGMA table_info({table})')}
                    optional = {RESPONSIBILITIES.get(table)} if version == 6 else set()
                    if table == 'parts' and version < 8:
                        optional.add('deleted_at')
                    if table == 'projects' and version < 11:
                        optional.add('deleted_at')
                    if table == 'inspection_records' and version < 13:
                        optional.add('deleted_at')
                    if not set(target_columns) - optional <= source_columns:
                        raise Problem('备份数据结构不完整')
                    columns = ','.join(name for name in target_columns if name in source_columns)
                    records = source.execute(f'SELECT {columns} FROM {table} ORDER BY rowid')
                    db.executemany(f'INSERT INTO {table}({columns}) VALUES({",".join("?" for _ in columns.split(","))})', records)
                if version == 12:
                    inspection.backfill_from_records(db)
                db.execute("DELETE FROM settings WHERE key='password'")
                if version >= 7 and not db.execute("SELECT 1 FROM users WHERE role='admin'").fetchone():
                    raise Problem('备份中没有管理员账户')
                file_ids = {r['id'] for r in db.execute('SELECT id FROM files')}
                if any(not UPLOAD_ID.fullmatch(id) or 'uploads/' + id not in names for id in file_ids):
                    raise Problem('备份缺少图片或附件')
                if db.execute('PRAGMA foreign_key_check').fetchone():
                    raise Problem('备份中的关联数据不完整')
                for file in db.execute('SELECT id,size FROM files').fetchall():
                    name = 'uploads/' + file['id']
                    if archive.getinfo(name).file_size != file['size']:
                        raise Problem('备份附件大小不匹配')
                    with archive.open(name) as payload, (staged / name).open('wb') as target:
                        shutil.copyfileobj(payload, target, 1024 * 1024)
    if version < PROJECT_VERSION:
        init_db(staged)
    return staged, version

class ThreadingHTTPServer(BaseThreadingHTTPServer):
    request_queue_size=64
    daemon_threads=True

class Handler(BaseHTTPRequestHandler):
    server_version = 'JiechengPLM/1.5'
    attempts = {}
    def setup(self):
        super().setup()
        self.connection.settimeout(60)
    def log_message(self, fmt, *args):
        if not self.path.startswith('/api/auth') and os.environ.get('PLM_QUIET')!='1': super().log_message(fmt,*args)
    def send(self, data, status=200, extra=None):
        b = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(b)))
        self.send_header('Cache-Control','no-store')
        self.security_headers()
        for k,v in (extra or {}).items(): self.send_header(k,v)
        self.end_headers(); self.wfile.write(b)
    def security_headers(self):
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Referrer-Policy','same-origin')
        self.send_header('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'")
    def body(self):
        size = int(self.headers.get('Content-Length','0'))
        if size < 0 or size > MAX_UPLOAD: raise Problem('单次上传不能超过 20 MB',413)
        raw = self.rfile.read(size)
        if 'multipart/form-data' in self.headers.get('Content-Type',''): return raw
        try: return json.loads(raw or b'{}')
        except (ValueError, UnicodeError): raise Problem('请求数据格式错误')
    def session_token(self):
        try:
            jar = cookies.SimpleCookie()
            jar.load(self.headers.get('Cookie', ''))
            return hashlib.sha256(jar[SESSION_COOKIE].value.encode()).hexdigest()
        except (KeyError, cookies.CookieError):
            return None

    def authorized(self, db):
        return db.execute(
            f'SELECT {PUBLIC_USER} FROM users WHERE id=(SELECT user_id FROM sessions WHERE token=? AND expires>?)',
            (self.session_token(), time.time()),
        ).fetchone()

    def require_admin(self):
        if self.user['role'] != 'admin':
            raise Problem('需要管理员权限', 403)

    def require_admin_password(self, db, password):
        self.require_admin()
        if not isinstance(password, str) or not password:
            raise Problem('请输入当前管理员密码')
        key = ('admin-password-confirmation', self.user['id'])
        current_time = time.time()
        recent = [stamp for stamp in self.attempts.get(key, []) if stamp > current_time - 600]
        if len(recent) >= 12:
            raise Problem('尝试次数过多，请十分钟后重试', 429)
        stored = db.execute('SELECT password FROM users WHERE id=?', (self.user['id'],)).fetchone()
        if not stored or not check_password(password, stored['password']):
            self.attempts[key] = recent + [current_time]
            raise Problem('管理员密码不正确', 403)
        self.attempts.pop(key, None)

    def cookie(self, token, age=604800):
        secure = '; Secure' if os.environ.get('PLM_SECURE_COOKIE') == '1' else ''
        return f'{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path={BASE_PATH or "/" }; Max-Age={age}{secure}'

    def do_GET(self): self.handle_request('GET')
    def do_POST(self): self.handle_request('POST')
    def do_PUT(self): self.handle_request('PUT')
    def do_DELETE(self): self.handle_request('DELETE')
    def handle_request(self, method):
        try:
            path = unquote(urlparse(self.path).path)
            if BASE_PATH:
                if not path.startswith(BASE_PATH + '/'):
                    raise Problem('路径不存在', 404)
                path = path[len(BASE_PATH):]
            if method != 'GET':
                origin = self.headers.get('Origin')
                if origin and urlparse(origin).netloc != self.headers.get('Host'): raise Problem('请求来源不被允许',403)
                if self.headers.get('Sec-Fetch-Site') == 'cross-site': raise Problem('请求来源不被允许',403)
            if path == '/api/health': return self.send({'ok':True})
            if path == '/api/auth/status':
                with connect() as db:
                    user = self.authorized(db)
                    initialized = bool(db.execute('SELECT 1 FROM users LIMIT 1').fetchone())
                return self.send({'initialized': initialized, 'authenticated': bool(user),
                                  'user': dict(user) if user else None})
            if path in ('/api/auth/setup', '/api/auth/login') and method == 'POST':
                return self.auth(path)
            if path.startswith(('/api/', '/files/')):
                with connect() as db:
                    self.user = self.authorized(db)
                if not self.user:
                    raise Problem('请先登录', 401)
                if self.user['must_change'] and path not in ('/api/auth/logout', '/api/account/password'):
                    raise Problem('请先修改初始密码', 403)
            segments = path.strip('/').split('/')
            if segments[:2] == ['api', 'projects']:
                if len(segments) >= 4:
                    return self.project_request(segments[2], '/api/' + '/'.join(segments[3:]), method)
                return self.project_directory(segments[2] if len(segments) == 3 else None, method)
            if segments[:2] == ['api', 'resolve'] and len(segments) == 4 and method == 'GET':
                table, id = segments[2:]
                if table not in ('parts', 'products', 'suppliers', 'purchases'):
                    raise Problem('记录不存在', 404)
                with connect() as db:
                    db.execute('BEGIN')
                    record = exists(db, table, id)
                    enter_project(db, record['project_id'], self.user)
                    return self.send({'project_id': record['project_id']})
            if path == '/api/auth/logout' and method == 'POST':
                with FILE_LOCK, transaction() as db:
                    result = db.execute('DELETE FROM sessions WHERE token=?', (self.session_token(),))
                    if result.rowcount:
                        log_activity(db, self.user, '退出登录', self.user['id'], self.user['name'])
                return self.send({'ok': True}, extra={'Set-Cookie': self.cookie('', 0)})
            if path == '/api/users' and method == 'GET':
                self.require_admin()
                with connect() as db:
                    return self.send([dict(row) for row in db.execute(f'SELECT {PUBLIC_USER} FROM users ORDER BY name,id')])
            if path.startswith('/api/avatars/') and method == 'GET':
                return self.serve_avatar(path.rsplit('/', 1)[1])
            if path == '/api/account/avatar' and method == 'POST':
                return self.update_avatar()
            if path == '/api/activity' and method == 'GET':
                return self.list_activity()
            if path == '/api/restore' and method == 'POST':
                self.require_admin()
                return self.restore()
            if path == '/api/backup' and method == 'GET':
                with FILE_LOCK:
                    with connect() as db:
                        user = self.authorized(db)
                    if not user or user['role'] != 'admin' or user['must_change']:
                        raise Problem('需要管理员权限', 403)
                    return self.backup()
            if path.startswith('/files/') and method == 'GET':
                with FILE_LOCK:
                    with connect() as db:
                        if not self.authorized(db):
                            raise Problem('请先登录', 401)
                    return self.serve_file(path.split('/')[-1])
            if segments[:2] in (['api', 'users'], ['api', 'account'], ['api', 'reset-password']) and method != 'GET':
                data = self.body()
                with FILE_LOCK:
                    with transaction() as db:
                        user = self.authorized(db)
                        if not user:
                            raise Problem('请先登录', 401)
                        if user['must_change'] and path != '/api/account/password':
                            raise Problem('请先修改初始密码', 403)
                        self.user = user
                        result = self.mutate(db, path, method, data)
                    for fid in result.pop('_delete_files', []): remove_upload(fid)
                return self.send(result)
            if method == 'GET' and not path.startswith('/api/'): return self.static(path)
            raise Problem('接口不存在',404)
        except (ConnectionResetError,BrokenPipeError,TimeoutError): return
        except Problem as e: self.send({'error':e.message},e.status)
        except inspection.InspectionError as e: self.send({'error':str(e)},e.status)
        except shipping.ShippingError as e: self.send({'error':str(e)},e.status)
        except sqlite3.IntegrityError as e:
            msg = '英文代号已使用' if 'products.english_code' in str(e) else '关联记录不匹配或仍被其他记录引用' if 'FOREIGN KEY' in str(e) else '编码或关联物料重复，请检查输入'
            self.send({'error':msg},409)
        except (ValueError,TypeError,KeyError) as e: self.send({'error':'输入数据不完整或格式错误'},400)
        except Exception as e:
            print(f'Internal error: {e}',file=sys.stderr)
            self.send({'error':'服务暂时不可用，请查看服务器日志'},500)

    def project_directory(self, project_id, method):
        if method == 'GET':
            with connect() as db:
                db.execute('BEGIN')
                if not project_id:
                    if parse_qs(urlparse(self.path).query).get('deleted') == ['1']:
                        self.require_admin()
                        rows = db.execute('SELECT id,code,name,deleted_at FROM projects '
                                          'WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
                        return self.send([dict(row) for row in rows])
                    return self.send(list_projects(db, self.user))
                project = enter_project(db, project_id, self.user)
                project['members'] = [r[0] for r in db.execute(
                    'SELECT user_id FROM project_members WHERE project_id=? ORDER BY user_id',
                    (project_id,))]
                return self.send(project)
        if method == 'DELETE' and project_id:
            return self.set_project_deleted(project_id, deleted=True)
        if method not in ('POST', 'PUT') or (method == 'PUT') != bool(project_id):
            raise Problem('接口不存在', 404)
        data = self.body()
        with FILE_LOCK, transaction() as db:
            self.user = self.authorized(db)
            if not self.user or self.user['must_change']:
                raise Problem('请先登录', 401)
            is_admin = self.user['role'] == 'admin'
            if not project_id:
                self.require_admin()
                name = required(data.get('name'), '项目名称')
                project_id = uid()
                stamp = now()
                db.execute('INSERT INTO projects(id,code,name,owner_id,archived_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                           (project_id, automatic_code(db, 'projects', 'PJ'), name, self.user['id'],
                            None, stamp, stamp))
                db.execute('INSERT INTO project_members VALUES(?,?)', (project_id, self.user['id']))
                db.project_id = project_id
                log_activity(db, self.user, '新建项目', project_id, name)
            else:
                project = enter_project(db, project_id, self.user)
                if not is_admin and (project['owner_id'] != self.user['id'] or set(data) != {'name'}):
                    raise Problem('无权修改项目设置', 403)
                archived_at = project['archived_at']
                if 'archived' in data:
                    if type(data['archived']) is not bool:
                        raise Problem('项目状态格式错误')
                    archived_at = (archived_at or now()) if data['archived'] else None
                if archived_at and project['archived_at'] and set(data) - {'archived'}:
                    raise Problem('请先恢复已归档的项目', 409)
                name = required(data.get('name', project['name']), '项目名称')
                owner = data.get('owner_id', project['owner_id']) or None
                if owner:
                    exists(db, 'users', owner)
                if 'members' in data:
                    members = data['members']
                    if not isinstance(members, list) or any(not isinstance(id, str) for id in members):
                        raise Problem('项目成员格式错误')
                    member_ids = set(members)
                    for id in member_ids:
                        exists(db, 'users', id)
                    current = {r[0] for r in db.execute(
                        'SELECT user_id FROM project_members WHERE project_id=?', (project_id,))}
                    if owner:
                        member_ids.add(owner)
                    db.executemany('DELETE FROM project_members WHERE project_id=? AND user_id=?',
                                   ((project_id, id) for id in current - member_ids))
                    db.executemany('INSERT INTO project_members VALUES(?,?)',
                                   ((project_id, id) for id in member_ids - current))
                if owner:
                    db.execute('INSERT OR IGNORE INTO project_members VALUES(?,?)', (project_id, owner))
                db.execute('UPDATE projects SET name=?,owner_id=?,archived_at=?,updated_at=? WHERE id=?',
                           (name, owner, archived_at, now(), project_id))
                action = ('归档项目' if archived_at else '恢复项目') if archived_at != project['archived_at'] else '修改项目设置'
                log_activity(db, self.user, action, project_id, name)
        self.send({'id': project_id})

    def set_project_deleted(self, project_id, deleted):
        data = self.body()
        with FILE_LOCK, transaction() as db:
            self.user = self.authorized(db)
            if not self.user or self.user['must_change']:
                raise Problem('请先登录', 401)
            self.require_admin()
            project = exists(db, 'projects', project_id)
            if deleted:
                if not project['archived_at']:
                    raise Problem('请先归档项目', 409)
                if project['deleted_at']:
                    raise Problem('项目已删除', 409)
                self.require_admin_password(db, data.get('password'))
            elif not project['deleted_at']:
                raise Problem('项目不在已删除列表中', 409)
            stamp = now()
            db.execute('UPDATE projects SET deleted_at=?,updated_at=? WHERE id=?',
                       (stamp if deleted else None, stamp, project_id))
            log_activity(db, self.user, '删除项目' if deleted else '撤销删除项目',
                         project_id, project['name'], project['code'])
        self.send({'id': project_id})

    def project_request(self, project_id, path, method):
        if path.startswith('/api/inspection/'):
            return self.inspection_request(project_id, path.removeprefix('/api/inspection/'), method)
        if path.startswith('/api/shipping/'):
            return self.shipping_request(project_id, path.removeprefix('/api/shipping/'), method)
        if path == '/api/recover' and method == 'POST':
            return self.set_project_deleted(project_id, deleted=False)
        if path == '/api/cover' and method in ('GET', 'POST', 'DELETE'):
            return self.project_cover(project_id, method)
        if method == 'GET':
            if path == '/api/activity':
                return self.list_activity(project_id)
            if path == '/api/state':
                with connect() as db:
                    db.execute('BEGIN')
                    project = enter_project(db, project_id, self.user)
                    return self.send({**get_state(db), 'project': project})
            raise Problem('接口不存在', 404)
        resource = path.split('/')[2]
        if resource in ('users', 'account', 'reset-password'):
            raise Problem('接口不存在', 404)
        if path == '/api/electronic-import/preview' and method == 'POST':
            return self.electronic_preview(project_id)
        if path == '/api/files' and method == 'POST':
            with FILE_LOCK:
                return self.upload(project_id)
        data = self.body()
        with FILE_LOCK:
            with transaction() as db:
                self.user = self.authorized(db)
                if not self.user or self.user['must_change']:
                    raise Problem('请先登录', 401)
                enter_project(db, project_id, self.user, write=True)
                result = self.mutate(db, path, method, data)
                touch_project(db)
            for fid in result.pop('_delete_files', []):
                remove_upload(fid)
        self.send(result)

    def shipping_request(self, project_id, resource, method):
        query = {key: values[0] for key, values in parse_qs(urlparse(self.path).query).items()}
        if method == 'GET':
            with connect() as db:
                db.execute('BEGIN')
                enter_project(db, project_id, self.user)
                if resource == 'orders':
                    return self.send(shipping.list_orders(db, project_id, query))
                if resource == 'records':
                    return self.send(shipping.list_shipments(db, project_id, query.get('channel'), query))
                if resource == 'devices':
                    return self.send(shipping.find_devices(db, project_id, query))
                if resource == 'device-records':
                    serial = shipping.string(query.get('serial'), 100)
                    return self.send(shipping.for_device(db, project_id, serial))
        if resource in ('orders/preview', 'orders/import') and method == 'POST':
            self.require_admin()
            _, uploads = self.multipart()
            if len(uploads) != 1:
                raise Problem('请选择一个 KS 订单文件')
            filename, _, blob = uploads[0]
            entries, invalid, duplicate = shipping.parse_orders(blob, filename)
            if resource == 'orders/preview':
                with connect() as db:
                    db.execute('BEGIN')
                    enter_project(db, project_id, self.user, write=True)
                    return self.send(shipping.apply_orders(db, project_id, entries, invalid, duplicate, now(), uid))
            if invalid:
                raise Problem('文件中有无效订单，请先修正再导入')
            with FILE_LOCK, transaction() as db:
                self.inspection_writer(db, project_id)
                self.require_admin()
                report = shipping.apply_orders(db, project_id, entries, invalid, duplicate, now(), uid, commit=True)
                if report['added'] or report['updated']:
                    touch_project(db)
                    log_activity(db, self.user, '导入 KS 订单', '', 'KS 发货信息',
                                 f"新增 {report['added']} 条，更新 {report['updated']} 条")
            return self.send(report)
        editing = re.fullmatch(r'records/([a-f0-9]{24})', resource)
        if (resource == 'records' and method == 'POST') or (editing and method == 'PUT'):
            data = self.body()
            if not isinstance(data, dict):
                raise Problem('发货记录格式无效')
            with FILE_LOCK, transaction() as db:
                self.inspection_writer(db, project_id)
                result = shipping.save_shipment(db, project_id, editing[1] if editing else uid(),
                                                data, now(), self.user['id'])
                touch_project(db)
                log_activity(db, self.user, '修改发货记录' if editing else '登记发货',
                             result['id'], result['reference'])
            return self.send(result)
        raise Problem('接口不存在', 404)

    def inspection_request(self, project_id, resource, method):
        query = {key: values[0] for key, values in parse_qs(urlparse(self.path).query).items()}
        if method == 'GET':
            with connect() as db:
                db.execute('BEGIN')
                enter_project(db, project_id, self.user)
                if resource == 'templates':
                    return self.send(inspection.templates(db, project_id))
                if resource == 'devices':
                    return self.send(inspection.list_devices(db, project_id, query))
                if resource == 'device':
                    serial, _, _ = inspection.parse_serial(query.get('serial'), 'text')
                    return self.send({'device': inspection.get_device(db, project_id, serial)})
                if resource not in ('records', 'lookup', 'latest', 'options', 'export', 'import-template'):
                    raise Problem('接口不存在', 404)
                config = inspection.template(db, project_id, query.get('template'))
                if query.get('deleted') == '1':
                    self.require_admin()
                if resource == 'options':
                    return self.send(inspection.list_options(db, project_id, config))
                if resource == 'lookup':
                    serial, _, _ = inspection.parse_serial(query.get('serial'), config['serial_mode'])
                    return self.send({'record': inspection.exact_record(db, project_id, config['id'], serial),
                                      'device': inspection.get_device(db, project_id, serial)})
                if resource == 'latest':
                    return self.send({'record': inspection.latest_record(
                        db, project_id, config['id'], query.get('prefix'),
                    )})
                if resource == 'records':
                    return self.send(inspection.list_records(db, project_id, config['id'], query))
                records = (inspection.list_records(db, project_id, config['id'], query, exporting=True)['records']
                           if resource == 'export' else [])
            rows = inspection.export_rows(config, records)
            as_csv = query.get('format') == 'csv'
            payload = inspection.csv_file(rows) if as_csv else inspection.xlsx_file(rows)
            name = ('生产检测模板' if resource == 'import-template' else '生产检测记录') + (
                '.csv' if as_csv else '.xlsx'
            )
            return self.inspection_download(payload, name, as_csv)

        if resource in ('import-preview', 'import') and method == 'POST':
            self.require_admin()
            with connect() as db:
                enter_project(db, project_id, self.user, write=True)
            fields, uploads = self.multipart()
            if len(uploads) != 1:
                raise Problem('请选择一个检测数据文件')
            filename, _, blob = uploads[0]
            if method == 'POST' and resource == 'import-preview':
                with connect() as db:
                    db.execute('BEGIN')
                    enter_project(db, project_id, self.user, write=True)
                    config = inspection.template(db, project_id, fields.get('template'))
                    _, report = inspection.import_batch(db, project_id, config, blob, filename, now())
                    return self.send({**report, 'revision': config['revision']})
            with FILE_LOCK, transaction() as db:
                self.inspection_writer(db, project_id)
                self.require_admin()
                config = inspection.template(db, project_id, fields.get('template'))
                if fields.get('revision') != str(config['revision']):
                    raise Problem('检测表已更新，请重新预览后再导入', 409)
                ready, report = inspection.import_batch(db, project_id, config, blob, filename, now())
                for serial, prefix, produced, result, values, operator, source, created, updated in ready:
                    inspection.insert_record(db, project_id, config, uid(), serial, prefix, produced,
                                             result, values, None, operator, source, created, updated)
                    inspection.register_device(db, project_id, serial, prefix, produced, now(),
                                               self.user['id'], self.user['name'])
                    inspection.remember_options(db, project_id, config, values, now())
                if ready:
                    touch_project(db)
                    log_activity(db, self.user, '导入生产检测记录', config['id'], config['name'], f'{len(ready)} 条')
            return self.send(report)

        if resource == 'devices' and method == 'POST':
            data = self.body()
            with FILE_LOCK, transaction() as db:
                self.inspection_writer(db, project_id)
                mode = (inspection.template(db, project_id, data['template_id'])['serial_mode']
                        if data.get('template_id') else 'text')
                serial, prefix, produced = inspection.parse_serial(data.get('serial'), mode)
                device, created = inspection.register_device(
                    db, project_id, serial, prefix, produced, now(), self.user['id'], self.user['name'],
                )
                if created:
                    touch_project(db)
                    log_activity(db, self.user, '登记检测设备', serial, serial)
            return self.send({'device': device, 'created': created})

        if resource == 'options' and method == 'PUT':
            data = self.body()
            with FILE_LOCK, transaction() as db:
                self.inspection_writer(db, project_id)
                self.require_admin()
                config = inspection.template(db, project_id, data.get('template_id'))
                inspection.hide_option(db, project_id, config, data, now())
                touch_project(db)
                options = inspection.list_options(db, project_id, config)
            return self.send(options)

        record_action = re.fullmatch(r'records/([0-9a-f]{24})(/recover)?', resource)
        if record_action and ((method == 'DELETE' and not record_action[2]) or
                              (method == 'POST' and record_action[2])):
            deleted = method == 'DELETE'
            with FILE_LOCK, transaction() as db:
                self.inspection_writer(db, project_id)
                self.require_admin()
                row = inspection.set_record_deleted(db, project_id, record_action[1], deleted, now())
                if bool(row['deleted_at']) != deleted:
                    touch_project(db)
                    log_activity(db, self.user, '删除检测记录' if deleted else '恢复检测记录',
                                 row['id'], row['serial'])
            return self.send({'ok': True})

        editing = resource.startswith('templates/') and '/' not in resource[len('templates/'):]
        if (resource == 'records' and method == 'POST') or (
            (resource == 'templates' and method == 'POST') or (editing and method == 'PUT')
        ):
            data = self.body()
            with FILE_LOCK, transaction() as db:
                self.inspection_writer(db, project_id)
                if resource == 'records':
                    config = inspection.template(db, project_id, data.get('template_id'))
                    record = inspection.save_record(db, project_id, config, data, self.user, now(), uid())
                    log_activity(db, self.user, '保存生产检测', record['id'], record['serial'], record['result'])
                    response = record
                else:
                    self.require_admin()
                    template_id = resource.split('/')[1] if editing else uid()
                    existing = inspection.template(db, project_id, template_id) if editing else None
                    response = inspection.save_template(db, project_id, template_id, data, now(), existing)
                    log_activity(db, self.user, '设置生产检测表', template_id, response['name'],
                                 f"版本 {response['revision']}")
                touch_project(db)
            return self.send(response)
        raise Problem('接口不存在', 404)

    def inspection_writer(self, db, project_id):
        self.user = self.authorized(db)
        if not self.user or self.user['must_change']:
            raise Problem('请先登录', 401)
        enter_project(db, project_id, self.user, write=True)

    def inspection_download(self, payload, name, as_csv):
        content_type = ('text/csv; charset=utf-8' if as_csv else
                        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Content-Disposition', f"attachment; filename*=UTF-8''{quote(name)}")
        self.send_header('Cache-Control', 'no-store')
        self.security_headers()
        self.end_headers()
        self.wfile.write(payload)

    def project_cover(self, project_id, method):
        if method == 'GET':
            with connect() as db:
                db.execute('BEGIN')
                enter_project(db, project_id, self.user)
                row = db.execute('SELECT mime,image FROM project_covers WHERE project_id=?',
                                 (project_id,)).fetchone()
                if not row:
                    raise Problem('未设置项目封面', 404)
            self.send_response(200)
            self.send_header('Content-Type', row['mime'])
            self.send_header('Content-Length', str(len(row['image'])))
            self.send_header('Cache-Control', 'private, no-cache')
            self.security_headers()
            self.end_headers()
            self.wfile.write(row['image'])
            return
        if method == 'POST':
            with connect() as db:
                db.execute('BEGIN')
                project = enter_project(db, project_id, self.user, write=True)
                if self.user['role'] != 'admin' and project['owner_id'] != self.user['id']:
                    raise Problem('无权修改项目封面', 403)
            if int(self.headers.get('Content-Length', '0')) > MAX_COVER + 65536:
                raise Problem('项目封面不能超过 4 MB', 413)
            _, uploads = self.multipart()
            if len(uploads) != 1:
                raise Problem('请选择一张封面图片')
            _, _, image = uploads[0]
            mime = image_mime(image[:12])
            if mime not in ('image/jpeg', 'image/png', 'image/webp'):
                raise Problem('请选择 JPG、PNG 或 WebP 图片')
            if len(image) > MAX_COVER:
                raise Problem('项目封面不能超过 4 MB', 413)
        with FILE_LOCK, transaction() as db:
            user = self.authorized(db)
            if not user or user['must_change']:
                raise Problem('请先登录', 401)
            project = enter_project(db, project_id, user, write=True)
            if user['role'] != 'admin' and project['owner_id'] != user['id']:
                raise Problem('无权修改项目封面', 403)
            if method == 'POST':
                db.execute('''INSERT INTO project_covers VALUES(?,?,?,?)
                              ON CONFLICT(project_id) DO UPDATE SET mime=excluded.mime,
                              image=excluded.image, updated_at=excluded.updated_at''',
                           (project_id, mime, image, now()))
            else:
                db.execute('DELETE FROM project_covers WHERE project_id=?', (project_id,))
            touch_project(db)
            log_activity(db, user, '更新项目封面' if method == 'POST' else '移除项目封面',
                         project_id, project['name'])
        self.send({'ok': True})

    def auth(self, path):
        ip = self.headers.get('X-Real-IP', self.client_address[0]) if BASE_PATH else self.client_address[0]
        recent = [stamp for stamp in self.attempts.get(ip, []) if stamp > time.time() - 600]
        self.attempts[ip] = recent
        if len(recent) >= 12:
            raise Problem('尝试次数过多，请十分钟后重试', 429)
        data = self.body()
        password = data.get('password')
        with FILE_LOCK, transaction() as db:
            if path.endswith('/setup'):
                if os.environ.get('PLM_DISABLE_SETUP') == '1' or db.execute('SELECT 1 FROM users LIMIT 1').fetchone():
                    raise Problem('管理员已经初始化', 409)
                id = create_account(db, {'name': data.get('name') or '管理员',
                                         'email': data.get('email') or 'admin@localhost',
                                         'password': password}, 'admin', must_change=False)
            else:
                recent.append(time.time())
                email = str(data.get('email') or '').strip().lower()
                user = db.execute('SELECT id,password FROM users WHERE email=?', (email,)).fetchone()
                if not user or not check_password(password, user['password']):
                    raise Problem('邮箱或密码不正确', 401)
                id = user['id']
            token = secrets.token_urlsafe(32)
            db.execute('DELETE FROM sessions WHERE expires<?', (time.time(),))
            db.execute('INSERT INTO sessions(token,expires,user_id) VALUES(?,?,?)',
                       (hashlib.sha256(token.encode()).hexdigest(), time.time() + 604800, id))
            actor = db.execute('SELECT id,name FROM users WHERE id=?', (id,)).fetchone()
            log_activity(db, actor, '登录', id, actor['name'])
        self.attempts.pop(ip, None)
        self.send({'ok': True}, extra={'Set-Cookie': self.cookie(token)})

    def update_avatar(self):
        _, files = self.multipart()
        if len(files) != 1:
            raise Problem('请选择一张头像图片')
        _, _, blob = files[0]
        mime = image_mime(blob[:12])
        if not mime or len(blob) > 2 * 1024 * 1024:
            raise Problem('请选择 2 MB 以内的图片')
        with FILE_LOCK, transaction() as db:
            if not self.authorized(db):
                raise Problem('请先登录', 401)
            db.execute('UPDATE users SET avatar=?,avatar_mime=? WHERE id=?', (blob, mime, self.user['id']))
        self.send({'ok': True})

    def serve_avatar(self, id):
        with connect() as db:
            row = db.execute('SELECT avatar,avatar_mime FROM users WHERE id=?', (id,)).fetchone()
        if not row or not row['avatar']:
            raise Problem('头像不存在', 404)
        self.send_response(200)
        self.send_header('Content-Type', image_mime(row['avatar'][:12]) or 'application/octet-stream')
        self.send_header('Content-Length', str(len(row['avatar'])))
        self.send_header('Cache-Control', 'private, no-cache')
        self.security_headers()
        self.end_headers()
        self.wfile.write(row['avatar'])

    def list_activity(self, project_id=None):
        query = parse_qs(urlparse(self.path).query)
        before = int(query.get('before', ['0'])[0])
        subject = query.get('part', [''])[0]
        logins = query.get('kind', [''])[0] == 'login'
        with connect() as db:
            db.execute('BEGIN')
            if project_id:
                enter_project(db, project_id, self.user)
                if logins:
                    raise Problem('请在系统设置查看登录记录', 404)
            elif not logins:
                self.require_admin()
            rows = db.execute(
                """SELECT * FROM activity WHERE (?=0 OR id<?) AND (?='' OR subject_id=?)
                   AND project_id IS ?
                   AND (action IN ('登录','退出登录')) = ?
                   AND (?=0 OR actor_id=?) ORDER BY id DESC LIMIT 101""",
                (before, before, subject, subject, project_id, logins,
                 logins and self.user['role'] != 'admin', self.user['id']),
            ).fetchall()
        self.send({'items': [dict(row) for row in rows[:100]], 'more': len(rows) > 100})

    def mutate_account(self, db, resource, id, method, data):
        actor = self.user
        if resource == 'users':
            self.require_admin()
            if method == 'POST' and not id:
                user_id = create_account(db, data)
                log_activity(db, actor, '新增用户', user_id, account_name(data.get('name')))
                return {'id': user_id}
            if method == 'PUT' and id:
                user = exists(db, 'users', id)
                email = account_email(data.get('email', user['email']))
                name = account_name(data.get('name', user['name']))
                if db.execute('SELECT 1 FROM users WHERE email=? AND id<>?', (email, id)).fetchone():
                    raise Problem('邮箱已使用', 409)
                db.execute('UPDATE users SET name=?,email=? WHERE id=?', (name, email, id))
                return {'id': id}
        if resource == 'reset-password' and method == 'POST' and id:
            self.require_admin()
            if id == actor['id']:
                raise Problem('请在个人资料中修改自己的密码')
            user = exists(db, 'users', id)
            db.execute('UPDATE users SET password=?,must_change=1 WHERE id=?',
                       (password_record(data.get('password')), id))
            db.execute('DELETE FROM sessions WHERE user_id=?', (id,))
            log_activity(db, actor, '重置密码', id, user['name'])
            return {'ok': True}
        if resource == 'account':
            if id == 'profile' and method == 'PUT':
                if set(data) - {'phone'}:
                    raise Problem('只能修改自己的手机号', 403)
                phone = str(data.get('phone') or '').strip()
                if len(phone) > 30:
                    raise Problem('手机号最多 30 个字符')
                db.execute('UPDATE users SET phone=? WHERE id=?', (phone, actor['id']))
                return {'ok': True}
            if id == 'password' and method == 'POST':
                user = exists(db, 'users', actor['id'])
                current = data.get('current_password')
                password = data.get('password')
                if not check_password(current, user['password']):
                    raise Problem('当前密码不正确')
                db.execute('UPDATE users SET password=?,must_change=0 WHERE id=?',
                           (password_record(password), actor['id']))
                db.execute('DELETE FROM sessions WHERE user_id=? AND token<>?',
                           (actor['id'], self.session_token()))
                return {'ok': True}
        raise Problem('不支持的账户操作', 405)

    def change_part_suppliers(self, db, part_id, changes):
        if not isinstance(changes, dict) or changes.keys() - {'add', 'remove', 'create'}:
            raise Problem('供应商关联格式错误')
        add, remove, names = (changes.get(key, []) for key in ('add', 'remove', 'create'))
        if any(not isinstance(items, list) or any(not isinstance(value, str) or not value.strip()
                                                   for value in items) for items in (add, remove, names)):
            raise Problem('供应商关联格式错误')
        linked = dict.fromkeys(add)
        for name in dict.fromkeys(name.strip() for name in names):
            matches = db.execute('SELECT id FROM suppliers WHERE project_id=? AND name=? COLLATE NOCASE LIMIT 2',
                                 (db.project_id, name)).fetchall()
            if len(matches) > 1:
                raise Problem(f'有多个名为「{name}」的供应商，请从列表选择', 409)
            supplier_id = matches[0]['id'] if matches else self.mutate(
                db, '/api/suppliers', 'POST', {'name': name})['id']
            linked[supplier_id] = None
        if set(linked).intersection(remove):
            raise Problem('同一供应商不能同时添加和移除')
        for supplier_id in linked:
            if not db.execute('SELECT 1 FROM quotes WHERE project_id=? AND part_id=? AND supplier_id=?',
                              (db.project_id, part_id, supplier_id)).fetchone():
                self.mutate(db, '/api/quotes', 'POST', {'part_id': part_id, 'supplier_id': supplier_id})
        db.executemany('DELETE FROM quotes WHERE project_id=? AND part_id=? AND supplier_id=?',
                       ((db.project_id, part_id, supplier_id) for supplier_id in remove))

    def mutate(self,db,path,method,d):
        seg=path.strip('/').split('/'); resource=seg[1]; id=seg[2] if len(seg)>2 else None
        if resource in ('users', 'account', 'reset-password'):
            return self.mutate_account(db, resource, id, method, d)
        if not db.project_id:
            raise Problem('请先选择项目', 404)
        if resource=='electronic-import' and id=='commit' and method=='POST': return self.commit_electronic_import(db,d)
        if resource=='material-cells' and method=='PUT':
            allowed={'spec','unit','price','min_stock','location','notes','category','material_level','external_code','brand'}
            if not d or set(d)-allowed: raise Problem('该字段不能在表格中修改')
            return self.mutate(db,'/api/parts/'+str(id),'PUT',d)
        if resource=='material-links':
            if method=='POST': return {'id':link_material(db,d.get('parent_id'),d.get('child_id'),d.get('qty',1))}
            if method=='PUT':
                link=exists(db,'material_links',id)
                link_material(db,link['parent_id'],link['child_id'],d.get('qty',link['qty']))
                db.execute('UPDATE material_links SET reference=?,notes=? WHERE id=?',(str(d.get('reference',link['reference'])),str(d.get('notes',link['notes'])),id))
                return {'id':id}
            if method=='DELETE':
                exists(db,'material_links',id);db.execute('DELETE FROM material_links WHERE id=?',(id,));return {'ok':True}
        if resource=='material-children' and method=='PUT':
            set_material_children(db,id,d.get('child_ids'));return {'ok':True}
        if resource=='material-parents' and method=='PUT':
            set_material_parents(db,id,d.get('parent_ids'));return {'ok':True}
        if resource=='movements' and method=='POST': return {'id':record_movement(db,d,self.user)}
        if resource=='demo' and method=='POST':
            self.require_admin()
            if any(db.execute(f'SELECT 1 FROM {t} WHERE project_id=? LIMIT 1', (db.project_id,)).fetchone()
                   for t in ('products','parts','suppliers','purchases','movements')):
                raise Problem('仅空项目可以载入示例')
            seed_demo(db); log_activity(db, self.user, '载入示例', '', '示例数据'); return {'ok':True}
        if resource=='bom-versions' and method=='POST':
            exists(db,'products',d['product_id']); bid=uid()
            db.execute('UPDATE products SET updated_at=? WHERE id=?',(now(),d['product_id']))
            insert_scoped(db, 'bom_versions', dict(id=bid, product_id=d['product_id'], name=automatic_version(db,d['product_id']), notes=str(d.get('notes','')), created_at=now()))
            if d.get('copy_from'):
                v=exists(db,'bom_versions',d['copy_from'])
                if v['product_id']!=d['product_id']: raise Problem('仅可复制本产品的 BOM')
                for line in db.execute('SELECT * FROM bom_lines WHERE version_id=? ORDER BY rowid',(v['id'],)).fetchall():
                    insert_bom_line(db, bid, line['part_id'], line['qty'], line['reference'], line['notes'])
            return {'id':bid}
        if resource=='bom-materials' and method=='POST':
            version=exists(db,'bom_versions',d.get('version_id'))
            part=self.mutate(db,'/api/parts','POST',{**d,'numbering_product_id':version['product_id']})
            line=self.mutate(db,'/api/bom-lines','POST',{'version_id':version['id'],'part_id':part['id'],'qty':d.get('qty',1)})
            return {'id':part['id'],'line_id':line['id']}
        if resource=='bom-lines':
            if method=='DELETE':
                line=exists(db,'bom_lines',id)
                version=exists(db,'bom_versions',line['version_id'])
                db.execute('UPDATE products SET updated_at=? WHERE id=?',(now(),version['product_id']))
                db.execute('DELETE FROM bom_lines WHERE id=?',(id,))
                part = exists(db, 'parts', line['part_id'])
                log_activity(db, self.user, 'BOM 移除物料', part['id'], f"{part['code']} {part['name']}", version['name'])
                return {'ok':True}
            if method in ('POST','PUT'):
                if method=='PUT': d={**exists(db,'bom_lines',id),**d}
                version=exists(db,'bom_versions',d['version_id']); part=active_part(db,d['part_id'])
                db.execute('UPDATE products SET updated_at=? WHERE id=?',(now(),version['product_id']))
                values=(d['version_id'],d['part_id'],num(d.get('qty'),True),str(d.get('reference','')),str(d.get('notes','')))
                if method=='POST':
                    id = insert_bom_line(db, *values)
                else:
                    exists(db,'bom_lines',id); db.execute('UPDATE bom_lines SET version_id=?,part_id=?,qty=?,reference=?,notes=? WHERE id=?',(*values,id))
                log_activity(db, self.user, 'BOM 新增物料' if method=='POST' else 'BOM 修改物料',
                             part['id'], f"{part['code']} {part['name']}", f"{version['name']} · 用量 {values[2]:g}")
                return {'id':id}
        if resource=='bom-import' and method=='POST':
            version=exists(db,'bom_versions',d['version_id']); count=0
            db.execute('UPDATE products SET updated_at=? WHERE id=?',(now(),version['product_id']))
            if not isinstance(d.get('rows'),list) or len(d['rows'])>5000: raise Problem('每次最多导入 5000 行')
            for i,row in enumerate(d['rows']):
                code=str(row.get('code','')).strip()
                part=find_part_code(db, code)
                if not part: raise Problem(f'第 {i+1} 行物料编码不存在，请先建立物料：{row.get("code","")}')
                active_part(db, part[0])
                insert_bom_line(db, version['id'], part[0], num(row.get('qty'), True), str(row.get('reference','')), str(row.get('notes','')), upsert=True); count+=1
            log_activity(db, self.user, '导入 BOM', version['product_id'], version['name'], f'{count} 条明细')
            return {'count':count}
        if resource == 'purchases' and method == 'PUT':
            purchase = exists(db, 'purchases', id)
            if set(d) != {'responsible_id'} or not d['responsible_id']:
                raise Problem('请选择采购负责人')
            owner = assign_user(db, d['responsible_id'])
            db.execute('UPDATE purchases SET responsible_id=? WHERE id=?', (owner, id))
            log_activity(db, self.user, '修改采购负责人', id, purchase['code'], exists(db, 'users', owner)['name'])
            return {'id': id}
        if resource=='purchases' and method=='POST':
            supplier_id = exists(db, 'suppliers', d['supplier_id'])['id']
            id = uid()
            if not d.get('lines'): raise Problem('请至少添加一个采购物料')
            date=required(d.get('date'),'采购日期')
            try: datetime.strptime(date,'%Y-%m-%d')
            except ValueError: raise Problem('采购日期格式错误')
            responsible = assign_user(db, d.get('responsible_id') or self.user['id'])
            code = next_code(db, 'PO')
            insert_scoped(db, 'purchases', dict(id=id, code=code, supplier_id=supplier_id, date=date,
                                                notes=str(d.get('notes','')), created_at=now(), responsible_id=responsible))
            for line in d['lines']:
                part = active_part(db, line['part_id'])
                linked = db.execute(
                    'SELECT 1 FROM quotes WHERE part_id=? AND supplier_id=?',
                    (part['id'], supplier_id),
                ).fetchone()
                if not linked:
                    raise Problem(f'所选供应商未关联物料「{part["name"]}」', 409)
                insert_scoped(db, 'purchase_lines', dict(id=uid(), purchase_id=id, part_id=part['id'],
                                                         qty=num(line['qty'], True), price=num(line['price']), received=0))
            log_activity(db, self.user, '新增采购单', id, code, exists(db, 'users', responsible)['name'])
            return {'id':id}
        if resource == 'quotes' and method == 'POST':
            part_id = d['part_id']
            supplier_id = d['supplier_id']
            active_part(db, part_id)
            exists(db, 'suppliers', supplier_id)
            previous = db.execute('SELECT * FROM quotes WHERE part_id=? AND supplier_id=?',
                                  (part_id, supplier_id)).fetchone()
            url = str(d.get('url', previous['url'] if previous else '') or '').strip()
            if url and urlparse(url).scheme not in ('http', 'https'):
                raise Problem('采购链接必须以 http:// 或 https:// 开头')
            raw_price = d.get('price', previous['price'] if previous else None)
            price = None if raw_price in (None, '') else num(raw_price)
            if previous:
                id = previous['id']
                db.execute('UPDATE quotes SET price=?,url=? WHERE id=?', (price, url, id))
            else:
                id = uid()
                insert_scoped(db, 'quotes', dict(id=id, part_id=part_id, supplier_id=supplier_id, price=price, url=url))
            return {'id': id}
        if resource=='quotes' and method=='DELETE':
            exists(db, 'quotes', id); db.execute('DELETE FROM quotes WHERE id=?',(id,)); return {'ok':True}
        if resource=='files' and method=='DELETE':
            f=exists(db,'files',id); db.execute('DELETE FROM files WHERE id=?',(id,))
            return {'ok':True,'_delete_files':[id]}
        if resource == 'deleted-parts' and method == 'PUT':
            part = exists(db, 'parts', id)
            if part['deleted_at']:
                db.execute('UPDATE parts SET deleted_at=NULL, updated_at=? WHERE id=?', (now(), id))
                log_activity(db, self.user, '恢复物料', id, f"{part['code']} {part['name']}")
            return {'id': id}
        if resource in ('products','parts','suppliers'):
            if method=='DELETE':
                if resource == 'products':
                    self.require_admin_password(db, d.get('password'))
                record = exists(db, resource, id)
                if resource == 'parts':
                    if not record['deleted_at']:
                        stamp = now()
                        db.execute('UPDATE parts SET deleted_at=?,updated_at=? WHERE id=?', (stamp, stamp, id))
                        log_activity(db, self.user, '删除物料', id, f"{record['code']} {record['name']}")
                    return {'ok': True}
                if resource == 'products':
                    if db.execute('SELECT 1 FROM movements WHERE product_id=? LIMIT 1', (id,)).fetchone():
                        raise Problem('产品有关联的库存流水，请在编辑产品中将状态设为已归档', 409)
                    has_bom = db.execute(
                        """SELECT 1 FROM bom_lines AS line JOIN bom_versions AS version
                           ON line.version_id = version.id WHERE version.product_id=? LIMIT 1""",
                        (id,),
                    ).fetchone()
                    if has_bom and d.get('delete_bom') is not True:
                        raise Problem('请确认一并删除该产品的所有 BOM 版本和明细', 409)
                    db.execute('DELETE FROM bom_versions WHERE product_id=?', (id,))
                    # The numbering link determines future prefixes, not material ownership.
                    db.execute('UPDATE parts SET numbering_product_id=NULL WHERE numbering_product_id=?', (id,))
                    log_activity(db, self.user, '删除产品', id, f"{record['code']} {record['name']}")
                db.execute(f'DELETE FROM {resource} WHERE id=?',(id,))
                removed=[r[0] for r in db.execute('SELECT id FROM files WHERE owner_type=? AND owner_id=?',(resource,id))]
                db.execute('DELETE FROM files WHERE owner_type=? AND owner_id=?',(resource,id)); return {'ok':True,'_delete_files':removed}
            if method not in ('POST','PUT'): raise Problem('不支持的操作',405)
            old=(active_part(db,id) if resource == 'parts' else exists(db,resource,id)) if method=='PUT' else None
            parent_ids=d.get('parent_ids')
            if resource=='parts' and old and 'stock' in d and num(d['stock'])!=old['stock']: raise Problem('库存只能通过库存操作更新')
            if old: d={**old,**d}
            if resource=='parts' and d.get('sub_product_id'): raise Problem('不支持关联子 BOM')
            values={'name':required(d.get('name'))}
            if resource=='products':
                values.update(code=old['code'] if old else automatic_code(db,'products','PRD'),english_code=normalize_english_code(d.get('english_code','')),description=str(d.get('description','')),status=d.get('status') or '研发中',updated_at=now())
                if values['status'] not in ('研发中','已定版','已归档'): raise Problem('产品状态不正确')
            elif resource=='parts':
                level=material_level(d.get('material_level',1))
                category=d.get('category') or ('电子物料' if level==2 else '结构物料')
                if category not in ('结构物料','电子物料'): raise Problem('物料类别不正确')
                if old and old['material_level']!=level and db.execute('SELECT 1 FROM material_links WHERE parent_id=? OR child_id=?',(id,id)).fetchone(): raise Problem('请先解除一级、二级物料关联，再更改级别')
                numbering_product_id=d.get('numbering_product_id') or None
                if not old and 'numbering_product_id' not in d and level==2 and parent_ids:
                    if not isinstance(parent_ids,list) or any(not isinstance(x,str) for x in parent_ids): raise Problem('关联记录格式错误')
                    sources={exists(db,'parts',parent)['numbering_product_id'] for parent in parent_ids}
                    if len(sources)==1 and None not in sources: numbering_product_id=next(iter(sources))
                if numbering_product_id: exists(db,'products',numbering_product_id)
                serial=old['material_serial'] if old else next_material_serial(db)
                code=old['code'] if old else material_code(db,category,level,numbering_product_id,serial)
                if old and (old['category']!=category or old['material_level']!=level or old['numbering_product_id']!=numbering_product_id):
                    insert_scoped(db, 'material_code_aliases', dict(code=old['code'], part_id=id), 'ON CONFLICT(code) DO NOTHING')
                    code=material_code(db,category,level,numbering_product_id,serial)
                values.update(code=code,material_serial=serial,numbering_product_id=numbering_product_id,material_level=level,category=category,spec=str(d.get('spec','')),external_code=str(d.get('external_code','')).strip(),brand=str(d.get('brand','')).strip(),unit=str(d.get('unit','') or '').strip() or 'PCS',price=num(d.get('price') or 0),min_stock=num(d.get('min_stock') or 0),location=str(d.get('location','')),sub_product_id=None,notes=str(d.get('notes','')),updated_at=now())
            else: values.update({k:str(d.get(k,'')) for k in ('contact','phone','email','address','notes')})
            if resource in RESPONSIBILITIES:
                column = RESPONSIBILITIES[resource]
                values[column] = old[column] if old and old[column] == d.get(column) else assign_user(db, d.get(column))
            if method=='POST':
                id=uid(); values.update(id=id,created_at=now())
                insert_scoped(db, resource, values)
                if resource=='products':
                    insert_scoped(db, 'bom_versions', dict(id=uid(), product_id=id, name='V1.0', notes='初始版本', created_at=now()))
            else:
                exists(db,resource,id); db.execute(f'UPDATE {resource} SET '+','.join(k+'=?' for k in values)+' WHERE id=?',(*values.values(),id))
            if resource=='products' and old and old['english_code']!=values['english_code']:
                for material in db.execute('SELECT * FROM parts WHERE numbering_product_id=?',(id,)).fetchall():
                    expected=material_prefix(material['category'],material['material_level'],product_prefix(db,id))
                    if not material['code'].startswith(expected):
                        insert_scoped(db, 'material_code_aliases', dict(code=material['code'], part_id=material['id']), 'ON CONFLICT(code) DO NOTHING')
                        db.execute('UPDATE parts SET code=?,updated_at=? WHERE id=?',(material_code(db,material['category'],material['material_level'],id,material['material_serial']),now(),material['id']))
            if resource=='parts' and parent_ids is not None:
                if values['material_level']!=2 and parent_ids: raise Problem('只有二级物料可以选择关联一级物料')
                if values['material_level']==2: set_material_parents(db,id,parent_ids)
            if resource=='parts' and 'supplier_changes' in d:
                self.change_part_suppliers(db, id, d['supplier_changes'])
            if resource in ('parts', 'products'):
                noun = '物料' if resource == 'parts' else '产品'
                log_activity(db, self.user, ('新增' if method == 'POST' else '修改') + noun,
                             id, f"{values['code']} {values['name']}")
            return {'id':id}
        raise Problem('接口不存在或不支持该操作',404)
    def electronic_preview(self, project_id):
        fields,uploads=self.multipart()
        if len(uploads)!=1: raise Problem('请选择一个 XLSX 或 CSV 文件')
        filename,mime,blob=uploads[0]
        try:
            result=parse_electronic_file(blob,filename,fields.get('sheet',''))
        except (ElectronicBomError,ValueError,KeyError,RuntimeError) as exc: raise Problem(str(exc))
        with connect() as db:
            db.execute('BEGIN')
            enter_project(db, project_id, self.user, write=True)
            candidates=electronic_candidates(db)
            for row in result['rows']:
                try:
                    material=self.match_electronic_material(db,row,candidates)
                    row.update(match_id=material['id'] if material else None,match_code=material['code'] if material else '',match_price=material['price'] if material else None)
                    if material and material['unit'].casefold()!=row['unit'].casefold(): row['warnings'].append('现有单位不同，复用时保留现有单位')
                except Problem as exc: row['match_error']=exc.message;row['selected']=False
        self.send(result)
    def match_electronic_material(self,db,row,candidates=None):
        if row.get('target_part_id')=='__new__': return None
        if row.get('target_part_id'):
            material=active_part(db,row['target_part_id'])
            if material['material_level']!=2: raise Problem('只能复用二级物料')
            return material
        code=str(row.get('internal_code','')).strip()
        if code:
            found=find_part_code(db, code)
            if not found: raise Problem('系统物料编号不存在：'+code)
            material=active_part(db,found[0])
            if material['material_level']!=2: raise Problem('系统编号对应的不是二级物料')
            return material
        key=lambda r: tuple(str(r.get(k) or '').strip().casefold() for k in ('external_code','name','spec','brand'))
        if candidates is None: candidates=electronic_candidates(db)
        matches=[p for p in candidates if key(p)==key(row)]
        if len(matches)>1: raise Problem('有多个匹配物料，请手动选择复用记录')
        return matches[0] if matches else None
    def commit_electronic_import(self,db,d):
        request_id=str(d.get('request_id',''))
        if not 16<=len(request_id)<=80 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' for c in request_id): raise Problem('导入请求标识无效')
        body={k:v for k,v in d.items() if k!='request_id'}
        fingerprint=hashlib.sha256(json.dumps(body,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        previous=db.execute('SELECT * FROM import_runs WHERE project_id=? AND id=?', (db.project_id, request_id)).fetchone()
        if previous:
            if previous['fingerprint']!=fingerprint: raise Problem('本次导入已完成，修改文件后请重新导入',409)
            return json.loads(previous['result'])
        rows=d.get('rows')
        if not isinstance(rows,list) or not 1<=len(rows)<=5000: raise Problem('请选择 1 至 5000 条物料')
        parent_id=d.get('parent_id') or None;version_id=d.get('version_id') or None
        parent=active_part(db,parent_id) if parent_id else None
        if parent and parent['material_level']!=1: raise Problem('关联目标必须是一级物料')
        version=exists(db,'bom_versions',version_id) if version_id else None
        source=parent['numbering_product_id'] if parent else version['product_id'] if version else d.get('numbering_product_id') or None
        if source: exists(db,'products',source)
        candidates=electronic_candidates(db)
        groups={};created=0;created_ids=set();reused=set()
        for index,raw in enumerate(rows,1):
            if not isinstance(raw,dict): raise Problem('导入行格式错误')
            row={k:str(raw.get(k) or '').strip() for k in ('name','external_code','internal_code','spec','brand','notes','reference','unit','target_part_id')}
            row['name']=required(row['name'],f'第 {index} 行名称')
            if any(len(v)>1000 for v in row.values()): raise Problem(f'第 {index} 行文本过长')
            row['qty']=num(raw.get('qty'),True)
            row['price']=num(raw.get('price') if raw.get('price') is not None else 0)
            material=self.match_electronic_material(db,row,candidates)
            if material is None:
                saved=self.mutate(db,'/api/parts','POST',{**row,'material_level':2,'category':'电子物料','numbering_product_id':source,'unit':row['unit'] or 'PCS'})
                material=exists(db,'parts',saved['id']);candidates.append(material);created+=1;created_ids.add(material['id'])
            else:
                if material['id'] not in created_ids: reused.add(material['id'])
                if d.get('update_existing_prices'):
                    db.execute('UPDATE parts SET price=?,updated_at=? WHERE id=?',(row['price'],now(),material['id']))
            mid=material['id']
            if mid not in groups: groups[mid]={'qty':0,'reference':[],'notes':[]}
            groups[mid]['qty']=num(groups[mid]['qty']+row['qty'],True)
            for field in ('reference','notes'):
                if row[field] and row[field] not in groups[mid][field]: groups[mid][field].append(row[field])
        total=0
        for mid,group in groups.items():
            reference=', '.join(group['reference']);notes='\n'.join(group['notes'])
            if parent_id:
                link_id=link_material(db,parent_id,mid,group['qty'])
                db.execute('UPDATE material_links SET reference=?,notes=? WHERE id=?',(reference,notes,link_id))
            if version_id:
                insert_bom_line(db, version_id, mid, group['qty'], reference, notes, upsert=True)
            total+=exists(db,'parts',mid)['price']*group['qty']
        if version: db.execute('UPDATE products SET updated_at=? WHERE id=?',(now(),version['product_id']))
        result={'rows':len(rows),'materials':len(groups),'created':created,'reused':len(reused),'reference_total':round(total,6)}
        insert_scoped(db, 'import_runs', dict(id=request_id, fingerprint=fingerprint, result=json.dumps(result), created_at=now()))
        log_activity(db, self.user, '导入二级物料', parent_id or (version['product_id'] if version else ''),
                     '电子物料 BOM', f'新建 {created} 项 · 复用 {len(reused)} 项')
        return result
    def multipart(self):
        raw=self.body(); content=self.headers.get('Content-Type','')
        msg=BytesParser(policy=default).parsebytes(('Content-Type: '+content+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+raw)
        fields={}; uploads=[]
        if not msg.is_multipart(): raise Problem('上传格式错误')
        for part in msg.iter_parts():
            key=part.get_param('name',header='content-disposition')
            if part.get_filename(): uploads.append((part.get_filename(),part.get_content_type(),part.get_payload(decode=True)))
            else: fields[key]=part.get_payload(decode=True).decode('utf-8')
        return fields,uploads
    def upload(self, project_id):
        fields,uploads=self.multipart()
        owner=fields.get('owner_type'); owner_id=fields.get('owner_id'); replace_id=fields.get('replace_id')
        if owner not in ('products','parts') or not uploads: raise Problem('请选择上传文件')
        if len(uploads)>12 or (replace_id and len(uploads)!=1): raise Problem('单次最多上传 12 个文件；替换请选择一个文件')
        created=[]
        try:
            with transaction() as db:
                user = self.authorized(db)
                if not user or user['must_change']:
                    raise Problem('请先登录', 401)
                enter_project(db, project_id, user, write=True)
                exists(db,owner,owner_id)
                db.execute(f'UPDATE {owner} SET updated_at=? WHERE id=?',(now(),owner_id))
                old=None
                if replace_id:
                    old=exists(db,'files',replace_id)
                    if old['owner_type']!=owner or old['owner_id']!=owner_id: raise Problem('不能替换其他记录的附件')
                for filename, _, blob in uploads:
                    if not blob:
                        raise Problem('不能上传空文件')
                    fid = uid()
                    name = Path(filename.replace('\\', '/')).name[:200]
                    ext = Path(name).suffix.lower()
                    image_type = IMAGE_MIMES.get(ext)
                    mime = image_type or ('application/pdf' if ext == '.pdf' else 'application/octet-stream')
                    kind = 'image' if image_type else 'attachment'
                    if image_type and image_mime(blob[:12]) != image_type:
                        raise Problem('图片格式与文件内容不匹配')
                    created.append(fid)
                    (DATA / 'uploads' / fid).write_bytes(blob)
                    if old:
                        # Replacing an image keeps its position and changes the
                        # URL so a previously cached image is not reused.
                        db.execute('UPDATE files SET id=?,name=?,mime=?,size=?,kind=?,created_at=? WHERE id=?',
                                   (fid, name, mime, len(blob), kind, now(), old['id']))
                    else:
                        insert_scoped(db, 'files', dict(id=fid, owner_type=owner, owner_id=owner_id,
                                                       name=name, mime=mime, size=len(blob),
                                                       kind=kind, created_at=now()))
                touch_project(db)
        except Exception:
            for fid in created:
                remove_upload(fid)
            raise
        if replace_id:
            remove_upload(replace_id)
        self.send({'ids': created})

    def serve_file(self, id):
        with connect() as db:
            db.execute('BEGIN')
            f = exists(db, 'files', id)
            enter_project(db, f['project_id'], self.user)
            name = f['name']
            owner = f['owner_type']
            record = db.execute(f'SELECT code,name FROM {owner} WHERE id=?', (f['owner_id'],)).fetchone()
            if record:
                position = db.execute(
                    """SELECT COUNT(*) FROM files WHERE owner_type=? AND owner_id=?
                       AND rowid <= (SELECT rowid FROM files WHERE id=?)""",
                    (owner, f['owner_id'], id),
                ).fetchone()[0]
                name = owner_file_name(name, record['code'], record['name'], position)
        path = DATA / 'uploads' / id
        if not path.is_file():
            raise Problem('文件未找到', 404)
        b = path.read_bytes()
        self.send_response(200)
        image_type = image_mime(b[:12]) if f['kind'] == 'image' else None
        content_type = image_type or ('application/pdf' if f['mime'] == 'application/pdf' else 'application/octet-stream')
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(b)))
        disposition = 'inline' if image_type else 'attachment'
        self.send_header('Content-Disposition', f"{disposition}; filename*=UTF-8''{quote(name, safe='')}")
        self.security_headers()
        self.send_header('Cache-Control', 'private, no-cache')
        self.end_headers()
        self.wfile.write(b)
    def backup(self):
        with tempfile.TemporaryDirectory(dir=DATA) as folder:
            output = Path(folder) / 'backup.zip'
            write_backup(output)
            self.send_response(200)
            self.send_header('Content-Type', 'application/zip')
            self.send_header('Content-Disposition', 'attachment; filename="jiecheng-plm-backup-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.zip"')
            self.send_header('Content-Length', str(output.stat().st_size))
            self.send_header('Cache-Control', 'no-store')
            self.security_headers()
            self.end_headers()
            with output.open('rb') as source:
                shutil.copyfileobj(source, self.wfile, 1024 * 1024)

    def restore(self):
        size = int(self.headers.get('Content-Length', '0'))
        if size <= 0 or size > MAX_RESTORE:
            raise Problem('请选择不超过 1 GB 的 ZIP 备份', 413)
        if self.headers.get('X-PLM-Restore') != 'replace':
            raise Problem('请确认覆盖当前数据')
        with tempfile.TemporaryDirectory(dir=DATA) as folder:
            directory = Path(folder)
            archive = directory / 'restore.zip'
            with archive.open('wb') as target:
                remaining = size
                while remaining:
                    chunk = self.rfile.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise Problem('备份上传不完整')
                    target.write(chunk)
                    remaining -= len(chunk)
            try:
                staged, version = stage_restore(archive, directory)
            except (zipfile.BadZipFile, sqlite3.Error, RuntimeError, NotImplementedError, ValueError) as exc:
                raise Problem('ZIP 或备份数据库无法读取') from exc
            with FILE_LOCK:
                self.apply_restore(staged, version, directory)
        self.send({'ok': True}, extra={'Set-Cookie': self.cookie('', 0)})

    def apply_restore(self, staged, version, directory):
        copied = []
        with connect() as live, connect(staged) as recovered:
            admin = self.authorized(live)
            if not admin or admin['role'] != 'admin' or admin['must_change']:
                raise Problem('请重新登录管理员账户', 403)
            if version == 6:
                # Legacy archives predate user accounts. Keep the current directory.
                recovered.executemany('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)',
                                      live.execute('SELECT * FROM users'))
                recovered.execute('UPDATE projects SET owner_id=? WHERE id=?',
                                  (admin['id'], LEGACY_PROJECT_ID))
                recovered.execute('INSERT INTO project_members SELECT p.id,u.id FROM projects p CROSS JOIN users u WHERE p.id=?',
                                  (LEGACY_PROJECT_ID,))
            for row in live.execute("SELECT key,value FROM settings WHERE key LIKE 'sequence_%'"):
                current = recovered.execute('SELECT value FROM settings WHERE key=?', (row['key'],)).fetchone()
                if not current or int(row['value']) > int(current['value']):
                    recovered.execute('INSERT OR REPLACE INTO settings VALUES(?,?)', tuple(row))
            log_activity(recovered, admin, '恢复备份', '', 'ZIP 数据备份')
            old_files = {r[0] for r in live.execute('SELECT id FROM files')}
            rollback = directory / 'before-restore.zip'
            write_backup(rollback)
            rollback.replace(DATA / 'before-restore.zip')
            try:
                for (old_id,) in recovered.execute('SELECT id FROM files').fetchall():
                    id = uid()
                    destination = DATA / 'uploads' / id
                    copied.append(id)
                    (staged / 'uploads' / old_id).replace(destination)
                    recovered.execute('UPDATE files SET id=? WHERE id=?', (id, old_id))
                recovered.commit()
                recovered.backup(live)
            except Exception:
                for id in copied:
                    remove_upload(id)
                raise
            for id in old_files:
                remove_upload(id)

    def static(self,path):
        base=(ROOT/'dist').resolve(); file=(base/path.lstrip('/')).resolve()
        if not file.is_relative_to(base): raise Problem('无效路径',403)
        if not file.is_file(): file=base/'index.html'
        if not file.is_file(): raise Problem('前端尚未构建，请执行 npm install 和 npm run build',503)
        b=file.read_bytes(); self.send_response(200); self.send_header('Content-Type',mimetypes.guess_type(file.name)[0] or 'application/octet-stream'); self.send_header('Content-Length',str(len(b))); self.security_headers(); self.end_headers(); self.wfile.write(b)

def seed_demo(db):
    suppliers=[('s1','立创商城','采购客服','400-830-5888','support@szlcsc.com','深圳市','电子元件采购'),('s2','精工结构件供应商','陈工','','','东莞市','结构件加工与打样')]
    products=[('p1','PRD-001','桌面空气监测仪','面向桌面环境的温湿度与空气质量监测终端','研发中'),('p2','PRD-002','便携式温控器','小型便携温度采集与控制设备','研发中'),('p3','PRD-003','无线传感节点','低功耗无线环境数据采集节点','研发中'),('p4','ASM-001','主控电路板组件','空气监测仪主控 PCB 与电子元件','已定版')]
    parts=[('m1','MEC-0001','铝合金外壳','结构物料','CNC / 6061 / 阳极氧化','件',48,10,'A-01',None),('m2','MEC-0002','亚克力显示面板','结构物料','透明 / 2 mm / 激光切割','件',8.5,20,'A-02',None),('m3','ELE-0001','主控电路板组件','电子物料','STM32 / PCB Rev.A','块',86,5,'B-01','p4'),('m4','ELE-0002','温湿度传感器','电子物料','SHT30-DIS-B / I²C','个',12.8,30,'B-02',None),('m5','ELE-0003','USB-C 连接器','电子物料','16 Pin / 沉板 / 母座','个',1.25,50,'B-03',None),('m6','MEC-0003','不锈钢螺钉','结构物料','M2 × 6 / 十字盘头','个',0.12,100,'A-03',None),('m7','ELE-0004','微控制器','电子物料','STM32G030F6P6 / TSSOP20','个',5.6,20,'B-04',None),('m8','ELE-0005','贴片电阻','电子物料','10 kΩ / 0603 / ±1%','个',0.02,200,'B-05',None)]
    supplier_ids, product_ids, version_ids, part_ids = {}, {}, {}, {}
    for key, name, contact, phone, email, address, notes in suppliers:
        supplier_ids[key] = uid()
        insert_scoped(db, 'suppliers', dict(id=supplier_ids[key], name=name, contact=contact,
                                           phone=phone, email=email, address=address, notes=notes, created_at=now()))
    for product, english_code in zip(products, ('AIR', 'TEMP', 'NODE', 'CTRL')):
        key, _, name, description, status = product
        product_ids[key], version_ids[key] = uid(), uid()
        insert_scoped(db, 'products', dict(id=product_ids[key], code=automatic_code(db, 'products', 'PRD'),
                                          english_code=english_code, name=name, description=description,
                                          status=status, created_at=now(), updated_at=now()))
        insert_scoped(db, 'bom_versions', dict(id=version_ids[key], product_id=product_ids[key],
                                              name='V1.0', notes='示例初始版本', created_at=now()))
    for key, _, name, category, spec, unit, price, minimum, location, _ in parts:
        part_ids[key] = uid()
        level = 2 if key in ('m7', 'm8') else 1
        serial = next_material_serial(db)
        owner = product_ids['p1']
        insert_scoped(db, 'parts', dict(id=part_ids[key], code=material_code(db, category, level, owner, serial),
                                       name=name, category=category, spec=spec, unit=unit, price=price,
                                       min_stock=minimum, location=location, material_level=level,
                                       numbering_product_id=owner, material_serial=serial,
                                       created_at=now(), updated_at=now()))
        electronic = category == '电子物料'
        insert_scoped(db, 'quotes', dict(id=uid(), part_id=part_ids[key], price=price,
                                        supplier_id=supplier_ids['s1' if electronic else 's2'],
                                        url='https://www.szlcsc.com' if electronic else ''))
    for product, lines in [
        ('p1', [('m1', 1), ('m2', 1), ('m3', 1), ('m4', 1), ('m5', 1), ('m6', 4), ('m7', 1), ('m8', 12)]),
        ('p2', [('m1', 1), ('m4', 1), ('m5', 1), ('m6', 4)]),
        ('p3', [('m4', 1), ('m7', 1)]), ('p4', [('m7', 1), ('m8', 12), ('m5', 1)]),
    ]:
        for part, qty in lines:
            insert_bom_line(db, version_ids[product], part_ids[part], qty)
    for part, qty in [('m1',24), ('m2',36), ('m3',8), ('m4',18), ('m5',120), ('m6',350), ('m7',45), ('m8',1500)]:
        record_movement(db, dict(type='入库', part_id=part_ids[part], qty=qty, reason='示例期初入库'))
    purchase_id, first_line_id = uid(), uid()
    insert_scoped(db, 'purchases', dict(id=purchase_id, code=next_code(db, 'PO'), supplier_id=supplier_ids['s1'],
                                      date=datetime.now().strftime('%Y-%m-%d'), notes='示例采购单', created_at=now()))
    insert_scoped(db, 'purchase_lines', dict(id=first_line_id, purchase_id=purchase_id, part_id=part_ids['m4'],
                                            qty=50, price=12.8))
    insert_scoped(db, 'purchase_lines', dict(id=uid(), purchase_id=purchase_id, part_id=part_ids['m5'],
                                            qty=100, price=1.25))
    record_movement(db, dict(type='入库', part_id=part_ids['m4'], qty=10,
                             purchase_line_id=first_line_id, reason='示例采购分批到货'))
    record_movement(db, dict(type='出库', part_id=part_ids['m4'], qty=4,
                             product_id=product_ids['p1'], reason='示例样机研发领料'))
    link_material(db, part_ids['m3'], part_ids['m7'], 1)
    link_material(db, part_ids['m3'], part_ids['m8'], 12)

if __name__=='__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default=os.environ.get('PLM_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('PLM_PORT', '8787')))
    parser.add_argument('--bootstrap-admin', nargs=2, metavar=('NAME', 'EMAIL'),
                        help='初始化管理员，从标准输入读取临时密码')
    args = parser.parse_args()
    if args.bootstrap_admin:
        name, email = args.bootstrap_admin
        try:
            init_db(bootstrap={'name': name, 'email': email, 'password': sys.stdin.readline().rstrip('\r\n')})
        except Problem as exc:
            raise SystemExit(exc.message)
        print('管理员已初始化，首次登录须修改密码。')
        raise SystemExit(0)
    init_db()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'捷程未来PLM  http://{args.host}:{args.port}  数据目录：{DATA}',flush=True)
    stop_cleanup = threading.Event()
    threading.Thread(target=run_image_cleanup, args=(stop_cleanup,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_cleanup.set()
        server.server_close()

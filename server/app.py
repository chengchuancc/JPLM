#!/usr/bin/env python3
"""捷程未来PLM：仅依赖 Python 3.10+ 标准库。"""
import argparse, hashlib, hmac, io, json, math, mimetypes, os, re, secrets, sqlite3, sys, time, threading, shutil, tempfile, zipfile
import unicodedata
from contextlib import ExitStack, contextmanager, nullcontext
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
import shopify_orders
from projects import (
    VERSION, PROJECT_VERSION, LEGACY_PROJECT_ID, BUSINESS_TABLES,
    SCOPED_TABLES, COVER_TABLE, MATERIAL_CATEGORIES_VERSION, MATERIAL_CODE_PREFIX_VERSION,
    RECORD_DELETION_VERSION, INVENTORY_TIME_VERSION, COVER_SIZE_VERSION, IMAGE_NAME_VERSION, migrate_inventory, migrate_material_categories, migrate_projects,
)

ROOT = Path(__file__).resolve().parent.parent
BASE_PATH = os.environ.get("PLM_BASE_PATH", "").rstrip("/")
SESSION_COOKIE = ('plm_session_' + hashlib.sha256(BASE_PATH.encode()).hexdigest()[:8]
                  if BASE_PATH else 'plm_session')
DATA = Path(os.environ.get('PLM_DATA_DIR', str(ROOT / 'data'))).resolve()
FILE_BATCH_TYPE = "application/vnd.jplm.file-batch"
UPLOAD_CHUNK = 1024 * 1024
MAX_UPLOAD = 20 * UPLOAD_CHUNK
MAX_COVER = 4 * UPLOAD_CHUNK
LARGE_UPLOAD = threading.BoundedSemaphore(1)
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
CREATE TABLE IF NOT EXISTS purchase_lines(id TEXT PRIMARY KEY,purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,part_id TEXT NOT NULL REFERENCES parts(id),qty REAL NOT NULL CHECK(qty>0),price REAL NOT NULL CHECK(price>=0),received REAL NOT NULL DEFAULT 0 CHECK(received>=0),UNIQUE(purchase_id,part_id));
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
            db.execute(shipping.PENDING_SHOPIFY_SCHEMA)
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
        if version < MATERIAL_CATEGORIES_VERSION:
            migrate_material_categories(db)
        if version < INVENTORY_TIME_VERSION:
            migrate_inventory(db)
        db.execute('BEGIN IMMEDIATE')
        if PROJECT_VERSION <= version < COVER_SIZE_VERSION and db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_covers'"
        ).fetchone():
            db.execute('ALTER TABLE project_covers RENAME TO project_covers_before_upload_upgrade')
            db.execute(COVER_TABLE)
            db.execute('INSERT INTO project_covers SELECT * FROM project_covers_before_upload_upgrade')
            db.execute('DROP TABLE project_covers_before_upload_upgrade')
        else:
            db.execute(COVER_TABLE)
        if 'deleted_at' not in {row['name'] for row in db.execute('PRAGMA table_info(projects)')}:
            db.execute('ALTER TABLE projects ADD COLUMN deleted_at TEXT '
                       'CHECK(deleted_at IS NULL OR archived_at IS NOT NULL)')
        for statement in inspection.SCHEMA:
            db.execute(statement)
        shipping.initialize(db, version)
        db.execute(shipping.PENDING_SHOPIFY_SCHEMA)
        for table in ('inspection_records', 'movements', 'purchases', 'purchase_lines'):
            if 'deleted_at' not in {row['name'] for row in db.execute(f'PRAGMA table_info({table})')}:
                db.execute(f'ALTER TABLE {table} ADD COLUMN deleted_at TEXT')
        if version == 12:
            inspection.backfill_from_records(db)
        if version < MATERIAL_CODE_PREFIX_VERSION:
            migrate_material_codes(db)
        if version < IMAGE_NAME_VERSION:
            if 'display_name' not in {row['name'] for row in db.execute('PRAGMA table_info(files)')}:
                db.execute("ALTER TABLE files ADD COLUMN display_name TEXT NOT NULL DEFAULT ''")
            assign_existing_image_names(db)
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
                prefix=legacy_product_prefix(db,part['numbering_product_id'])
                db.execute('UPDATE parts SET code=? WHERE id=?',(material_code(part['category'],part['material_level'],part['material_serial'],prefix=prefix),part['id']))
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


def find_bom_import_part(db, product_id, code, external_code, name, spec, level, category):
    if code:
        found = find_part_code(db, code)
        if found:
            return found[0]
    if external_code:
        criteria = 'p.external_code=? COLLATE NOCASE'
        values = (external_code,)
    else:
        criteria = 'p.name=? AND p.spec=? AND p.material_level=? AND p.category=?'
        values = (name, spec, level, category)
    matches = db.execute(f"""SELECT p.id, p.name, p.spec, EXISTS (
            SELECT 1 FROM bom_lines l JOIN bom_versions v ON v.id=l.version_id
            WHERE l.part_id=p.id AND v.product_id=?
        ) AS in_product_bom FROM parts p
        WHERE p.project_id=? AND p.deleted_at IS NULL AND {criteria}
        ORDER BY in_product_bom DESC LIMIT 2""", (product_id, db.project_id, *values)).fetchall()
    if len(matches) > 1 and matches[0]['in_product_bom'] == matches[1]['in_product_bom']:
        raise Problem('有多个匹配物料，请填写唯一的系统料号')
    if not matches:
        return None
    match = matches[0]
    if external_code and not match['in_product_bom'] and name and (
            match['name'] != name or spec and match['spec'] != spec):
        return None
    return match['id']


def bom_import_price(value):
    if value is None or value == '':
        return 0
    text = re.sub(r'^[¥￥]\s*', '', str(value).strip())
    if re.fullmatch(r'\d{1,3}(?:,\d{3})+(?:\.\d+)?', text):
        text = text.replace(',', '')
    return num(text) if text else 0


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

def assign_existing_image_names(db):
    owners = {(table, row['id']): (row['code'], row['name'])
              for table in ('products', 'parts')
              for row in db.execute(f'SELECT id,code,name FROM {table}')}
    positions = {}
    for file in db.execute('SELECT id,owner_type,owner_id,kind,name,display_name FROM files ORDER BY rowid').fetchall():
        owner = (file['owner_type'], file['owner_id'])
        positions[owner] = positions.get(owner, 0) + 1
        if owner in owners and file['kind'] == 'image' and not file['display_name']:
            name = owner_file_name(file['name'], *owners[owner], positions[owner])
            db.execute('UPDATE files SET display_name=? WHERE id=?', (name, file['id']))


@contextmanager
def large_upload_slot():
    if not LARGE_UPLOAD.acquire(blocking=False):
        raise Problem('有大文件正在处理，请稍后再试', 429)
    try:
        yield
    finally:
        LARGE_UPLOAD.release()


@contextmanager
def stage_upload_deletion(ids):
    folder = Path(tempfile.mkdtemp(dir=DATA, prefix='delete-upload-'))
    moved = []
    try:
        for id in ids:
            if not UPLOAD_ID.fullmatch(id):
                raise Problem('附件编号无效')
            source = DATA / 'uploads' / id
            try:
                source.replace(folder / id)
                moved.append(id)
            except FileNotFoundError:
                continue
        yield
    except Exception:
        for id in moved:
            (folder / id).replace(DATA / 'uploads' / id)
        folder.rmdir()
        raise
    else:
        shutil.rmtree(folder)


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

MOVEMENT_FIELDS = ('type', 'part_id', 'qty', 'product_id', 'purchase_line_id', 'original_id', 'reason', 'handler_id')


def movement_delta(kind, qty):
    return qty if kind in ('入库', '退库') else -qty


def movement_time(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc).isoformat(timespec='microseconds')
    except (AttributeError, TypeError, ValueError, OverflowError):
        raise Problem('请选择有效的操作时间') from None


def opening_stock(db, part):
    total = db.execute("""SELECT COALESCE(SUM(CASE WHEN type IN ('入库','退库') THEN qty ELSE -qty END),0)
        FROM movements WHERE project_id=? AND part_id=? AND deleted_at IS NULL""", (db.project_id, part['id'])).fetchone()[0]
    return round(part['stock'] - total, 6)


def rebuild_stock(db, part, opening, status=409):
    balance = opening
    outflows = set()
    updates = []
    # 同一时间按原登记顺序排，保留旧流水的顺序。
    for row in db.execute("""SELECT id,code,type,qty,balance,original_id FROM movements
        WHERE project_id=? AND part_id=? AND deleted_at IS NULL ORDER BY occurred_at,rowid""",
        (db.project_id, part['id'])):
        if row['original_id'] and row['original_id'] not in outflows:
            raise Problem('原出库记录必须早于退库记录')
        if row['type'] == '出库':
            outflows.add(row['id'])
        balance = round(balance + movement_delta(row['type'], row['qty']), 6)
        if balance < 0:
            raise Problem(f'库存不足，流水 {row["code"]} 的结存会为负数', status)
        if row['balance'] != balance:
            updates.append((balance, row['id']))
    db.executemany('UPDATE movements SET balance=? WHERE id=?', updates)
    if part['stock'] != balance:
        db.execute('UPDATE parts SET stock=?,updated_at=? WHERE id=?', (balance, now(), part['id']))
    return balance


def movement_description(db, row, part):
    text = f'{row["type"]} {part["code"]} {part["name"]} · {row["qty"]:g} {part["unit"]}'
    if row['product_id']:
        text += ' · 产品 ' + exists(db, 'products', row['product_id'])['name']
    if row['purchase_line_id']:
        line = exists(db, 'purchase_lines', row['purchase_line_id'])
        text += ' · 采购单 ' + exists(db, 'purchases', line['purchase_id'])['code']
    if row['original_id']:
        text += ' · 原出库 ' + exists(db, 'movements', row['original_id'])['code']
    if row['handler_id']:
        text += ' · 经办人 ' + exists(db, 'users', row['handler_id'])['name']
    if row['reason']:
        text += ' · 用途 / 原因 ' + row['reason']
    return text + ' · 操作时间 ' + row['occurred_at']


def check_movement_snapshot(row, expected):
    if expected is not None and (not isinstance(expected, dict) or any(
            key not in expected or expected[key] != row[key] for key in MOVEMENT_FIELDS)
            or expected.get('occurred_at', row['occurred_at']) != row['occurred_at']):
        raise Problem('该流水已被修改，请刷新后重试', 409)


def adjust_purchase_received(db, line_id, delta):
    line = active_purchase_line(db, line_id)
    received = round(line['received'] + delta, 6)
    if received < 0: raise Problem('采购明细的已入库数量不足，无法调整')
    if delta:
        db.execute('UPDATE purchase_lines SET received=? WHERE id=?', (received, line_id))


def delete_movement(db, movement_id, expected, actor):
    row = exists(db, 'movements', movement_id)
    if row['deleted_at']:
        return movement_id
    check_movement_snapshot(row, expected)
    if db.execute('SELECT 1 FROM movements WHERE original_id=? AND deleted_at IS NULL LIMIT 1',
                  (movement_id,)).fetchone():
        raise Problem('该流水仍有关联的退库记录，请先处理退库记录', 409)
    part = active_part(db, row['part_id'])
    opening = opening_stock(db, part)
    if row['purchase_line_id']:
        adjust_purchase_received(db, row['purchase_line_id'], -row['qty'])
    db.execute('UPDATE movements SET deleted_at=? WHERE id=?', (now(), movement_id))
    balance = rebuild_stock(db, part, opening)
    log_activity(db, actor, '删除库存流水', part['id'], row['code'],
                 f'{movement_description(db, row, part)} · 当前结存 {balance:g} {part["unit"]}')
    return movement_id


def record_movement(db, data, actor=None, *, movement_id=None):
    old = exists(db, 'movements', movement_id) if movement_id else None
    if old:
        if old['deleted_at']:
            raise Problem('库存流水已删除', 404)
        check_movement_snapshot(old, data.get('expected'))
        data = {**old, **data}

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
        line = active_purchase_line(db, purchase_line)
        if line['part_id'] != part['id']: raise Problem('采购物料与入库物料不一致')
    purchase_changes = {}
    if old and old['purchase_line_id']:
        purchase_changes[old['purchase_line_id']] = -old['qty']
    if purchase_line:
        purchase_changes[purchase_line] = purchase_changes.get(purchase_line, 0) + qty
    for line_id, change in purchase_changes.items():
        adjust_purchase_received(db, line_id, change)

    if original_id:
        if kind != '退库': raise Problem('只有退库可以关联原出库记录')
        original = exists(db, 'movements', original_id)
        if original['deleted_at'] or original['type'] != '出库' or original['part_id'] != part['id']:
            raise Problem('请选择该物料的原出库记录')
        returned = db.execute("""SELECT COALESCE(SUM(qty),0) FROM movements
            WHERE original_id=? AND id<>? AND deleted_at IS NULL""", (original_id, movement_id or '')).fetchone()[0]
        if qty > round(original['qty'] - returned,6): raise Problem('退库数量超过原出库尚未退回的数量')
        product_id = original['product_id']
    if kind == '退库' and not original_id: raise Problem('退库需关联原出库记录')
    if old and old['type'] == '出库':
        returned = round(db.execute("""SELECT COALESCE(SUM(qty),0) FROM movements
            WHERE original_id=? AND deleted_at IS NULL""", (movement_id,)).fetchone()[0], 6)
        if returned and (kind != '出库' or old['part_id'] != part['id'] or qty < returned):
            raise Problem(f'该流水已退库 {returned:g}，请先修正关联的退库记录', 409)
        if returned and product_id != old['product_id']:
            db.execute('UPDATE movements SET product_id=? WHERE original_id=? AND deleted_at IS NULL', (product_id, movement_id))

    reason = str(data.get('reason') or '').strip()
    if kind == '报废' and not reason: raise Problem('请填写报废原因')
    handler_id = data.get('handler_id') or None
    if old:
        handler = old['handler_id'] if old['handler_id'] == handler_id else assign_user(db, handler_id)
    else:
        handler = assign_user(db, handler_id or (actor['id'] if actor else None))
    stamp = now()
    occurred_at = data.get('occurred_at', stamp)
    if not old or occurred_at != old['occurred_at']:
        occurred_at = movement_time(occurred_at)
    values = dict(type=kind, part_id=part['id'], qty=qty, product_id=product_id, purchase_line_id=purchase_line,
                  original_id=original_id, reason=reason, handler_id=handler, occurred_at=occurred_at)
    if old:
        if all(old[key] == value for key, value in values.items()):
            return movement_id
        old_part = part if old['part_id'] == part['id'] else active_part(db, old['part_id'])
        stock_fields = ('part_id', 'qty', 'type', 'occurred_at', 'original_id')
        changed_stock = any(old[key] != values[key] for key in stock_fields)
        affected = {part['id']: part, old_part['id']: old_part} if changed_stock else {}
        openings = {id: opening_stock(db, record) for id, record in affected.items()}
        db.execute('UPDATE movements SET ' + ','.join(key+'=?' for key in values) + ' WHERE id=?',
                   (*values.values(), movement_id))
        for id, record in affected.items():
            rebuild_stock(db, record, openings[id])
        before = movement_description(db, old, old_part)
        after = movement_description(db, values, part)
        log_activity(db, actor, '修改库存流水', part['id'], old['code'], before + ' → ' + after)
        return movement_id

    opening = opening_stock(db, part)
    mid = uid()
    code = next_code(db, 'ST')
    insert_scoped(db, 'movements', dict(id=mid, code=code, balance=0, created_at=stamp, **values))
    rebuild_stock(db, part, opening, status=400)
    balance = exists(db, 'movements', mid)['balance']
    handler_name = exists(db, 'users', handler)['name'] if handler else ''
    log_activity(db, actor, kind, part['id'], f"{part['code']} {part['name']}",
                 f'{code} · {qty:g} {part["unit"]} · 结余 {balance:g} · 经办人 {handler_name}')
    return mid


PURCHASE_FIELDS = ('supplier_id', 'date', 'notes', 'responsible_id')


def active_purchase(db, purchase_id):
    purchase = exists(db, 'purchases', purchase_id)
    if purchase['deleted_at']:
        raise Problem('采购单已删除', 404)
    return purchase


def active_purchase_line(db, line_id):
    line = exists(db, 'purchase_lines', line_id)
    if line['deleted_at']:
        raise Problem('采购明细已移除', 404)
    active_purchase(db, line['purchase_id'])
    return line


def purchase_lines_for_edit(db, purchase_id):
    return {line['part_id']: dict(line) for line in db.execute("""SELECT l.*,
        (l.received>0 OR EXISTS (SELECT 1 FROM movements m
          WHERE m.purchase_line_id=l.id AND m.deleted_at IS NULL)) AS has_receipts
        FROM purchase_lines l WHERE l.project_id=? AND l.purchase_id=? ORDER BY l.rowid""",
        (db.project_id, purchase_id))}


def check_purchase_snapshot(purchase, lines, expected):
    if expected is not None:
        snapshot = {key: purchase[key] for key in PURCHASE_FIELDS}
        snapshot['lines'] = [{key: line[key] for key in ('part_id', 'qty', 'price')}
                             for line in lines.values() if not line['deleted_at']]
        if expected != snapshot:
            raise Problem('该采购单已被修改，请刷新后重试', 409)


def record_purchase(db, data, actor, previous=None):
    rows = data.get('lines')
    if not isinstance(rows, list) or not rows:
        raise Problem('请至少添加一个采购物料')
    supplier_id = exists(db, 'suppliers', data.get('supplier_id'))['id']
    date = required(data.get('date'), '采购日期')
    try:
        datetime.strptime(date, '%Y-%m-%d')
    except ValueError:
        raise Problem('采购日期格式错误')
    responsible_id = data.get('responsible_id')
    responsible = previous['responsible_id'] if previous and responsible_id == previous['responsible_id'] else assign_user(
        db, responsible_id or actor['id'])
    notes = str(data.get('notes') or '')
    purchase_id = previous['id'] if previous else uid()
    old_lines = purchase_lines_for_edit(db, purchase_id) if previous else {}
    if previous:
        check_purchase_snapshot(previous, old_lines, data.get('expected'))
        if previous['supplier_id'] != supplier_id and any(line['has_receipts'] for line in old_lines.values()):
            raise Problem('已有入库记录，请先处理关联的入库流水再更换供应商', 409)

    selected = set()
    code = previous['code'] if previous else next_code(db, 'PO')
    if previous:
        db.execute('UPDATE purchases SET supplier_id=?,date=?,notes=?,responsible_id=? WHERE id=?',
                   (supplier_id, date, notes, responsible, purchase_id))
    else:
        insert_scoped(db, 'purchases', dict(id=purchase_id, code=code, supplier_id=supplier_id,
                                          date=date, notes=notes, created_at=now(), responsible_id=responsible))
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('part_id'), str):
            raise Problem('采购物料格式错误')
        part_id = row['part_id']
        if part_id in selected:
            raise Problem('同一物料不能重复添加到采购单', 409)
        selected.add(part_id)
        old_line = old_lines.get(part_id)
        existing = old_line and not old_line['deleted_at']
        part = exists(db, 'parts', part_id) if existing else active_part(db, part_id)
        qty, price = num(row.get('qty'), True), num(row.get('price'))
        if old_line:
            db.execute('UPDATE purchase_lines SET qty=?,price=?,deleted_at=NULL WHERE id=?', (qty, price, old_line['id']))
        else:
            insert_scoped(db, 'purchase_lines', dict(id=uid(), purchase_id=purchase_id, part_id=part_id,
                                                     qty=qty, price=price, received=0))
        if not part['deleted_at']:
            insert_scoped(db, 'quotes', dict(id=uid(), part_id=part_id, supplier_id=supplier_id, price=None, url=''),
                          'ON CONFLICT(part_id,supplier_id) DO NOTHING')

    for part_id, line in old_lines.items():
        if part_id in selected or line['deleted_at']:
            continue
        if line['has_receipts']:
            raise Problem('请先处理该物料关联的入库流水，再移除采购明细', 409)
        db.execute('UPDATE purchase_lines SET deleted_at=? WHERE id=?', (now(), line['id']))
    owner_name = exists(db, 'users', responsible)['name'] if responsible else '—'
    log_activity(db, actor, '修改采购单' if previous else '新增采购单', purchase_id, code,
                 f'{owner_name} · {len(selected)} 项物料')
    return purchase_id


def delete_purchase(db, purchase_id, expected, actor):
    purchase = exists(db, 'purchases', purchase_id)
    if purchase['deleted_at']:
        return purchase_id
    lines = purchase_lines_for_edit(db, purchase_id)
    check_purchase_snapshot(purchase, lines, expected)
    if any(line['has_receipts'] for line in lines.values()):
        raise Problem('采购单已有入库记录，请先处理关联的入库流水', 409)
    db.execute('UPDATE purchases SET deleted_at=? WHERE id=?', (now(), purchase_id))
    supplier = exists(db, 'suppliers', purchase['supplier_id'])
    count = sum(not line['deleted_at'] for line in lines.values())
    log_activity(db, actor, '删除采购单', purchase_id, purchase['code'], f'{supplier["name"]} · {count} 项物料')
    return purchase_id


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

def legacy_product_prefix(db,product_id):
    if not product_id: return 'CM'
    product=exists(db,'products',product_id)
    letters=''.join(c for c in product['english_code'] if c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    return letters[:2] if len(letters)>=2 else 'CM'

BUILTIN_MATERIAL_CATEGORIES = ('结构物料', '电子物料')
MATERIAL_CATEGORY_DIGITS = dict(zip(BUILTIN_MATERIAL_CATEGORIES, ('1', '2')))


def material_category(db, value, level):
    if value is None or isinstance(value, str) and not value.strip():
        return BUILTIN_MATERIAL_CATEGORIES[level - 1]
    if not isinstance(value, str) or len(value.strip()) > 64 or re.search(r'[\x00-\x1f\x7f-\x9f]', value.strip()):
        raise Problem('请输入 1 至 64 个字符的物料类别')
    name = value.strip()
    key = unicodedata.normalize('NFKC', name).casefold()
    if key in MATERIAL_CATEGORY_DIGITS:
        return key
    db.execute('INSERT OR IGNORE INTO material_categories(project_id,name_key,name) VALUES(?,?,?)',
               (db.project_id, key, name))
    return db.execute('SELECT name FROM material_categories WHERE project_id=? AND name_key=?',
                      (db.project_id, key)).fetchone()[0]


def next_material_serial(db):
    key='sequence_material_global'
    row=db.execute('SELECT value FROM settings WHERE key=?',(key,)).fetchone()
    existing=db.execute('SELECT COALESCE(MAX(material_serial),0) FROM parts').fetchone()[0]
    sequence=max(int(row[0]) if row else 0,existing)+1
    if sequence>9999: raise Problem('4 位物料流水号已用完',409)
    db.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,str(sequence)))
    return sequence

def material_code(category, level, serial, *, prefix='JC'):
    if not isinstance(serial,int) or not 1<=serial<=9999: raise Problem('物料流水号无效')
    digit = MATERIAL_CATEGORY_DIGITS.get(category, '3')
    return f'{prefix}{digit}{level}{serial:04d}'

def migrate_material_codes(db):
    parts = db.execute('SELECT id, project_id, code, category, material_level, material_serial FROM parts').fetchall()
    for part in parts:
        code = material_code(part['category'], part['material_level'], part['material_serial'])
        previous = part['code']
        if previous == code:
            continue
        if db.execute('SELECT 1 FROM material_code_aliases WHERE code IN (?,?) AND part_id<>?',
                      (previous, code, part['id'])).fetchone():
            raise Problem(f'物料料号与历史编号冲突：{previous} → {code}', 409)
        db.execute('INSERT INTO material_code_aliases(project_id,code,part_id) VALUES(?,?,?) ON CONFLICT(code) DO NOTHING',
                   (part['project_id'], previous, part['id']))
        db.execute('UPDATE parts SET code=? WHERE id=?', (code, part['id']))

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
            file['name'] = file['display_name'] or owner_file_name(file['name'], record['code'], record['name'], positions[owner])
    state['deleted_parts'] = [p for p in state['parts'] if p['deleted_at']]
    state['parts'] = [p for p in state['parts'] if not p['deleted_at']]
    state['movements'] = [row for row in state['movements'] if not row['deleted_at']]
    state['purchases'] = [row for row in state['purchases'] if not row['deleted_at']]
    purchase_ids = {row['id'] for row in state['purchases']}
    state['purchase_lines'] = [line for line in state['purchase_lines']
                               if not line['deleted_at'] and line['purchase_id'] in purchase_ids]
    state['material_categories'] = [*BUILTIN_MATERIAL_CATEGORIES, *(row[0] for row in db.execute(
        'SELECT name FROM material_categories WHERE project_id=? ORDER BY name_key', (db.project_id,)))]
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
            (SELECT COUNT(*) FROM purchases AS po WHERE po.project_id=p.id AND po.deleted_at IS NULL AND EXISTS (
                SELECT 1 FROM purchase_lines AS l WHERE l.purchase_id=po.id AND l.deleted_at IS NULL AND l.received<l.qty
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
        if len(names) != len(entries):
            raise Problem('备份包含重复文件')
        if sum(item.file_size for item in entries) > shutil.disk_usage(directory).free:
            raise Problem('服务器剩余空间不足，无法解压备份', 507)
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
            category_tables = ('material_categories',) if version >= MATERIAL_CATEGORIES_VERSION else ()
            inspection_tables = inspection.TABLES if version >= 13 else inspection.INITIAL_TABLES if version == 12 else ()
            shipping_tables = (shipping.TABLES if version >= shipping.HANDLING_PROJECTS_VERSION else
                               shipping.PRODUCT_TABLES if version >= shipping.PRODUCTS_VERSION else
                               shipping.SOURCE_TABLES if version >= shipping.SOURCES_VERSION else
                               shipping.CARRIER_TABLES if version >= shipping.CREATED_AT_VERSION else
                               shipping.LEGACY_TABLES if version >= shipping.VERSION else ())
            required_tables = set(TABLES) | {'settings', 'import_runs', *project_tables, *category_tables,
                                             *inspection_tables, *shipping_tables}
            if version >= 7:
                required_tables |= {'users', 'activity'}
            if not required_tables <= source_tables:
                raise Problem('备份缺少业务数据表')
            if project_tables and 'shipping_pending_shopify' in source_tables:
                shipping_tables += ('shipping_pending_shopify',)
            (init_db if project_tables else init_legacy_db)(staged)
            with connect(staged) as db:
                db.execute('BEGIN')
                db.execute('PRAGMA defer_foreign_keys=ON')
                for table in ('users', *project_tables, *category_tables, *TABLES, *inspection_tables, *shipping_tables,
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
                    if table in ('movements', 'purchases', 'purchase_lines') and version < RECORD_DELETION_VERSION:
                        optional.add('deleted_at')
                    if table == 'movements' and version < INVENTORY_TIME_VERSION:
                        optional.add('occurred_at')
                    if table == 'files' and version < IMAGE_NAME_VERSION:
                        optional.add('display_name')
                    if table == 'shipping_ks_orders' and version < shipping.CREATED_AT_VERSION:
                        optional.add('created_at')
                    if table == 'shipping_records' and version < shipping.RECORD_RELATIONS_VERSION:
                        optional.update(('parent_id', 'deleted_at'))
                    if table == 'shipping_records' and version < shipping.PRODUCTS_VERSION:
                        optional.add('items_configured')
                    if not set(target_columns) - optional <= source_columns:
                        raise Problem('备份数据结构不完整')
                    columns = ','.join(name for name in target_columns if name in source_columns)
                    records = source.execute(f'SELECT {columns} FROM {table} ORDER BY rowid')
                    db.executemany(f'INSERT INTO {table}({columns}) VALUES({",".join("?" for _ in columns.split(","))})', records)
                if PROJECT_VERSION <= version < INVENTORY_TIME_VERSION:
                    db.execute("UPDATE movements SET occurred_at=created_at WHERE occurred_at=''")
                if version == 12:
                    inspection.backfill_from_records(db)
                if shipping.VERSION <= version < shipping.CREATED_AT_VERSION:
                    shipping.fill_created_at(db)
                if shipping.VERSION <= version < shipping.SOURCES_VERSION:
                    shipping.repair_imported_times(db)
                if shipping.VERSION <= version < shipping.PRODUCTS_VERSION:
                    shipping.backfill_products(db)
                if shipping_tables and not shipping.valid_parent_links(db):
                    raise Problem('备份中的发货父子关系无效')
                if PROJECT_VERSION <= version < MATERIAL_CODE_PREFIX_VERSION:
                    migrate_material_codes(db)
                if version >= shipping.PRODUCTS_VERSION and db.execute("""SELECT 1 FROM shipping_items i
                    JOIN shipping_records s ON s.project_id=i.project_id AND s.id=i.shipment_id
                    WHERE s.channel<>'other' OR s.items_configured<>1 LIMIT 1""").fetchone():
                    raise Problem('备份中的发货商品关联无效')
                if version >= shipping.HANDLING_PROJECTS_VERSION and db.execute("""SELECT 1
                    FROM shipping_handling_projects h JOIN shipping_records s ON s.project_id=h.project_id AND s.id=h.shipment_id
                    WHERE s.channel<>'other' LIMIT 1""").fetchone():
                    raise Problem('备份中的经办项目关联无效')
                db.execute("DELETE FROM settings WHERE key='password'")
                if version >= 7 and not db.execute("SELECT 1 FROM users WHERE role='admin'").fetchone():
                    raise Problem('备份中没有管理员账户')
                if PROJECT_VERSION <= version < IMAGE_NAME_VERSION:
                    assign_existing_image_names(db)
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
    with connect(staged) as db:
        db.execute('BEGIN IMMEDIATE')
        shopify_orders.backfill_addresses(db, now())
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
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(b)
    def security_headers(self):
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Referrer-Policy','same-origin')
        self.send_header('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'")
    def send_asset_headers(self, content_type, length, revision, disposition=None):
        etag = f'"{revision}"'
        tags = self.headers.get('If-None-Match', '').split(',')
        unchanged = any(tag.strip().removeprefix('W/') in (etag, '*') for tag in tags)
        self.send_response(304 if unchanged else 200)
        self.send_header('ETag', etag)
        self.send_header('Cache-Control', 'private, no-cache')
        if not unchanged:
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(length))
            if disposition:
                self.send_header('Content-Disposition', disposition)
        self.security_headers()
        self.end_headers()
        return not unchanged and self.command != 'HEAD'
    def body_size(self):
        size = int(self.headers.get('Content-Length', '0'))
        if size < 0:
            raise Problem('请求长度无效')
        return size

    def stream_body(self, size, target):
        while size:
            chunk = self.rfile.read(min(size, UPLOAD_CHUNK))
            if not chunk:
                raise Problem('上传不完整')
            target.write(chunk)
            size -= len(chunk)

    def body(self):
        size = self.body_size()
        if size > MAX_UPLOAD:
            raise Problem('单次上传不能超过 20 MB', 413)
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise Problem('上传不完整')
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
    def do_HEAD(self): self.handle_request('HEAD')
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
            asset_path = re.fullmatch(r'/api/assets/(file|cover|avatar)/([0-9a-f]{24}|legacy)', path)
            if method == 'HEAD' and not asset_path and not re.fullmatch(r'/files/[0-9a-f]{24}', path):
                raise Problem('接口不存在', 404)
            if method not in ('GET', 'HEAD'):
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
            if path == '/api/warehouse/material' and method == 'GET':
                return self.warehouse_material()
            if path == '/api/warehouse/movements' and method == 'POST':
                return self.warehouse_movement()
            if path == '/api/warehouse/movements' and method == 'GET':
                return self.warehouse_history()
            if method == 'DELETE' and (match := re.fullmatch(r'/api/warehouse/movements/([a-f0-9]{24})', path)):
                return self.delete_warehouse_movement(match[1])
            if path == '/api/settings/shopify' and method in ('GET', 'PUT'):
                self.require_admin()
                if method == 'PUT':
                    return self.send(shopify_orders.save_settings(DATA, self.body()))
                return self.send(shopify_orders.public_settings(shopify_orders.credentials(DATA)))
            if path.startswith('/api/global-shipping/'):
                return self.global_shipping_request(path.removeprefix('/api/global-shipping/'), method)
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
                    if table == 'purchases' and record['deleted_at']:
                        raise Problem('采购单已删除', 404)
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
            if path == '/api/assets' and method == 'GET':
                self.require_admin()
                return self.list_assets()
            if asset_path and method == 'DELETE':
                self.require_admin()
                return self.delete_library_image(*asset_path.groups())
            if asset_path and method in ('GET', 'HEAD'):
                self.require_admin()
                kind, asset_id = asset_path.groups()
                if kind == 'file':
                    return self.serve_file(asset_id, admin_assets=True)
                if kind == 'cover':
                    return self.project_cover(asset_id, 'GET', admin_assets=True)
                return self.serve_avatar(asset_id)
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
            if path.startswith('/files/') and method in ('GET', 'HEAD'):
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
            return self.upload(project_id)
        if method == 'DELETE' and (match := re.fullmatch(r'/api/deleted-parts/([0-9a-f]{24})', path)):
            self.require_admin()
            return self.purge_deleted_part(project_id, match[1])
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

    def warehouse_material(self):
        query = parse_qs(urlparse(self.path).query)
        code = required(query.get('q', [''])[0], '物料编号')
        fuzzy = query.get('fuzzy', [''])[0] == '1'
        project_id, part_id = '', ''
        if code.startswith(('https://', 'http://')):
            fragment = urlparse(code).fragment
            match = re.fullmatch(r'(?:projects/([a-zA-Z0-9_-]+)/)?parts/([a-f0-9]{24})', fragment)
            if not match:
                raise Problem('请扫描 PLM 物料二维码或输入物料编号')
            project_id, part_id = match[1] or '', match[2]
        with connect() as db:
            rows = db.execute("""
                WITH matches AS (
                    SELECT p.id, p.code, p.name, p.spec, p.unit, p.stock, p.location, p.external_code,
                           p.project_id, j.name AS project_name,
                           (SELECT f.id FROM files f WHERE f.project_id=p.project_id
                            AND f.owner_type='parts' AND f.owner_id=p.id AND f.kind='image'
                            ORDER BY f.rowid LIMIT 1) AS image_id,
                           (p.code=:code COLLATE NOCASE OR EXISTS (
                               SELECT 1 FROM material_code_aliases a WHERE a.project_id=p.project_id
                               AND a.part_id=p.id AND a.code=:code COLLATE NOCASE)) AS exact_code
                    FROM parts p JOIN projects j ON j.id=p.project_id
                    WHERE p.deleted_at IS NULL AND j.deleted_at IS NULL AND j.archived_at IS NULL
                      AND (:admin OR EXISTS (SELECT 1 FROM project_members m
                                            WHERE m.project_id=j.id AND m.user_id=:user))
                )
                SELECT * FROM matches
                WHERE (:part<>'' AND id=:part AND (:project='' OR project_id=:project))
                   OR (:part='' AND (exact_code OR (:fuzzy AND (
                      instr(lower(code),lower(:code))>0 OR instr(lower(name),lower(:code))>0
                      OR instr(lower(spec),lower(:code))>0 OR instr(lower(external_code),lower(:code))>0))))
                ORDER BY exact_code DESC, code, id LIMIT :limit
            """, {'admin': self.user['role'] == 'admin', 'user': self.user['id'],
                  'part': part_id, 'project': project_id, 'code': code,
                  'fuzzy': fuzzy, 'limit': 20 if fuzzy else 2}).fetchall()
        if fuzzy:
            if rows and rows[0]['exact_code']:
                rows = [row for row in rows if row['exact_code']]
            return self.send({'rows': [dict(row) for row in rows]})
        if not rows:
            raise Problem('没有找到可登记的物料，请核对编号或项目权限', 404)
        if len(rows) > 1:
            raise Problem('编号匹配到多条物料，请扫描物料二维码', 409)
        return self.send(dict(rows[0]))

    def warehouse_history(self):
        with connect() as db:
            rows = db.execute("""
                SELECT m.*, p.code AS part_code, p.name AS part_name, p.unit, j.name AS project_name,
                       (j.archived_at IS NULL AND p.deleted_at IS NULL) AS can_delete
                FROM movements m JOIN parts p ON p.id=m.part_id AND p.project_id=m.project_id
                JOIN projects j ON j.id=m.project_id
                WHERE m.handler_id=? AND m.deleted_at IS NULL AND j.deleted_at IS NULL
                  AND m.type IN ('入库','出库','报废')
                  AND (? OR EXISTS (SELECT 1 FROM project_members pm
                                   WHERE pm.project_id=m.project_id AND pm.user_id=?))
                ORDER BY m.created_at DESC, m.id DESC LIMIT 30
            """, (self.user['id'], self.user['role'] == 'admin', self.user['id'])).fetchall()
        fields = ('id', 'type', 'project_id', 'project_name', 'part_code', 'part_name',
                  'qty', 'unit', 'created_at', 'can_delete')
        return self.send([{
            **{key: row[key] for key in fields},
            'expected': {key: row[key] for key in (*MOVEMENT_FIELDS, 'occurred_at')},
        } for row in rows])

    def delete_warehouse_movement(self, movement_id):
        data = self.body()
        if not isinstance(data, dict) or not isinstance(data.get('expected'), dict):
            raise Problem('请刷新流水记录后重试')
        with FILE_LOCK, transaction() as db:
            self.inspection_writer(db, required(data.get('project_id'), '项目'))
            row = exists(db, 'movements', movement_id)
            if row['handler_id'] != self.user['id'] or row['type'] not in ('入库', '出库', '报废'):
                raise Problem('只能删除当前账户的出入库或报废记录', 403)
            delete_movement(db, movement_id, data['expected'], self.user)
            touch_project(db)
            part = exists(db, 'parts', row['part_id'])
        return self.send({'id': movement_id, 'part_id': part['id'], 'stock': part['stock']})

    def warehouse_movement(self):
        data = self.body()
        if not isinstance(data, dict):
            raise Problem('库存登记格式无效')
        request_id = data.get('request_id')
        part_id = data.get('part_id')
        kind = data.get('type')
        if (not isinstance(request_id, str) or not re.fullmatch(r'[a-f0-9]{32}', request_id)
                or not isinstance(part_id, str) or not re.fullmatch(r'[a-f0-9]{24}', part_id)
                or kind not in ('出库', '入库', '报废')):
            raise Problem('库存登记格式无效')
        qty = num(data.get('qty'), True)
        with FILE_LOCK, transaction() as db:
            self.user = self.authorized(db)
            if not self.user or self.user['must_change']:
                raise Problem('请先登录', 401)
            project = required(data.get('project_id'), '项目')
            enter_project(db, project, self.user, write=True)
            key = 'warehouse-' + request_id
            fingerprint = hashlib.sha256(json.dumps([self.user['id'], part_id, kind, qty]).encode()).hexdigest()
            saved = db.execute('SELECT fingerprint,result FROM import_runs WHERE project_id=? AND id=?',
                               (project, key)).fetchone()
            if saved:
                if saved['fingerprint'] != fingerprint:
                    raise Problem('这笔登记已处理，请重新扫码', 409)
                result = json.loads(saved['result'])
            else:
                movement = record_movement(db, {
                    'type': kind, 'part_id': part_id, 'qty': qty,
                    'reason': '仓库快速登记报废' if kind == '报废' else '',
                }, self.user)
                result = {'id': movement, 'stock': active_part(db, part_id)['stock']}
                insert_scoped(db, 'import_runs', dict(id=key, fingerprint=fingerprint,
                                                     result=json.dumps(result), created_at=now()))
                touch_project(db)
        return self.send(result)

    def global_shipping_request(self, resource, method):
        if resource == 'shopify/orders' and method in ('GET', 'POST'):
            return self.shopify_order_import(method)
        pending = re.fullmatch(r'shopify/pending/([a-f0-9]{24})', resource)
        if pending and method in ('PUT', 'DELETE'):
            return self.shopify_pending_shipment(pending[1], method)
        if method == 'GET' and resource in ('orders', 'products'):
            query = {key: values[0] for key, values in parse_qs(urlparse(self.path).query).items()}
            with connect() as db:
                db.execute('BEGIN')
                if resource == 'products':
                    return self.send(shipping.product_catalog(db, self.user))
                return self.send(shipping.list_global_orders(db, self.user, query))
        item_path = re.fullmatch(r'packages/([a-zA-Z0-9_-]+)/([a-f0-9]{24})/items', resource)
        record_path = re.fullmatch(r'orders/([a-zA-Z0-9_-]+)/([a-f0-9]{24})', resource)
        if ((resource in ('packages', 'orders') and method == 'POST') or (item_path and method == 'PUT')
                or (record_path and method in ('PUT', 'DELETE'))):
            data = self.body()
            if not isinstance(data, dict):
                raise Problem('发货记录格式无效')
            route = item_path or record_path
            project = route[1] if route else shipping.string(data.get('project_id'), 100)
            with FILE_LOCK, transaction() as db:
                self.inspection_writer(db, project)
                allowed = shipping.accessible_projects(db, self.user)
                writable = {key for key, p in allowed.items() if not p['archived_at']}
                stamp = now()
                if record_path:
                    row = shipping.get_shipment(db, project, record_path[2], allowed)
                    if row['channel'] != 'other':
                        raise Problem('发货记录不存在', 404)
                    record_id, reference = row['id'], row['reference']
                    if method == 'DELETE':
                        shipping.set_shipment_deleted(db, project, record_id, data.get('version'), stamp, True)
                    else:
                        if not row['parent_id']:
                            shipping.check_order_reference(db, data.get('reference'), allowed, row['reference'])
                        payload = {**data, 'channel': 'other', 'ks_order_id': None,
                                   'devices': data.get('devices', [d['serial'] for d in row['devices']])}
                        result = shipping.save_shipment(db, project, record_id, payload, stamp, self.user['id'],
                                                        writable=writable, cross_project=True)
                        reference = result['reference']
                elif item_path:
                    row = shipping.get_shipment(db, project, item_path[2], allowed)
                    shipping.update_shipment_items(db, row, data.get('version'), data.get('shipment_items'),
                                                   writable, stamp, self.user['id'])
                    record_id, reference = row['id'], row['reference']
                else:
                    record_id = uid()
                    payload = {**data, 'channel': 'other', 'ks_order_id': None,
                               'shipment_items': data.get('shipment_items', [])}
                    if resource == 'orders' and not data.get('parent_id'):
                        shipping.check_order_reference(db, data.get('reference'), allowed)
                    result = shipping.save_shipment(db, project, record_id, payload, stamp, self.user['id'],
                                                    writable=writable, cross_project=True)
                    reference = result['reference']
                if method != 'DELETE' and not item_path and 'handling_project_ids' in data:
                    shipping.save_handling_projects(db, project, record_id, data['handling_project_ids'], writable)
                touch_project(db)
                action = '删除发货记录' if method == 'DELETE' else '修改发货商品' if item_path else '修改发货记录' if record_path else '登记发货'
                log_activity(db, self.user, action, record_id, reference)
                result = shipping.get_shipment(db, project, record_id, allowed)
            return self.send(result)
        raise Problem('接口不存在', 404)

    def shopify_pending_shipment(self, record_id, method):
        self.require_admin()
        payload = self.body()
        if not isinstance(payload, dict):
            raise Problem('发货记录格式无效')
        with FILE_LOCK, transaction() as db:
            self.user = self.authorized(db)
            if not self.user or self.user['must_change']:
                raise Problem('请先登录', 401)
            self.require_admin()
            pending = db.execute('SELECT * FROM shipping_pending_shopify WHERE id=?', (record_id,)).fetchone()
            if not pending or payload.get('version') != pending['created_at']:
                raise Problem('订单已更新，请刷新后重试', 409)
            stamp = now()
            if method == 'PUT':
                items = payload.get('shipment_items')
                if not isinstance(items, list) or not items or not isinstance(items[0], dict):
                    raise Problem('请先选择发货商品')
                project = shipping.string(items[0].get('project_id'), 100)
                self.inspection_writer(db, project)
                projects = shipping.accessible_projects(db, self.user)
                writable = {id for id, entry in projects.items() if not entry['archived_at']}
                reference = shipping.string(payload.get('reference', pending['reference']), 150)
                shipping.check_order_reference(db, reference, projects, pending_id=record_id)
                details = payload.get('details', json.loads(pending['details']))
                if not isinstance(details, dict):
                    raise Problem('发货资料格式无效')
                shipping.save_shipment(db, project, record_id, {
                    'channel': 'other', 'reference': reference, 'details': {**details, 'source': 'Shopify'},
                    'shipment_items': items, 'tracking': payload.get('tracking'),
                    'shipped_on': payload.get('shipped_on'), 'devices': payload.get('devices', []),
                }, stamp, self.user['id'], source_id=pending['source_id'], created_at=pending['created_at'],
                    writable=writable, cross_project=True)
                touch_project(db)
            db.execute('DELETE FROM shipping_pending_shopify WHERE id=?', (record_id,))
            action = '登记 Shopify 发货商品' if method == 'PUT' else '移除待补充的 Shopify 订单'
            log_activity(db, self.user, action, record_id, pending['reference'])
        return self.send({'id': record_id})

    def shopify_order_import(self, method):
        if self.user['role'] != 'admin':
            raise Problem('需要管理员权限', 403)
        config = shopify_orders.configuration(DATA)
        if method == 'GET':
            query = parse_qs(urlparse(self.path).query)
            cursor = shipping.string(query.get('cursor', [''])[0], 2048)
            orders, next_cursor = shopify_orders.list_orders(config, cursor)
            with connect() as db:
                projects = shipping.accessible_projects(db, self.user)
                existing = shopify_orders.existing_sources(db, config, [order['id'] for order in orders])
                rows = [{
                    'id': order['id'],
                    'reference': order['name'],
                    'created_at': order['createdAt'],
                    'recipient': (order.get('shippingAddress') or {}).get('name'),
                    'fulfillment_status': order['displayFulfillmentStatus'],
                    'reason': shopify_orders.duplicate_reason(db, config, order, existing, projects)
                              or shopify_orders.unavailable(order),
                } for order in orders]
            return self.send({'rows': rows, 'cursor': next_cursor})

        payload = self.body()
        if not isinstance(payload, dict):
            raise Problem('导入订单格式无效')
        project = shipping.string(payload.get('project_id'), 100)
        ids = payload.get('ids')
        if (not isinstance(ids, list) or not 1 <= len(ids) <= shopify_orders.MAX_IMPORT
                or any(not isinstance(id, str) or not shopify_orders.ORDER_ID.fullmatch(id) for id in ids)):
            raise Problem(f'请选择 1 至 {shopify_orders.MAX_IMPORT} 笔 Shopify 订单')
        ids = list(dict.fromkeys(ids))
        with connect() as db:
            if project:
                self.inspection_writer(db, project)
            existing = shopify_orders.existing_sources(db, config, ids)
        pending = [id for id in ids if shopify_orders.source_id(config, id) not in existing]
        orders = shopify_orders.get_orders(config, pending) if pending else {}
        details = {}
        rejected = {}
        for id in pending:
            order = orders.get(id)
            reason = shopify_orders.unavailable(order) if order else 'Shopify 订单已不可用'
            if reason:
                rejected[id] = reason
                continue
            try:
                details[id] = shopify_orders.shipment_details(config, order)
            except shipping.ShippingError as error:
                if error.status >= 500:
                    raise
                rejected[id] = str(error)

        with FILE_LOCK, transaction() as db:
            self.user = self.authorized(db)
            if not self.user or self.user['must_change']:
                raise Problem('请先登录', 401)
            self.require_admin()
            if project:
                enter_project(db, project, self.user, write=True)
            projects = shipping.accessible_projects(db, self.user)
            existing = shopify_orders.existing_sources(db, config, ids)
            stamp = now()
            created, skipped = [], []
            for id in ids:
                order = orders.get(id)
                source = shopify_orders.source_id(config, id)
                reason = '已导入' if source in existing else rejected.get(id)
                if not reason and order:
                    reason = shopify_orders.duplicate_reason(db, config, order, existing, projects)
                if reason or id not in details:
                    skipped.append({'id': id, 'reason': reason or 'Shopify 订单已不可用'})
                    continue
                record_id = uid()
                if project:
                    shipping.save_shipment(db, project, record_id, {
                        'channel': 'other', 'reference': order['name'], 'details': details[id], 'shipment_items': [],
                    }, stamp, self.user['id'], source_id=source)
                else:
                    db.execute('INSERT INTO shipping_pending_shopify VALUES(?,?,?,?,?)',
                               (record_id, source, order['name'], json.dumps(details[id], ensure_ascii=False), stamp))
                log_activity(db, self.user, '导入 Shopify 订单', record_id, order['name'])
                created.append({'id': id, 'record_id': record_id})
            if created and project:
                touch_project(db)
        return self.send({'created': created, 'skipped': skipped})

    def shipping_request(self, project_id, resource, method):
        query = {key: values[0] for key, values in parse_qs(urlparse(self.path).query).items()}
        record_path = re.fullmatch(r'records/([a-f0-9]{24})', resource)
        shared_path = re.fullmatch(r'records/([a-f0-9]{24})/shared-items', resource)
        children_path = re.fullmatch(r'records/([a-f0-9]{24})/children', resource)
        restore_path = re.fullmatch(r'records/([a-f0-9]{24})/restore', resource)
        order_path = re.fullmatch(r'orders/([a-f0-9]{24})', resource)
        if method == 'GET':
            with connect() as db:
                db.execute('BEGIN')
                enter_project(db, project_id, self.user)
                if resource == 'orders':
                    return self.send(shipping.list_orders(db, project_id, query))
                if order_path:
                    return self.send(shipping.get_order(db, project_id, order_path[1], images=True))
                if resource == 'records':
                    allowed = shipping.accessible_projects(db, self.user)
                    return self.send(shipping.list_shipments(db, project_id, query.get('channel'), query, allowed))
                if record_path:
                    return self.send(shipping.get_shipment(db, project_id, record_path[1],
                                                           shipping.accessible_projects(db, self.user),
                                                           local=query.get('scope') != 'global', images=True))
                if children_path:
                    return self.send(shipping.list_children(db, project_id, children_path[1],
                                                           shipping.accessible_projects(db, self.user),
                                                           local=query.get('scope') != 'global'))
                if resource == 'products':
                    return self.send(shipping.product_catalog(db, self.user, project_id))
                if resource == 'devices':
                    return self.send(shipping.find_devices(db, project_id, query))
                if resource == 'carriers':
                    return self.send(shipping.list_carriers(db, project_id))
                if resource == 'sources':
                    return self.send(shipping.list_sources(db, project_id))
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
        if (resource == 'orders/paste' and method == 'POST') or (order_path and method == 'PUT'):
            self.require_admin()
            data = self.body()
            if not isinstance(data, dict):
                raise Problem('KS 订单数据格式无效')
            with FILE_LOCK, transaction() as db:
                self.inspection_writer(db, project_id)
                self.require_admin()
                if order_path:
                    result = shipping.edit_order(db, project_id, order_path[1], data.get('version'), data.get('details'), now())
                    log_activity(db, self.user, '编辑 KS 订单', result['id'], 'Backer #' + result['backer'])
                else:
                    result = shipping.paste_orders(db, project_id, data, now(), uid)
                    if result['added'] or result['updated']:
                        log_activity(db, self.user, '粘贴 KS 订单', '', 'KS 发货信息',
                                     f"新增 {result['added']} 条，更新 {result['updated']} 条")
                if order_path or result['added'] or result['updated']:
                    touch_project(db)
            return self.send(result)
        if (record_path and method == 'DELETE') or (restore_path and method == 'POST'):
            data = self.body()
            if not isinstance(data, dict):
                raise Problem('发货记录格式无效')
            with FILE_LOCK, transaction() as db:
                self.inspection_writer(db, project_id)
                deleted = method == 'DELETE'
                row = shipping.set_shipment_deleted(db, project_id, (record_path or restore_path)[1],
                                                     data.get('version'), now(), deleted)
                touch_project(db)
                log_activity(db, self.user, '删除发货记录' if deleted else '恢复发货记录',
                             row['id'], row['reference'] or row['tracking'])
            return self.send({'ok': True})
        if shared_path and method == 'PUT':
            data = self.body()
            if not isinstance(data, dict):
                raise Problem('发货商品格式无效')
            with FILE_LOCK, transaction() as db:
                self.inspection_writer(db, project_id)
                row = shipping.get_shipment(db, project_id, shared_path[1], local=True)
                if not row.get('shared') or not row['can_edit_items']:
                    raise Problem('此记录无法在当前项目修改', 409)
                shipping.update_shipment_items(db, row, data.get('version'), data.get('shipment_items'),
                                               {project_id}, now(), self.user['id'], editable_project=project_id)
                touch_project(db)
                log_activity(db, self.user, '修改发货商品', row['id'], row['reference'])
            return self.send({'ok': True})
        if (resource == 'records' and method == 'POST') or (record_path and method == 'PUT'):
            data = self.body()
            if not isinstance(data, dict):
                raise Problem('发货记录格式无效')
            with FILE_LOCK, transaction() as db:
                self.inspection_writer(db, project_id)
                result = shipping.save_shipment(db, project_id, record_path[1] if record_path else uid(),
                                                data, now(), self.user['id'])
                touch_project(db)
                log_activity(db, self.user, '修改发货记录' if record_path else '登记发货',
                             result['id'], result['reference'])
                result = shipping.get_shipment(db, project_id, result['id'], local=True)
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
                if resource == 'device-inspections':
                    serial, _, _ = inspection.parse_serial(query.get('serial'), 'text')
                    return self.send({'device': inspection.get_device(db, project_id, serial),
                                      'records': inspection.records_for_device(db, project_id, serial)})
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

    def project_cover(self, project_id, method, *, admin_assets=False):
        if method == 'GET':
            with connect() as db:
                db.execute('BEGIN')
                if not admin_assets:
                    enter_project(db, project_id, self.user)
                row = db.execute('SELECT mime,image FROM project_covers WHERE project_id=?',
                                 (project_id,)).fetchone()
                if not row:
                    raise Problem('未设置项目封面', 404)
            image = row['image']
            if self.send_asset_headers(row['mime'], len(image), hashlib.sha256(image).hexdigest()):
                self.wfile.write(image)
            return
        if method == 'POST':
            with connect() as db:
                db.execute('BEGIN')
                project = enter_project(db, project_id, self.user, write=True)
                if self.user['role'] != 'admin' and project['owner_id'] != self.user['id']:
                    raise Problem('无权修改项目封面', 403)
            if self.body_size() > MAX_COVER + 65536:
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
        if not mime or len(blob) > 2 * UPLOAD_CHUNK:
            raise Problem('请选择 2 MB 以内的图片')
        with FILE_LOCK, transaction() as db:
            user = self.authorized(db)
            if not user or user['must_change']:
                raise Problem('请先登录', 401)
            db.execute('UPDATE users SET avatar=?,avatar_mime=? WHERE id=?', (blob, mime, user['id']))
            log_activity(db, user, '更换头像', user['id'], user['name'])
        self.send({'ok': True})

    def serve_avatar(self, id):
        with connect() as db:
            row = db.execute('SELECT avatar,avatar_mime FROM users WHERE id=?', (id,)).fetchone()
        if not row or not row['avatar']:
            raise Problem('头像不存在', 404)
        image = row['avatar']
        content_type = image_mime(image[:12]) or 'application/octet-stream'
        if self.send_asset_headers(content_type, len(image), hashlib.sha256(image).hexdigest()):
            self.wfile.write(image)

    def list_activity(self, project_id=None):
        query = parse_qs(urlparse(self.path).query)
        before = int(query.get('before', ['0'])[0])
        subject = query.get('part', [''])[0]
        kind = query.get('kind', [''])[0]
        conditions = ["(?=0 OR a.id<?)", "(?='' OR a.subject_id=?)"]
        params = [before, before, subject, subject]
        with connect() as db:
            db.execute('BEGIN')
            if project_id:
                enter_project(db, project_id, self.user)
                if kind in ('user', 'login'):
                    raise Problem('请在系统设置查看用户操作日志', 404)
            elif kind not in ('user', 'login'):
                self.require_admin()
            if kind == 'user':
                if self.user['role'] != 'admin':
                    conditions.append("""((a.project_id IS NULL AND
                        (a.actor_id=? OR a.action IN ('登录','退出登录'))) OR
                        (p.deleted_at IS NULL AND EXISTS (
                            SELECT 1 FROM project_members m WHERE m.project_id=a.project_id AND m.user_id=?
                        )))""")
                    params.extend((self.user['id'], self.user['id']))
            else:
                conditions.extend(("a.project_id IS ?", "(a.action IN ('登录','退出登录')) = ?"))
                params.extend((project_id, kind == 'login'))
                if kind == 'login' and self.user['role'] != 'admin':
                    conditions.append('a.actor_id=?')
                    params.append(self.user['id'])
            rows = db.execute(
                """SELECT a.*, p.name AS project_name FROM activity a
                   LEFT JOIN projects p ON p.id=a.project_id WHERE """ + ' AND '.join(conditions)
                + ' ORDER BY a.id DESC LIMIT 101', params,
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
                log_activity(db, actor, '修改用户', id, name)
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
                log_activity(db, actor, '修改个人资料', actor['id'], actor['name'])
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
                log_activity(db, actor, '修改密码', actor['id'], actor['name'])
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

    def change_part_boms(self, db, part_id, changes):
        if not isinstance(changes, dict) or changes.keys() - {'add', 'remove'}:
            raise Problem('BOM 关联格式错误')
        add, remove = (changes.get(key, []) for key in ('add', 'remove'))
        if any(not isinstance(ids, list) or any(not isinstance(value, str) or not value
                                               for value in ids) for ids in (add, remove)):
            raise Problem('BOM 关联格式错误')
        for line_id in dict.fromkeys(remove):
            if db.execute('SELECT 1 FROM bom_lines WHERE id=? AND part_id=? AND project_id=?',
                          (line_id, part_id, db.project_id)).fetchone():
                self.mutate(db, '/api/bom-lines/' + line_id, 'DELETE', {})
        for version_id in dict.fromkeys(add):
            if not db.execute('SELECT 1 FROM bom_lines WHERE version_id=? AND part_id=? AND project_id=?',
                              (version_id, part_id, db.project_id)).fetchone():
                self.mutate(db, '/api/bom-lines', 'POST',
                            {'version_id': version_id, 'part_id': part_id, 'qty': 1})

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
        if resource=='movements':
            if method=='POST' and not id: return {'id':record_movement(db,d,self.user)}
            if method=='PUT' and id: return {'id':record_movement(db,d,self.user,movement_id=id)}
            if method=='DELETE' and id: return {'id':delete_movement(db,id,d.get('expected'),self.user)}
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
            version = exists(db, 'bom_versions', bid)
            log_activity(db, self.user, '新建 BOM 版本', version['product_id'], version['name'])
            return {'id':bid}
        if resource=='bom-materials' and method=='POST':
            version=exists(db,'bom_versions',d.get('version_id'))
            part=self.mutate(db,'/api/parts','POST',d)
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
            version=exists(db,'bom_versions',d['version_id'])
            count=created=0
            db.execute('UPDATE products SET updated_at=? WHERE id=?',(now(),version['product_id']))
            if not isinstance(d.get('rows'),list) or not 1 <= len(d['rows']) <= 5000:
                raise Problem('每次导入 1 至 5000 行')
            for index, row in enumerate(d['rows'], 2):
                try:
                    if not isinstance(row, dict):
                        raise Problem('物料行格式无效')
                    code = str(row.get('code') or '').strip()
                    name = str(row.get('name') or '').strip()
                    spec = str(row.get('spec') or '').strip()
                    external = str(row.get('external_code') or '').strip() or code
                    qty = num(row.get('qty'), True)
                    level = material_level(row.get('material_level') or d.get('material_level') or 1)
                    category = str(row.get('category') or '').strip() or BUILTIN_MATERIAL_CATEGORIES[level - 1]
                    part_id = find_bom_import_part(db, version['product_id'], code, external, name, spec, level, category)
                    if part_id:
                        active_part(db, part_id)
                    else:
                        if not name:
                            raise Problem('找不到对应物料，请填写物料名称以便自动新建')
                        part_id = self.mutate(db, '/api/parts', 'POST', {
                            'name': name, 'external_code': external, 'spec': spec,
                            'material_level': level, 'category': category, 'unit': row.get('unit') or 'PCS',
                            'price': bom_import_price(row.get('price')),
                        })['id']
                        created += 1
                    insert_bom_line(db, version['id'], part_id, qty, str(row.get('reference') or ''),
                                    str(row.get('notes') or ''), upsert=True)
                    count += 1
                except Problem as exc:
                    raise Problem(f'第 {index} 行：{exc.message}', exc.status) from exc
            log_activity(db, self.user, '导入 BOM', version['product_id'], version['name'],
                         f'{count} 条明细 · 新建物料 {created} 项')
            return {'count':count, 'created':created, 'reused':count-created}
        if resource == 'purchases':
            if method == 'POST' and not id:
                return {'id': record_purchase(db, d, self.user)}
            if method == 'DELETE' and id:
                return {'id': delete_purchase(db, id, d.get('expected'), self.user)}
            if method == 'PUT' and id:
                purchase = active_purchase(db, id)
                if set(d) == {'responsible_id'}:
                    if not d['responsible_id']:
                        raise Problem('请选择采购负责人')
                    owner = assign_user(db, d['responsible_id'])
                    db.execute('UPDATE purchases SET responsible_id=? WHERE id=?', (owner, id))
                    log_activity(db, self.user, '修改采购负责人', id, purchase['code'], exists(db, 'users', owner)['name'])
                    return {'id': id}
                return {'id': record_purchase(db, d, self.user, purchase)}
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
            f = exists(db, 'files', id)
            db.execute('DELETE FROM files WHERE id=?', (id,))
            log_activity(db, self.user, '删除图片' if f['kind'] == 'image' else '删除附件',
                         f['owner_id'], f['display_name'] or f['name'])
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
                    # Clear the legacy numbering reference before removing the product.
                    db.execute('UPDATE parts SET numbering_product_id=NULL WHERE numbering_product_id=?', (id,))
                    log_activity(db, self.user, '删除产品', id, f"{record['code']} {record['name']}")
                db.execute(f'DELETE FROM {resource} WHERE id=?',(id,))
                if resource == 'suppliers':
                    log_activity(db, self.user, '删除供应商', id, record['name'])
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
                category=material_category(db, d.get('category'), level)
                if old and old['material_level']!=level and db.execute('SELECT 1 FROM material_links WHERE parent_id=? OR child_id=?',(id,id)).fetchone(): raise Problem('请先解除一级、二级物料关联，再更改级别')
                serial=old['material_serial'] if old else next_material_serial(db)
                same_classification=old and (old['category'],old['material_level'])==(category,level)
                code=old['code'] if same_classification else material_code(category,level,serial)
                if old and code!=old['code']:
                    insert_scoped(db, 'material_code_aliases', dict(code=old['code'], part_id=id), 'ON CONFLICT(code) DO NOTHING')
                values.update(code=code,material_serial=serial,material_level=level,category=category,spec=str(d.get('spec','')),external_code=str(d.get('external_code','')).strip(),brand=str(d.get('brand','')).strip(),unit=str(d.get('unit','') or '').strip() or 'PCS',price=num(d.get('price') or 0),min_stock=num(d.get('min_stock') or 0),location=str(d.get('location') or '').strip(),sub_product_id=None,notes=str(d.get('notes','')),updated_at=now())
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
            if resource=='parts' and parent_ids is not None:
                if values['material_level']!=2 and parent_ids: raise Problem('只有二级物料可以选择关联一级物料')
                if values['material_level']==2: set_material_parents(db,id,parent_ids)
            if resource=='parts' and 'supplier_changes' in d:
                self.change_part_suppliers(db, id, d['supplier_changes'])
            if resource=='parts' and 'bom_changes' in d:
                self.change_part_boms(db, id, d['bom_changes'])
            noun = {'parts': '物料', 'products': '产品', 'suppliers': '供应商'}[resource]
            subject = f"{values['code']} {values['name']}" if 'code' in values else values['name']
            log_activity(db, self.user, ('新增' if method == 'POST' else '修改') + noun, id, subject)
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
                saved=self.mutate(db,'/api/parts','POST',{**row,'material_level':2,'category':'电子物料','unit':row['unit'] or 'PCS'})
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
    def receive_file_batch(self, directory):
        size = self.body_size()
        header = self.rfile.readline(min(size, 4 * UPLOAD_CHUNK) + 1)
        if not header.endswith(b'\n') or len(header) > size or len(header) > 4 * UPLOAD_CHUNK:
            raise Problem('文件清单格式错误')
        manifest = json.loads(header)
        if not isinstance(manifest, dict) or not isinstance(manifest.get('files'), list):
            raise Problem('文件清单格式错误')
        entries = manifest['files']
        if not entries or any(
            not isinstance(item, dict) or type(item.get('size')) is not int
            or item['size'] <= 0 or not isinstance(item.get('name'), str)
            for item in entries
        ):
            raise Problem('请选择非空文件')
        payload_size = size - len(header)
        if sum(item['size'] for item in entries) != payload_size:
            raise Problem('文件长度与清单不一致')
        if payload_size > shutil.disk_usage(directory).free:
            raise Problem('服务器剩余空间不足，无法接收文件', 507)
        uploads = []
        for index, entry in enumerate(entries):
            temporary = directory / str(index)
            with temporary.open('wb') as target:
                self.stream_body(entry['size'], target)
            uploads.append((entry['name'], temporary, entry['size']))
        return manifest, uploads

    def upload(self, project_id):
        with connect() as db:
            enter_project(db, project_id, self.user, write=True)
        slot = large_upload_slot() if self.body_size() > MAX_UPLOAD else nullcontext()
        with slot, tempfile.TemporaryDirectory(dir=DATA) as folder:
            directory = Path(folder)
            if self.headers.get_content_type() == FILE_BATCH_TYPE:
                fields, uploads = self.receive_file_batch(directory)
            else:
                fields, legacy = self.multipart()
                uploads = []
                for index, (name, _, blob) in enumerate(legacy):
                    temporary = directory / str(index)
                    temporary.write_bytes(blob)
                    uploads.append((name, temporary, len(blob)))
            with FILE_LOCK:
                ids = self.save_uploads(project_id, fields, uploads)
        self.send({'ids': ids})

    def save_uploads(self, project_id, fields, uploads):
        owner = fields.get('owner_type')
        owner_id = fields.get('owner_id')
        replace_id = fields.get('replace_id')
        if owner not in ('products', 'parts') or not uploads:
            raise Problem('请选择上传文件')
        if replace_id and len(uploads) != 1:
            raise Problem('替换请选择一个文件')
        created = []
        try:
            with transaction() as db:
                user = self.authorized(db)
                if not user or user['must_change']:
                    raise Problem('请先登录', 401)
                enter_project(db, project_id, user, write=True)
                record = exists(db, owner, owner_id)
                db.execute(f'UPDATE {owner} SET updated_at=? WHERE id=?', (now(), owner_id))
                old = None
                if replace_id:
                    old = exists(db, 'files', replace_id)
                    if old['owner_type'] != owner or old['owner_id'] != owner_id:
                        raise Problem('不能替换其他记录的附件')
                existing = db.execute('SELECT display_name FROM files WHERE owner_type=? AND owner_id=?',
                                      (owner, owner_id)).fetchall()
                used_names = {row[0] for row in existing}
                position = len(existing) + 1
                for filename, temporary, size in uploads:
                    if not size:
                        raise Problem('不能上传空文件')
                    fid = uid()
                    name = Path(filename.replace('\\', '/')).name[:200]
                    ext = Path(name).suffix.lower()
                    image_type = IMAGE_MIMES.get(ext)
                    mime = image_type or ('application/pdf' if ext == '.pdf' else 'application/octet-stream')
                    kind = 'image' if image_type else 'attachment'
                    if image_type:
                        with temporary.open('rb') as source:
                            if image_mime(source.read(12)) != image_type:
                                raise Problem('图片格式与文件内容不匹配')
                    display_name = ''
                    if image_type:
                        if old and old['display_name']:
                            display_name = Path(old['display_name']).stem + ext
                        else:
                            display_name = owner_file_name(name, record['code'], record['name'], position)
                            while display_name in used_names:
                                position += 1
                                display_name = owner_file_name(name, record['code'], record['name'], position)
                            used_names.add(display_name)
                            position += 1
                    temporary.replace(DATA / 'uploads' / fid)
                    created.append(fid)
                    if old:
                        db.execute('UPDATE files SET id=?,name=?,mime=?,size=?,kind=?,created_at=?,display_name=? WHERE id=?',
                                   (fid, name, mime, size, kind, now(), display_name, old['id']))
                    else:
                        insert_scoped(db, 'files', dict(id=fid, owner_type=owner, owner_id=owner_id,
                                                       name=name, mime=mime, size=size, kind=kind,
                                                       created_at=now(), display_name=display_name))
                log_activity(db, user, '替换文件' if replace_id else '上传文件', owner_id,
                             record['name'], f'{len(created)} 个文件')
                touch_project(db)
        except Exception:
            for fid in created:
                remove_upload(fid)
            raise
        if replace_id:
            remove_upload(replace_id)
        return created

    def delete_library_image(self, kind, id):
        if self.body().get('confirm') is not True:
            raise Problem('请确认永久删除图片')
        with FILE_LOCK, ExitStack() as files, transaction() as db:
            user = self.authorized(db)
            if not user or user['role'] != 'admin' or user['must_change']:
                raise Problem('需要管理员权限', 403)
            if kind == 'file':
                file = exists(db, 'files', id)
                if file['kind'] != 'image':
                    raise Problem('请选择图片')
                files.enter_context(stage_upload_deletion([id]))
                db.execute('DELETE FROM files WHERE id=?', (id,))
                db.project_id = file['project_id']
                log_activity(db, user, '永久删除图片', file['owner_id'], file['display_name'] or file['name'])
                touch_project(db)
            elif kind == 'cover':
                project = exists(db, 'projects', id)
                if db.execute('DELETE FROM project_covers WHERE project_id=?', (id,)).rowcount:
                    db.project_id = id
                    log_activity(db, user, '移除项目封面', id, project['name'])
                    touch_project(db)
            else:
                account = exists(db, 'users', id)
                if db.execute("UPDATE users SET avatar=NULL,avatar_mime='' WHERE id=? AND avatar IS NOT NULL", (id,)).rowcount:
                    log_activity(db, user, '删除用户头像', id, account['name'])
        self.send({'ok': True})

    def purge_deleted_part(self, project_id, id):
        if self.body().get('confirm') is not True:
            raise Problem('请确认永久删除物料')
        with FILE_LOCK, ExitStack() as files, transaction() as db:
            user = self.authorized(db)
            if not user or user['role'] != 'admin' or user['must_change']:
                raise Problem('需要管理员权限', 403)
            enter_project(db, project_id, user, write=True)
            part = exists(db, 'parts', id)
            if not part['deleted_at']:
                raise Problem('请先将物料移至已删除物料', 409)
            blockers = [
                label for table, label in (
                    ('bom_lines', 'BOM'), ('purchase_lines', '采购明细'), ('movements', '库存流水'),
                )
                if db.execute(f'SELECT 1 FROM {table} WHERE part_id=? LIMIT 1', (id,)).fetchone()
            ]
            if blockers:
                raise Problem('物料仍被' + '、'.join(blockers) + '引用，无法永久删除', 409)
            ids = [row[0] for row in db.execute(
                "SELECT id FROM files WHERE project_id=? AND owner_type='parts' AND owner_id=?", (project_id, id))]
            if ids:
                files.enter_context(stage_upload_deletion(ids))
            db.execute("DELETE FROM files WHERE project_id=? AND owner_type='parts' AND owner_id=?", (project_id, id))
            db.execute('DELETE FROM quotes WHERE part_id=?', (id,))
            db.execute('DELETE FROM parts WHERE id=?', (id,))
            log_activity(db, user, '永久删除物料', '', part['code'])
            touch_project(db)
        self.send({'ok': True})

    def list_assets(self):
        query = parse_qs(urlparse(self.path).query)
        term = query.get('q', [''])[0].strip()[:200].lower()
        kind = query.get('kind', [''])[0]
        try:
            page = max(1, min(100000, int(query.get('page', ['1'])[0])))
        except ValueError:
            raise Problem('页码无效')
        page_size = 50
        with connect() as db:
            rows = db.execute("""
                WITH fallback_covers AS (
                    SELECT (
                        SELECT f.id FROM files f WHERE f.project_id = j.id
                          AND f.owner_type = 'products' AND f.kind = 'image'
                        ORDER BY f.rowid DESC LIMIT 1
                    ) AS file_id
                    FROM projects j LEFT JOIN project_covers c ON c.project_id = j.id
                    WHERE j.deleted_at IS NULL AND c.project_id IS NULL
                ), assets AS (
                    SELECT 'file' AS source, f.id, COALESCE(NULLIF(f.display_name, ''), f.name) AS name, f.kind, f.size, f.created_at,
                           COALESCE(j.name, '') AS project,
                           COALESCE(p.code || ' · ' || p.name, m.code || ' · ' || m.name, '') AS owner,
                           (p.id IS NOT NULL OR m.id IS NOT NULL) + (fc.file_id IS NOT NULL) AS reference_count,
                           (fc.file_id IS NOT NULL) AS fallback_cover
                    FROM files f
                    LEFT JOIN projects j ON j.id = f.project_id
                    LEFT JOIN products p ON f.owner_type = 'products' AND p.id = f.owner_id AND p.project_id = f.project_id
                    LEFT JOIN parts m ON f.owner_type = 'parts' AND m.id = f.owner_id AND m.project_id = f.project_id
                    LEFT JOIN fallback_covers fc ON fc.file_id = f.id
                    UNION ALL
                    SELECT 'cover', c.project_id, j.code || ' · 项目封面' ||
                           CASE c.mime WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/webp' THEN '.webp' ELSE '.png' END,
                           'image', length(c.image),
                           c.updated_at, j.name, '项目封面', 1, 0
                    FROM project_covers c JOIN projects j ON j.id = c.project_id
                    UNION ALL
                    SELECT 'avatar', u.id, u.name || ' · 头像', 'image', length(u.avatar),
                           u.created_at, '', u.name, 1, 0
                    FROM users u WHERE length(u.avatar) > 0
                )
                SELECT source, id, name, kind, size, project, owner, reference_count, fallback_cover
                FROM assets
                WHERE (? = '' OR kind = ?)
                  AND instr(lower(name || ' ' || project || ' ' || owner), ?) > 0
                ORDER BY created_at DESC, source, id
                LIMIT ? OFFSET ?
            """, (kind, kind, term, page_size + 1, (page - 1) * page_size)).fetchall()
        return self.send({'items': [dict(row) for row in rows[:page_size]], 'more': len(rows) > page_size})

    def serve_file(self, id, *, admin_assets=False):
        with FILE_LOCK:
            with connect() as db:
                db.execute('BEGIN')
                user = self.authorized(db)
                if not user or user['must_change']:
                    raise Problem('请先登录', 401)
                f = exists(db, 'files', id)
                if admin_assets:
                    if user['role'] != 'admin':
                        raise Problem('需要管理员权限', 403)
                else:
                    enter_project(db, f['project_id'], user)
                name = f['display_name'] or f['name']
                owner = f['owner_type']
                record = db.execute(f'SELECT code,name FROM {owner} WHERE id=?', (f['owner_id'],)).fetchone()
                if record and not f['display_name']:
                    position = db.execute(
                        """SELECT COUNT(*) FROM files WHERE owner_type=? AND owner_id=?
                           AND rowid <= (SELECT rowid FROM files WHERE id=?)""",
                        (owner, f['owner_id'], id),
                    ).fetchone()[0]
                    name = owner_file_name(name, record['code'], record['name'], position)
            try:
                source = (DATA / 'uploads' / id).open('rb')
            except FileNotFoundError as exc:
                raise Problem('文件未找到', 404) from exc
        with source:
            image_type = image_mime(source.read(12)) if f['kind'] == 'image' else None
            source.seek(0)
            content_type = image_type or ('application/pdf' if f['mime'] == 'application/pdf' else 'application/octet-stream')
            stat = os.fstat(source.fileno())
            revision = json.dumps([id, stat.st_mtime_ns, stat.st_size, name, content_type, image_type])
            etag = hashlib.sha256(revision.encode()).hexdigest()
            disposition = 'inline' if image_type else 'attachment'
            filename = f"{disposition}; filename*=UTF-8''{quote(name, safe='')}"
            if self.send_asset_headers(content_type, stat.st_size, etag, filename):
                shutil.copyfileobj(source, self.wfile, UPLOAD_CHUNK)

    def backup(self):
        with tempfile.TemporaryDirectory(dir=DATA) as folder:
            output = Path(folder) / 'backup.zip'
            write_backup(output)
            with transaction() as db:
                log_activity(db, self.user, '导出数据备份', '', 'ZIP 数据备份')
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
        with large_upload_slot():
            return self.receive_restore()

    def receive_restore(self):
        size = self.body_size()
        if not size:
            raise Problem('请选择 ZIP 备份')
        if self.headers.get('X-PLM-Restore') != 'replace':
            raise Problem('请确认覆盖当前数据')
        with tempfile.TemporaryDirectory(dir=DATA) as folder:
            directory = Path(folder)
            archive = directory / 'restore.zip'
            if size > shutil.disk_usage(directory).free:
                raise Problem('服务器剩余空间不足，无法接收备份', 507)
            with archive.open('wb') as target:
                self.stream_body(size, target)
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
        insert_scoped(db, 'parts', dict(id=part_ids[key], code=material_code(category, level, serial),
                                       name=name, category=category, spec=spec, unit=unit, price=price,
                                       min_stock=minimum, location=location, material_level=level,
                                       material_serial=serial,
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
    with transaction() as db:
        shopify_orders.backfill_addresses(db, now())
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

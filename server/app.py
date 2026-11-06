#!/usr/bin/env python3
"""捷程未来PLM：仅依赖 Python 3.10+ 标准库。"""
import argparse, hashlib, hmac, io, json, math, mimetypes, os, re, secrets, sqlite3, sys, time, threading, shutil
from contextlib import contextmanager
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer as BaseThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse, unquote
from electronic_import import parse_electronic_file, ElectronicBomError

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get('PLM_DATA_DIR', str(ROOT / 'data'))).resolve()
MAX_UPLOAD = 20 * 1024 * 1024
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
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires REAL NOT NULL);
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

def init_db():
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / 'uploads').mkdir(exist_ok=True)
    with connect() as db:
        db.executescript(SCHEMA + QUOTES_SCHEMA)
        columns={r[1] for r in db.execute('PRAGMA table_info(parts)')}
        product_columns={r[1] for r in db.execute('PRAGMA table_info(products)')}
        version=db.execute('PRAGMA user_version').fetchone()[0]
        if version>6: raise RuntimeError('数据库版本高于当前程序版本')
        if version<5 and (db.execute('SELECT 1 FROM parts LIMIT 1').fetchone() or db.execute('SELECT 1 FROM products LIMIT 1').fetchone()):
            backup_path=DATA/'plm.before-v5.sqlite3'
            if not backup_path.exists():
                backup=sqlite3.connect(backup_path)
                try: db.backup(backup)
                finally: backup.close()
        if version == 5:
            backup_path = DATA / 'plm.before-v6.sqlite3'
            if not backup_path.exists():
                backup = sqlite3.connect(backup_path)
                try:
                    db.backup(backup)
                finally:
                    backup.close()
        db.execute('BEGIN IMMEDIATE')
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
        db.execute('PRAGMA user_version=6')

class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        try: return super().__exit__(exc_type, exc_value, traceback)
        finally: self.close()

def connect():
    db = sqlite3.connect(DATA / 'plm.sqlite3', timeout=15, factory=ClosingConnection)
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
    r = db.execute(f'SELECT * FROM {table} WHERE id=?', (id,)).fetchone()
    if not r: raise Problem('关联记录不存在', 404)
    return dict(r)

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

def record_movement(db, data):
    kind = data.get('type')
    if kind not in ('入库','出库','退库','报废'): raise Problem('无效的库存操作')
    part = exists(db, 'parts', data.get('part_id'))
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
    db.execute('INSERT INTO movements VALUES(?,?,?,?,?,?,?,?,?,?,?)',(mid,next_code(db,'ST'),kind,part['id'],qty,balance,product_id,purchase_line,original_id,reason,now()))
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
    parent=exists(db,'parts',parent_id);child=exists(db,'parts',child_id)
    if parent['material_level']!=1 or child['material_level']!=2: raise Problem('只能将一级物料关联到二级物料')
    quantity=num(qty,True);id=uid()
    db.execute('INSERT INTO material_links(id,parent_id,child_id,qty,created_at) VALUES(?,?,?,?,?) ON CONFLICT(parent_id,child_id) DO UPDATE SET qty=excluded.qty',(id,parent_id,child_id,quantity,now()))
    db.execute('UPDATE parts SET updated_at=? WHERE id IN (?,?)',(now(),parent_id,child_id))
    return db.execute('SELECT id FROM material_links WHERE parent_id=? AND child_id=?',(parent_id,child_id)).fetchone()[0]

def set_material_parents(db,child_id,parent_ids):
    child=exists(db,'parts',child_id)
    if child['material_level']!=2: raise Problem('关联一级物料仅适用于二级物料')
    if not isinstance(parent_ids,list) or len(parent_ids)>1000 or any(not isinstance(p,str) for p in parent_ids): raise Problem('关联记录格式错误')
    selected=list(dict.fromkeys(parent_ids))
    for parent_id in selected:
        if exists(db,'parts',parent_id)['material_level']!=1: raise Problem('请选择一级物料')
    existing={r['parent_id']:dict(r) for r in db.execute('SELECT * FROM material_links WHERE child_id=?',(child_id,))}
    for parent_id,link in existing.items():
        if parent_id not in selected: db.execute('DELETE FROM material_links WHERE id=?',(link['id'],))
    for parent_id in selected:
        if parent_id not in existing: link_material(db,parent_id,child_id)
    db.execute('UPDATE parts SET updated_at=? WHERE id=?',(now(),child_id))

def set_material_children(db,parent_id,child_ids):
    if exists(db,'parts',parent_id)['material_level']!=1: raise Problem('二级物料列表仅适用于一级物料')
    if not isinstance(child_ids,list) or len(child_ids)>1000 or any(not isinstance(c,str) for c in child_ids): raise Problem('关联记录格式错误')
    selected=list(dict.fromkeys(child_ids))
    for child_id in selected:
        if exists(db,'parts',child_id)['material_level']!=2: raise Problem('请选择二级物料')
    existing={r['child_id']:dict(r) for r in db.execute('SELECT * FROM material_links WHERE parent_id=?',(parent_id,))}
    for child_id,link in existing.items():
        if child_id not in selected: db.execute('DELETE FROM material_links WHERE id=?',(link['id'],))
    for child_id in selected:
        if child_id not in existing: link_material(db,parent_id,child_id)
    db.execute('UPDATE parts SET updated_at=? WHERE id=?',(now(),parent_id))

def automatic_version(db, product_id):
    existing={r[0] for r in db.execute('SELECT name FROM bom_versions WHERE product_id=?',(product_id,))}
    n=1
    while f'V{n}.0' in existing: n+=1
    return f'V{n}.0'

TABLES = ('products','parts','suppliers','quotes','bom_versions','bom_lines','purchases','purchase_lines','movements','files','material_links','material_code_aliases')

def get_state(db):
    db.execute('BEGIN')
    state = {t: [{k:r[k] for k in r.keys() if k != 'sub_product_id'}
                 for r in db.execute(f'SELECT * FROM {t} ORDER BY rowid')] for t in TABLES}
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
    return state


class ThreadingHTTPServer(BaseThreadingHTTPServer):
    request_queue_size=64
    daemon_threads=True

class Handler(BaseHTTPRequestHandler):
    server_version = 'JiechengPLM/1.4'
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
    def authorized(self, db):
        try:
            jar=cookies.SimpleCookie(); jar.load(self.headers.get('Cookie',''))
            token=jar['plm_session'].value
        except (KeyError, cookies.CookieError): return False
        return bool(db.execute('SELECT 1 FROM sessions WHERE token=? AND expires>?',(hashlib.sha256(token.encode()).hexdigest(),time.time())).fetchone())
    def cookie(self, token, age=604800):
        secure = '; Secure' if os.environ.get('PLM_SECURE_COOKIE') == '1' else ''
        return f'plm_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={age}{secure}'
    def do_GET(self): self.handle_request('GET')
    def do_POST(self): self.handle_request('POST')
    def do_PUT(self): self.handle_request('PUT')
    def do_DELETE(self): self.handle_request('DELETE')
    def handle_request(self, method):
        try:
            path = unquote(urlparse(self.path).path)
            if method != 'GET':
                origin = self.headers.get('Origin')
                if origin and urlparse(origin).netloc != self.headers.get('Host'): raise Problem('请求来源不被允许',403)
                if self.headers.get('Sec-Fetch-Site') == 'cross-site': raise Problem('请求来源不被允许',403)
            if path == '/api/health': return self.send({'ok':True})
            if path == '/api/auth/status':
                with connect() as db: return self.send({'initialized':bool(db.execute("SELECT 1 FROM settings WHERE key='password'").fetchone()),'authenticated':self.authorized(db)})
            if path in ('/api/auth/setup','/api/auth/login') and method == 'POST': return self.auth(path)
            if path.startswith('/api/') or path.startswith('/files/'):
                with connect() as db:
                    if not self.authorized(db): raise Problem('请先登录',401)
            if path == '/api/auth/logout' and method == 'POST':
                jar=cookies.SimpleCookie(); jar.load(self.headers.get('Cookie',''))
                token=jar.get('plm_session')
                if token:
                    with transaction() as db: db.execute('DELETE FROM sessions WHERE token=?',(hashlib.sha256(token.value.encode()).hexdigest(),))
                return self.send({'ok':True},extra={'Set-Cookie':self.cookie('',0)})
            if path == '/api/state' and method == 'GET':
                with connect() as db: return self.send(get_state(db))
            if path == '/api/backup' and method == 'GET':
                with FILE_LOCK: return self.backup()
            if path.startswith('/files/') and method == 'GET':
                with FILE_LOCK: return self.serve_file(path.split('/')[-1])
            if path == '/api/electronic-import/preview' and method == 'POST': return self.electronic_preview()
            if path == '/api/files' and method == 'POST':
                with FILE_LOCK: return self.upload()
            if path.startswith('/api/') and method != 'GET':
                data = self.body()
                with FILE_LOCK:
                    with transaction() as db: result = self.mutate(db,path,method,data)
                    for fid in result.pop('_delete_files', []): remove_upload(fid)
                return self.send(result)
            if method == 'GET': return self.static(path)
            raise Problem('接口不存在',404)
        except (ConnectionResetError,BrokenPipeError,TimeoutError): return
        except Problem as e: self.send({'error':e.message},e.status)
        except sqlite3.IntegrityError as e:
            msg = '英文代号已使用' if 'products.english_code' in str(e) else '该记录仍被 BOM、采购或库存流水引用，不能删除' if 'FOREIGN KEY' in str(e) else '编码或关联物料重复，请检查输入'
            self.send({'error':msg},409)
        except (ValueError,TypeError,KeyError) as e: self.send({'error':'输入数据不完整或格式错误'},400)
        except Exception as e:
            print(f'Internal error: {e}',file=sys.stderr)
            self.send({'error':'服务暂时不可用，请查看服务器日志'},500)
    def auth(self,path):
        ip=self.client_address[0]; recent=[x for x in self.attempts.get(ip,[]) if x>time.time()-600]
        self.attempts[ip]=recent
        if len(recent)>=12: raise Problem('尝试次数过多，请十分钟后重试',429)
        data=self.body(); password=str(data.get('password',''))
        with transaction() as db:
            row=db.execute("SELECT value FROM settings WHERE key='password'").fetchone()
            if path.endswith('setup'):
                if row: raise Problem('管理员已经初始化',409)
                if len(password)<10 or len(password)>256: raise Problem('密码长度应为 10 至 256 个字符')
                salt=secrets.token_hex(16)
                db.execute('INSERT INTO settings VALUES(?,?)',('password',json.dumps({'salt':salt,'hash':password_hash(password,salt)})))
            else:
                self.attempts[ip].append(time.time())
                if not row: raise Problem('请先设置管理员密码')
                stored=json.loads(row[0])
                if not hmac.compare_digest(stored['hash'],password_hash(password,stored['salt'])): raise Problem('密码不正确',401)
            token=secrets.token_urlsafe(32)
            db.execute('DELETE FROM sessions WHERE expires<?',(time.time(),))
            db.execute('INSERT INTO sessions VALUES(?,?)',(hashlib.sha256(token.encode()).hexdigest(),time.time()+604800))
        self.attempts.pop(ip,None)
        self.send({'ok':True},extra={'Set-Cookie':self.cookie(token)})
    def mutate(self,db,path,method,d):
        seg=path.strip('/').split('/'); resource=seg[1]; id=seg[2] if len(seg)>2 else None
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
        if resource=='movements' and method=='POST': return {'id':record_movement(db,d)}
        if resource=='demo' and method=='POST':
            if any(db.execute(f'SELECT 1 FROM {t} LIMIT 1').fetchone() for t in ('products','parts','suppliers','purchases','movements')): raise Problem('仅空数据库可以载入示例')
            seed_demo(db); return {'ok':True}
        if resource=='bom-versions' and method=='POST':
            exists(db,'products',d['product_id']); bid=uid()
            db.execute('UPDATE products SET updated_at=? WHERE id=?',(now(),d['product_id']))
            db.execute('INSERT INTO bom_versions VALUES(?,?,?,?,?)',(bid,d['product_id'],automatic_version(db,d['product_id']),str(d.get('notes','')),now()))
            if d.get('copy_from'):
                v=exists(db,'bom_versions',d['copy_from'])
                if v['product_id']!=d['product_id']: raise Problem('仅可复制本产品的 BOM')
                for line in db.execute('SELECT * FROM bom_lines WHERE version_id=? ORDER BY rowid',(v['id'],)).fetchall():
                    db.execute('INSERT INTO bom_lines VALUES(?,?,?,?,?,?)',(uid(),bid,line['part_id'],line['qty'],line['reference'],line['notes']))
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
                db.execute('DELETE FROM bom_lines WHERE id=?',(id,)); return {'ok':True}
            if method in ('POST','PUT'):
                if method=='PUT': d={**exists(db,'bom_lines',id),**d}
                version=exists(db,'bom_versions',d['version_id']); exists(db,'parts',d['part_id'])
                db.execute('UPDATE products SET updated_at=? WHERE id=?',(now(),version['product_id']))
                values=(d['version_id'],d['part_id'],num(d.get('qty'),True),str(d.get('reference','')),str(d.get('notes','')))
                if method=='POST':
                    id=uid(); db.execute('INSERT INTO bom_lines VALUES(?,?,?,?,?,?)',(id,*values))
                else:
                    exists(db,'bom_lines',id); db.execute('UPDATE bom_lines SET version_id=?,part_id=?,qty=?,reference=?,notes=? WHERE id=?',(*values,id))
                return {'id':id}
        if resource=='bom-import' and method=='POST':
            version=exists(db,'bom_versions',d['version_id']); count=0
            db.execute('UPDATE products SET updated_at=? WHERE id=?',(now(),version['product_id']))
            if not isinstance(d.get('rows'),list) or len(d['rows'])>5000: raise Problem('每次最多导入 5000 行')
            for i,row in enumerate(d['rows']):
                code=str(row.get('code','')).strip()
                part=db.execute('SELECT id FROM parts WHERE code=? UNION ALL SELECT part_id FROM material_code_aliases WHERE code=?',(code,code)).fetchone()
                if not part: raise Problem(f'第 {i+1} 行物料编码不存在，请先建立物料：{row.get("code","")}')
                db.execute('INSERT INTO bom_lines VALUES(?,?,?,?,?,?) ON CONFLICT(version_id,part_id) DO UPDATE SET qty=excluded.qty,reference=excluded.reference,notes=excluded.notes',(uid(),version['id'],part[0],num(row.get('qty'),True),str(row.get('reference','')),str(row.get('notes','')))); count+=1
            return {'count':count}
        if resource=='purchases' and method=='POST':
            exists(db,'suppliers',d['supplier_id']); id=uid()
            if not d.get('lines'): raise Problem('请至少添加一个采购物料')
            date=required(d.get('date'),'采购日期')
            try: datetime.strptime(date,'%Y-%m-%d')
            except ValueError: raise Problem('采购日期格式错误')
            db.execute('INSERT INTO purchases VALUES(?,?,?,?,?,?)',(id,next_code(db,'PO'),d['supplier_id'],date,str(d.get('notes','')),now()))
            for l in d['lines']:
                exists(db,'parts',l['part_id']); db.execute('INSERT INTO purchase_lines VALUES(?,?,?,?,?,?)',(uid(),id,l['part_id'],num(l['qty'],True),num(l['price']),0))
            return {'id':id}
        if resource == 'quotes' and method == 'POST':
            part_id = d['part_id']
            supplier_id = d['supplier_id']
            exists(db, 'parts', part_id)
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
                db.execute('INSERT INTO quotes VALUES(?,?,?,?,?)', (id, part_id, supplier_id, price, url))
            return {'id': id}
        if resource=='quotes' and method=='DELETE':
            db.execute('DELETE FROM quotes WHERE id=?',(id,)); return {'ok':True}
        if resource=='files' and method=='DELETE':
            f=exists(db,'files',id); db.execute('DELETE FROM files WHERE id=?',(id,))
            return {'ok':True,'_delete_files':[id]}
        if resource in ('products','parts','suppliers'):
            if method=='DELETE':
                exists(db,resource,id)
                if resource=='parts':
                    p=exists(db,'parts',id)
                    if p['stock']!=0: raise Problem('仍有库存的物料不能删除')
                    if db.execute('SELECT 1 FROM bom_lines WHERE part_id=? UNION ALL SELECT 1 FROM purchase_lines WHERE part_id=? UNION ALL SELECT 1 FROM movements WHERE part_id=? LIMIT 1',(id,id,id)).fetchone(): raise Problem('物料已有业务记录，不能删除')
                    db.execute('DELETE FROM quotes WHERE part_id=?',(id,))
                if resource=='products':
                    versions=[r[0] for r in db.execute('SELECT id FROM bom_versions WHERE product_id=?',(id,))]
                    if any(db.execute('SELECT 1 FROM bom_lines WHERE version_id=?',(v,)).fetchone() for v in versions): raise Problem('产品仍有 BOM 明细，不能删除')
                    db.execute('DELETE FROM bom_versions WHERE product_id=?',(id,))
                db.execute(f'DELETE FROM {resource} WHERE id=?',(id,))
                removed=[r[0] for r in db.execute('SELECT id FROM files WHERE owner_type=? AND owner_id=?',(resource,id))]
                db.execute('DELETE FROM files WHERE owner_type=? AND owner_id=?',(resource,id)); return {'ok':True,'_delete_files':removed}
            if method not in ('POST','PUT'): raise Problem('不支持的操作',405)
            old=exists(db,resource,id) if method=='PUT' else None
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
                    db.execute('INSERT OR IGNORE INTO material_code_aliases VALUES(?,?)',(old['code'],id))
                    code=material_code(db,category,level,numbering_product_id,serial)
                values.update(code=code,material_serial=serial,numbering_product_id=numbering_product_id,material_level=level,category=category,spec=str(d.get('spec','')),external_code=str(d.get('external_code','')).strip(),brand=str(d.get('brand','')).strip(),unit=str(d.get('unit','') or '').strip() or 'PCS',price=num(d.get('price') or 0),min_stock=num(d.get('min_stock') or 0),location=str(d.get('location','')),sub_product_id=None,notes=str(d.get('notes','')),updated_at=now())
            else: values.update({k:str(d.get(k,'')) for k in ('contact','phone','email','address','notes')})
            if method=='POST':
                id=uid(); values.update(id=id,created_at=now())
                cols=list(values); db.execute(f'INSERT INTO {resource} ({",".join(cols)}) VALUES({",".join("?" for _ in cols)})',tuple(values.values()))
                if resource=='products': db.execute('INSERT INTO bom_versions VALUES(?,?,?,?,?)',(uid(),id,'V1.0','初始版本',now()))
            else:
                exists(db,resource,id); db.execute(f'UPDATE {resource} SET '+','.join(k+'=?' for k in values)+' WHERE id=?',(*values.values(),id))
            if resource=='products' and old and old['english_code']!=values['english_code']:
                for material in db.execute('SELECT * FROM parts WHERE numbering_product_id=?',(id,)).fetchall():
                    expected=material_prefix(material['category'],material['material_level'],product_prefix(db,id))
                    if not material['code'].startswith(expected):
                        db.execute('INSERT OR IGNORE INTO material_code_aliases VALUES(?,?)',(material['code'],material['id']))
                        db.execute('UPDATE parts SET code=?,updated_at=? WHERE id=?',(material_code(db,material['category'],material['material_level'],id,material['material_serial']),now(),material['id']))
            if resource=='parts' and parent_ids is not None:
                if values['material_level']!=2 and parent_ids: raise Problem('只有二级物料可以选择关联一级物料')
                if values['material_level']==2: set_material_parents(db,id,parent_ids)
            return {'id':id}
        raise Problem('接口不存在或不支持该操作',404)
    def electronic_preview(self):
        fields,uploads=self.multipart()
        if len(uploads)!=1: raise Problem('请选择一个 XLSX 或 CSV 文件')
        filename,mime,blob=uploads[0]
        try:
            result=parse_electronic_file(blob,filename,fields.get('sheet',''))
        except (ElectronicBomError,ValueError,KeyError,RuntimeError) as exc: raise Problem(str(exc))
        with connect() as db:
            candidates=[dict(r) for r in db.execute('SELECT * FROM parts WHERE material_level=2')]
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
            material=exists(db,'parts',row['target_part_id'])
            if material['material_level']!=2: raise Problem('只能复用二级物料')
            return material
        code=str(row.get('internal_code','')).strip()
        if code:
            found=db.execute('SELECT id FROM parts WHERE code=? UNION ALL SELECT part_id FROM material_code_aliases WHERE code=?',(code,code)).fetchone()
            if not found: raise Problem('系统物料编号不存在：'+code)
            material=exists(db,'parts',found[0])
            if material['material_level']!=2: raise Problem('系统编号对应的不是二级物料')
            return material
        key=lambda r: tuple(str(r.get(k) or '').strip().casefold() for k in ('external_code','name','spec','brand'))
        if candidates is None: candidates=[dict(r) for r in db.execute('SELECT * FROM parts WHERE material_level=2')]
        matches=[p for p in candidates if key(p)==key(row)]
        if len(matches)>1: raise Problem('有多个匹配物料，请手动选择复用记录')
        return matches[0] if matches else None
    def commit_electronic_import(self,db,d):
        request_id=str(d.get('request_id',''))
        if not 16<=len(request_id)<=80 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' for c in request_id): raise Problem('导入请求标识无效')
        body={k:v for k,v in d.items() if k!='request_id'}
        fingerprint=hashlib.sha256(json.dumps(body,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        previous=db.execute('SELECT * FROM import_runs WHERE id=?',(request_id,)).fetchone()
        if previous:
            if previous['fingerprint']!=fingerprint: raise Problem('本次导入已完成，修改文件后请重新导入',409)
            return json.loads(previous['result'])
        rows=d.get('rows')
        if not isinstance(rows,list) or not 1<=len(rows)<=5000: raise Problem('请选择 1 至 5000 条物料')
        parent_id=d.get('parent_id') or None;version_id=d.get('version_id') or None
        parent=exists(db,'parts',parent_id) if parent_id else None
        if parent and parent['material_level']!=1: raise Problem('关联目标必须是一级物料')
        version=exists(db,'bom_versions',version_id) if version_id else None
        source=parent['numbering_product_id'] if parent else version['product_id'] if version else d.get('numbering_product_id') or None
        if source: exists(db,'products',source)
        candidates=[dict(r) for r in db.execute('SELECT * FROM parts WHERE material_level=2')]
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
                db.execute('INSERT INTO bom_lines VALUES(?,?,?,?,?,?) ON CONFLICT(version_id,part_id) DO UPDATE SET qty=excluded.qty,reference=excluded.reference,notes=excluded.notes',(uid(),version_id,mid,group['qty'],reference,notes))
            total+=exists(db,'parts',mid)['price']*group['qty']
        if version: db.execute('UPDATE products SET updated_at=? WHERE id=?',(now(),version['product_id']))
        result={'rows':len(rows),'materials':len(groups),'created':created,'reused':len(reused),'reference_total':round(total,6)}
        db.execute('INSERT INTO import_runs VALUES(?,?,?,?)',(request_id,fingerprint,json.dumps(result),now()))
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
    def upload(self):
        fields,uploads=self.multipart()
        owner=fields.get('owner_type'); owner_id=fields.get('owner_id'); replace_id=fields.get('replace_id')
        if owner not in ('products','parts') or not uploads: raise Problem('请选择上传文件')
        if len(uploads)>12 or (replace_id and len(uploads)!=1): raise Problem('单次最多上传 12 个文件；替换请选择一个文件')
        created=[]
        try:
            with transaction() as db:
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
                        db.execute('INSERT INTO files VALUES(?,?,?,?,?,?,?,?)',
                                   (fid, owner, owner_id, name, mime, len(blob), kind, now()))
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
        self.send_header('Content-Type', f['mime'])
        self.send_header('Content-Length', str(len(b)))
        disposition = 'inline' if f['kind'] == 'image' else 'attachment'
        self.send_header('Content-Disposition', f"{disposition}; filename*=UTF-8''{quote(name, safe='')}")
        self.security_headers()
        self.send_header('Cache-Control', 'private, no-cache')
        self.end_headers()
        self.wfile.write(b)
    def backup(self):
        import tempfile, zipfile
        # SQLite online backup and a file snapshot are collected under FILE_LOCK.
        # The ZIP is streamed from disk so attachments do not all occupy memory.
        with tempfile.TemporaryDirectory() as td:
            target=sqlite3.connect(Path(td)/'plm.sqlite3')
            with connect() as db: db.backup(target)
            target.close()
            snapshot=sqlite3.connect(Path(td)/'plm.sqlite3')
            files=snapshot.execute('SELECT id FROM files').fetchall(); snapshot.close()
            output=Path(td)/'backup.zip'
            with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as z:
                z.write(Path(td)/'plm.sqlite3','plm.sqlite3')
                for (fid,) in files:
                    f=DATA/'uploads'/fid
                    if not f.is_file(): raise Problem('备份失败：有附件文件缺失，请检查服务器存储',500)
                    z.write(f,'uploads/'+fid)
            self.send_response(200)
            self.send_header('Content-Type','application/zip')
            self.send_header('Content-Disposition','attachment; filename="jiecheng-plm-backup-'+datetime.now().strftime('%Y%m%d')+'.zip"')
            self.send_header('Content-Length',str(output.stat().st_size))
            self.security_headers(); self.end_headers()
            with output.open('rb') as source: shutil.copyfileobj(source,self.wfile,1024*1024)
    def static(self,path):
        base=(ROOT/'dist').resolve(); file=(base/path.lstrip('/')).resolve()
        if not file.is_relative_to(base): raise Problem('无效路径',403)
        if not file.is_file(): file=base/'index.html'
        if not file.is_file(): raise Problem('前端尚未构建，请执行 npm install 和 npm run build',503)
        b=file.read_bytes(); self.send_response(200); self.send_header('Content-Type',mimetypes.guess_type(file.name)[0] or 'application/octet-stream'); self.send_header('Content-Length',str(len(b))); self.security_headers(); self.end_headers(); self.wfile.write(b)

def seed_demo(db):
    suppliers=[('s1','立创商城','采购客服','400-830-5888','support@szlcsc.com','深圳市','电子元件采购'),('s2','精工结构件供应商','陈工','','','东莞市','结构件加工与打样')]
    for s in suppliers: db.execute('INSERT INTO suppliers VALUES(?,?,?,?,?,?,?,?)',(*s,now()))
    products=[('p1','PRD-001','桌面空气监测仪','面向桌面环境的温湿度与空气质量监测终端','研发中'),('p2','PRD-002','便携式温控器','小型便携温度采集与控制设备','研发中'),('p3','PRD-003','无线传感节点','低功耗无线环境数据采集节点','研发中'),('p4','ASM-001','主控电路板组件','空气监测仪主控 PCB 与电子元件','已定版')]
    for i,p in enumerate(products):
        db.execute('INSERT INTO products(id,code,name,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',(*p,now(),now())); db.execute('INSERT INTO bom_versions VALUES(?,?,?,?,?)',('v'+p[0],p[0],'V1.0','示例初始版本',now()))
        db.execute('UPDATE products SET english_code=? WHERE id=?',(['AIR','TEMP','NODE','CTRL'][i],p[0]))
    parts=[('m1','MEC-0001','铝合金外壳','结构物料','CNC / 6061 / 阳极氧化','件',48,10,'A-01',None),('m2','MEC-0002','亚克力显示面板','结构物料','透明 / 2 mm / 激光切割','件',8.5,20,'A-02',None),('m3','ELE-0001','主控电路板组件','电子物料','STM32 / PCB Rev.A','块',86,5,'B-01','p4'),('m4','ELE-0002','温湿度传感器','电子物料','SHT30-DIS-B / I²C','个',12.8,30,'B-02',None),('m5','ELE-0003','USB-C 连接器','电子物料','16 Pin / 沉板 / 母座','个',1.25,50,'B-03',None),('m6','MEC-0003','不锈钢螺钉','结构物料','M2 × 6 / 十字盘头','个',0.12,100,'A-03',None),('m7','ELE-0004','微控制器','电子物料','STM32G030F6P6 / TSSOP20','个',5.6,20,'B-04',None),('m8','ELE-0005','贴片电阻','电子物料','10 kΩ / 0603 / ±1%','个',0.02,200,'B-05',None)]
    for p in parts:
        db.execute('INSERT INTO parts(id,code,name,category,spec,unit,price,min_stock,location,sub_product_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(*p[:9],None,now(),now()))
        level=2 if p[0] in ('m7','m8') else 1
        serial=next_material_serial(db)
        db.execute('UPDATE parts SET material_level=?,numbering_product_id=?,material_serial=?,code=? WHERE id=?',(level,'p1',serial,material_code(db,p[3],level,'p1',serial),p[0]))
        db.execute('INSERT INTO quotes VALUES(?,?,?,?,?)',(uid(),p[0],'s2' if p[3]=='结构物料' else 's1',p[6],'https://www.szlcsc.com' if p[3]=='电子物料' else ''))
    for product,lines in [('p1',[('m1',1),('m2',1),('m3',1),('m4',1),('m5',1),('m6',4),('m7',1),('m8',12)]),('p2',[('m1',1),('m4',1),('m5',1),('m6',4)]),('p3',[('m4',1),('m7',1)]),('p4',[('m7',1),('m8',12),('m5',1)])]:
        for part,qty in lines: db.execute('INSERT INTO bom_lines VALUES(?,?,?,?,?,?)',(uid(),'v'+product,part,qty,'',''))
    for part,qty in [('m1',24),('m2',36),('m3',8),('m4',18),('m5',120),('m6',350),('m7',45),('m8',1500)]: record_movement(db,{'type':'入库','part_id':part,'qty':qty,'reason':'示例期初入库'})
    db.execute('INSERT INTO purchases VALUES(?,?,?,?,?,?)',('po1','PO-DEMO-001','s1',datetime.now().strftime('%Y-%m-%d'),'示例采购单',now()))
    db.execute('INSERT INTO purchase_lines VALUES(?,?,?,?,?,?)',('pl1','po1','m4',50,12.8,0))
    db.execute('INSERT INTO purchase_lines VALUES(?,?,?,?,?,?)',('pl2','po1','m5',100,1.25,0))
    record_movement(db,{'type':'入库','part_id':'m4','qty':10,'purchase_line_id':'pl1','reason':'示例采购分批到货'})
    record_movement(db,{'type':'出库','part_id':'m4','qty':4,'product_id':'p1','reason':'示例样机研发领料'})
    link_material(db,'m3','m7',1);link_material(db,'m3','m8',12)

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--host',default=os.environ.get('PLM_HOST','127.0.0.1')); parser.add_argument('--port',type=int,default=int(os.environ.get('PLM_PORT','8787'))); args=parser.parse_args()
    init_db(); server=ThreadingHTTPServer((args.host,args.port),Handler)
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

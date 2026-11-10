"""Project-scoped shipment ledgers and Kickstarter order imports."""
import csv
import io
import json
import math
from datetime import date, datetime, timezone

from electronic_import import ElectronicBomError, normalized, read_csv, read_xlsx

VERSION = 14
CREATED_AT_VERSION = 15
RECORD_RELATIONS_VERSION = 16
SOURCES_VERSION = 17
LEGACY_TABLES = ('shipping_ks_orders', 'shipping_records', 'shipping_devices')
CARRIER_TABLES = (*LEGACY_TABLES, 'shipping_carriers')
TABLES = (*CARRIER_TABLES, 'shipping_sources')
SCHEMA = (
    """CREATE TABLE IF NOT EXISTS shipping_ks_orders (
        project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL,
        backer TEXT NOT NULL COLLATE NOCASE, details TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (project_id,id), UNIQUE (project_id,backer)
    )""",
    """CREATE TABLE IF NOT EXISTS shipping_records (
        project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('ks','other')), reference TEXT NOT NULL,
        ks_order_id TEXT, shipped_on TEXT NOT NULL, tracking TEXT NOT NULL,
        details TEXT NOT NULL, source_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        operator_id TEXT REFERENCES users(id),
        parent_id TEXT, deleted_at TEXT,
        PRIMARY KEY (project_id,id), UNIQUE (project_id,channel,source_id),
        CHECK(channel='ks' OR ks_order_id IS NULL),
        FOREIGN KEY (project_id,ks_order_id) REFERENCES shipping_ks_orders(project_id,id)
    )""",
    """CREATE TABLE IF NOT EXISTS shipping_devices (
        project_id TEXT NOT NULL, shipment_id TEXT NOT NULL, serial TEXT NOT NULL,
        PRIMARY KEY (project_id,shipment_id,serial),
        FOREIGN KEY (project_id,shipment_id) REFERENCES shipping_records(project_id,id) ON DELETE CASCADE
    )""",
    """CREATE TABLE IF NOT EXISTS shipping_carriers (
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (project_id,name)
    )""",
    """CREATE TABLE IF NOT EXISTS shipping_sources (
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (project_id,name)
    )""",
    'CREATE INDEX IF NOT EXISTS idx_shipping_channel ON shipping_records(project_id,channel,shipped_on DESC,created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_shipping_backer ON shipping_records(project_id,ks_order_id)',
    'CREATE INDEX IF NOT EXISTS idx_shipping_serial ON shipping_devices(project_id,serial)',
)
CONTACT = ('name', 'email', 'phone', 'country', 'region', 'city', 'postcode', 'address', 'address2')
ITEMS = ('main_unit', 'base', 'case', 'strip', 'patch')
COSTS = ('domestic_cost', 'international_cost', 'warehouse_cost', 'weight')
SHIPPING_FIELDS = (*COSTS, 'carrier', 'notes', 'shipment_status')
DETAIL_KEYS = (*CONTACT, *ITEMS, *SHIPPING_FIELDS, 'source')
ORDER_KEYS = (*CONTACT, *ITEMS, 'pb', 'sku', 'country_code', 'address_status', 'notes',
              'pledged', 'amount_due', 'paid', 'balance')
PAGE_SIZE = 50
SHIPMENT_SELECT = '''SELECT s.*,o.backer,o.details AS order_details,u.name AS operator,
    p.reference AS parent_reference,p.tracking AS parent_tracking,
    (SELECT count(*) FROM shipping_records c WHERE c.project_id=s.project_id
        AND c.parent_id=s.id AND c.deleted_at IS NULL) AS child_count
    FROM shipping_records s
    LEFT JOIN shipping_ks_orders o ON o.project_id=s.project_id AND o.id=s.ks_order_id
    LEFT JOIN shipping_records p ON p.project_id=s.project_id AND p.id=s.parent_id
    LEFT JOIN users u ON u.id=s.operator_id'''


def initialize(db, version):
    for statement in SCHEMA:
        db.execute(statement)
    if version == VERSION:
        db.execute("ALTER TABLE shipping_ks_orders ADD COLUMN created_at TEXT NOT NULL DEFAULT ''")
        fill_created_at(db)
    if VERSION <= version < RECORD_RELATIONS_VERSION:
        db.execute('ALTER TABLE shipping_records ADD COLUMN parent_id TEXT')
        db.execute('ALTER TABLE shipping_records ADD COLUMN deleted_at TEXT')
    if VERSION <= version < SOURCES_VERSION:
        repair_imported_times(db)
    db.execute('CREATE INDEX IF NOT EXISTS idx_shipping_orders_created ON shipping_ks_orders(project_id,created_at DESC)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_shipping_records_created ON shipping_records(project_id,channel,created_at DESC,id DESC)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_shipping_parent ON shipping_records(project_id,parent_id,deleted_at,created_at DESC,id DESC)')


def fill_created_at(db):
    db.execute("UPDATE shipping_ks_orders SET created_at=updated_at WHERE created_at=''")


def repair_imported_times(db):
    # Feishu record metadata used epoch seconds. The old importer treated them as milliseconds.
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)

    def correct(value):
        if value[:4] != '1970':
            return value
        try:
            original = epoch + (datetime.fromisoformat(value) - epoch) * 1000
        except (ValueError, TypeError, OverflowError):
            return value
        return original.isoformat() if 2000 <= original.year < 2100 else value

    for table in ('shipping_records', 'shipping_ks_orders'):
        imported = 'AND source_id IS NOT NULL' if table == 'shipping_records' else ''
        rows = db.execute(f"""SELECT project_id,id,created_at,updated_at FROM {table}
            WHERE (created_at LIKE '1970-%' OR updated_at LIKE '1970-%') {imported}""").fetchall()
        for project, record, created, updated in rows:
            corrected = correct(created), correct(updated)
            if corrected != (created, updated):
                db.execute(f'UPDATE {table} SET created_at=?,updated_at=? WHERE project_id=? AND id=?',
                           (*corrected, project, record))


def carrier_names(value):
    return [name.strip() for name in value.split('、') if name.strip()]


def list_carriers(db, project):
    names = {row[0].casefold(): row[0] for row in db.execute(
        'SELECT name FROM shipping_carriers WHERE project_id=?', (project,))}
    for row in db.execute('''SELECT DISTINCT json_extract(details,'$.carrier') FROM shipping_records
                             WHERE project_id=?''', (project,)):
        for name in carrier_names(row[0] or ''):
            names.setdefault(name.casefold(), name)
    return sorted(names.values(), key=str.casefold)


def list_sources(db, project):
    names = {row[0].casefold(): row[0] for row in db.execute(
        'SELECT name FROM shipping_sources WHERE project_id=?', (project,))}
    for name, in db.execute("""SELECT DISTINCT json_extract(details,'$.source') FROM shipping_records
                              WHERE project_id=? AND channel='other'""", (project,)):
        if name:
            names.setdefault(name.casefold(), name)
    return sorted(names.values(), key=str.casefold)


class ShippingError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def string(value, length=1000):
    if isinstance(value, (dict, list, bool)):
        raise ShippingError('字段格式无效')
    result = '' if value is None else str(value).strip()
    if len(result) > length:
        raise ShippingError('字段内容过长')
    return result


def clean_details(values, keys):
    if not isinstance(values, dict):
        raise ShippingError('资料格式无效')
    details = {}
    for key in keys:
        value = string(values.get(key), 3000 if key == 'notes' else 1000)
        if not value:
            continue
        if key in (*ITEMS, *COSTS):
            try:
                number = float(value)
            except ValueError:
                raise ShippingError('数量、费用和重量必须是数字') from None
            if not math.isfinite(number) or not 0 <= number <= 1e9 or (key in ITEMS and not number.is_integer()):
                raise ShippingError('数量、费用或重量无效')
            details[key] = int(number) if key in ITEMS else number
        else:
            details[key] = value
    return details


def json_data(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def shipment_date(value):
    value = string(value, 20)
    if not value:
        return ''
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise ShippingError('发货日期无效') from None


def decode_order(row):
    return {**dict(row), 'details': json.loads(row['details'])} if row else None


def lookup_order(db, project, backer):
    return decode_order(db.execute('SELECT * FROM shipping_ks_orders WHERE project_id=? AND backer=?',
                                   (project, backer)).fetchone())


def save_order(db, project, order_id, backer, details, stamp, *, created_at=None):
    if not backer:
        raise ShippingError('请填写 Backer 编号')
    db.execute('''INSERT INTO shipping_ks_orders(project_id,id,backer,details,updated_at,created_at) VALUES(?,?,?,?,?,?)
                  ON CONFLICT(project_id,backer) DO UPDATE SET details=excluded.details,updated_at=excluded.updated_at
                  WHERE details<>excluded.details''', (project, order_id, backer, json_data(details), stamp, created_at or stamp))


def shipment_devices(db, project, shipment_ids):
    devices = {}
    if not shipment_ids:
        return devices
    marks = ','.join('?' for _ in shipment_ids)
    for row in db.execute(f'''SELECT sd.shipment_id,sd.serial,d.serial IS NOT NULL AS registered,
        (SELECT r.result FROM inspection_records r
         WHERE r.project_id=sd.project_id AND r.serial=sd.serial AND r.deleted_at IS NULL
         ORDER BY r.updated_at DESC,r.id DESC LIMIT 1) AS result
        FROM shipping_devices sd LEFT JOIN inspection_devices d
          ON d.project_id=sd.project_id AND d.serial=sd.serial
        WHERE sd.project_id=? AND sd.shipment_id IN ({marks}) ORDER BY sd.rowid''', (project, *shipment_ids)):
        devices.setdefault(row['shipment_id'], []).append({
            'serial': row['serial'], 'registered': bool(row['registered']), 'result': row['result'],
        })
    return devices


def list_shipments(db, project, channel, query):
    if channel not in ('ks', 'other'):
        raise ShippingError('发货渠道无效')
    where = ['s.project_id=?', 's.channel=?', 's.deleted_at IS NOT NULL' if query.get('deleted') == '1'
             else 's.deleted_at IS NULL']
    if query.get('roots') == '1':
        where.append('s.parent_id IS NULL')
    params = [project, channel]
    backer = string(query.get('backer'), 80)
    if backer:
        where.append('o.backer=?')
        params.append(backer)
    term = string(query.get('q'), 150).lower()
    if term:
        where.append("""(instr(lower(s.reference||' '||s.tracking||' '||s.details||' '||
            coalesce(o.backer,'')||' '||coalesce(o.details,'')),?)>0 OR EXISTS
            (SELECT 1 FROM shipping_devices d WHERE d.project_id=s.project_id AND d.shipment_id=s.id
             AND instr(lower(d.serial),?)>0))""")
        params.extend([term, term])
    status = query.get('status')
    if status in ('shipped', 'pending'):
        where.append(shipped_condition('s') if status == 'shipped' else 'NOT (' + shipped_condition('s') + ')')
    predicate = ' AND '.join(where)
    join = 'FROM shipping_records s LEFT JOIN shipping_ks_orders o ON o.project_id=s.project_id AND o.id=s.ks_order_id'
    total = db.execute(f'SELECT count(*) {join} WHERE {predicate}', params).fetchone()[0]
    page = page_number(query)
    rows = db.execute(f'''{SHIPMENT_SELECT} WHERE {predicate}
        ORDER BY s.created_at DESC,s.id DESC LIMIT ? OFFSET ?''',
        (*params, PAGE_SIZE, (page - 1) * PAGE_SIZE)).fetchall()
    devices = shipment_devices(db, project, [row['id'] for row in rows])
    return {'rows': [decode_shipment(row, devices.get(row['id'], [])) for row in rows],
            'total': total, 'page': page, 'page_size': PAGE_SIZE}


def decode_shipment(row, devices):
    return {**dict(row), 'details': json.loads(row['details']),
            'order_details': json.loads(row['order_details'] or '{}'), 'devices': devices}


def get_shipment(db, project, shipment_id):
    row = db.execute(SHIPMENT_SELECT + ' WHERE s.project_id=? AND s.id=?', (project, shipment_id)).fetchone()
    if not row:
        raise ShippingError('发货记录不存在', 404)
    return decode_shipment(row, shipment_devices(db, project, [shipment_id]).get(shipment_id, []))


def list_children(db, project, shipment_id):
    parent = db.execute('SELECT deleted_at FROM shipping_records WHERE project_id=? AND id=?',
                        (project, shipment_id)).fetchone()
    if not parent:
        raise ShippingError('发货记录不存在', 404)
    rows = db.execute(SHIPMENT_SELECT + ''' WHERE s.project_id=? AND s.parent_id=?
        AND s.deleted_at IS NULL ORDER BY s.created_at DESC,s.id DESC''', (project, shipment_id)).fetchall()
    devices = shipment_devices(db, project, [row['id'] for row in rows])
    return [decode_shipment(row, devices.get(row['id'], [])) for row in rows]


def validate_parent(db, project, shipment_id, channel, parent_id):
    if not parent_id:
        return None
    parent = db.execute('''SELECT * FROM shipping_records WHERE project_id=? AND id=?
        AND channel=? AND deleted_at IS NULL''', (project, parent_id, channel)).fetchone()
    if not parent:
        raise ShippingError('当前台账中找不到该父记录，或父记录已删除', 404)
    if db.execute('''WITH RECURSIVE ancestors(id) AS (
        SELECT ? UNION SELECT r.parent_id FROM shipping_records r JOIN ancestors a ON r.id=a.id
        WHERE r.project_id=? AND r.parent_id IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE id=?''', (parent_id, project, shipment_id)).fetchone():
        raise ShippingError('不能将该记录设为自己的父记录，也不能关联到下级记录')
    return parent


def valid_parent_links(db):
    if db.execute('''SELECT 1 FROM shipping_records c LEFT JOIN shipping_records p
        ON p.project_id=c.project_id AND p.id=c.parent_id AND p.channel=c.channel
        WHERE c.parent_id IS NOT NULL AND (p.id IS NULL OR (c.deleted_at IS NULL AND p.deleted_at IS NOT NULL))
        LIMIT 1''').fetchone():
        return False
    parents = {(project, child): (project, parent) for project, child, parent in db.execute(
        'SELECT project_id,id,parent_id FROM shipping_records WHERE parent_id IS NOT NULL')}
    checked = set()
    for record in parents:
        chain = set()
        while record in parents and record not in checked:
            if record in chain:
                return False
            chain.add(record)
            record = parents[record]
        checked.update(chain)
    return True


def set_shipment_deleted(db, project, shipment_id, version, stamp, deleted):
    row = get_shipment(db, project, shipment_id)
    if version != row['updated_at'] or bool(row['deleted_at']) == deleted:
        raise ShippingError('发货记录已更新，请刷新后重试', 409)
    if deleted and row['child_count']:
        raise ShippingError('该记录还有子记录，请先删除子记录或解除关联', 409)
    if not deleted and row['parent_id']:
        validate_parent(db, project, shipment_id, row['channel'], row['parent_id'])
    db.execute('UPDATE shipping_records SET deleted_at=?,updated_at=? WHERE project_id=? AND id=?',
               (stamp if deleted else None, stamp, project, shipment_id))
    return row


def shipped_condition(alias):
    return f"""(CASE json_extract({alias}.details,'$.shipment_status')
        WHEN 'shipped' THEN 1 WHEN 'pending' THEN 0
        ELSE {alias}.shipped_on<>'' OR {alias}.tracking<>'' END)"""


def page_number(query):
    try:
        return max(1, min(int(query.get('page', 1)), 100000))
    except (TypeError, ValueError):
        raise ShippingError('页码无效') from None


def list_orders(db, project, query):
    page = page_number(query)
    term = string(query.get('q'), 150).lower().lstrip('#')
    where = "o.project_id=? AND instr(lower(o.backer||' '||o.details),?)>0"
    args = [project, term]
    status = query.get('status')
    if status in ('shipped', 'pending'):
        shipped = ('EXISTS (SELECT 1 FROM shipping_records s WHERE s.project_id=o.project_id '
                   'AND s.ks_order_id=o.id AND s.deleted_at IS NULL AND ' + shipped_condition('s') + ')')
        where += ' AND ' + (shipped if status == 'shipped' else 'NOT ' + shipped)
    total = db.execute(f'SELECT count(*) FROM shipping_ks_orders o WHERE {where}', args).fetchone()[0]
    rows = db.execute(f'''SELECT o.*, count(s.id) AS shipments,
        count(CASE WHEN {shipped_condition('s')} THEN 1 END) AS shipped
        FROM shipping_ks_orders o LEFT JOIN shipping_records s ON s.project_id=o.project_id AND s.ks_order_id=o.id
          AND s.deleted_at IS NULL
        WHERE {where} GROUP BY o.id
        ORDER BY (?='1' AND o.backer=? COLLATE NOCASE) DESC, o.created_at DESC,o.rowid
        LIMIT ? OFFSET ?''', (*args, query.get('lookup'), term, PAGE_SIZE, (page - 1) * PAGE_SIZE))
    return {'rows': [decode_order(row) for row in rows], 'total': total, 'page': page, 'page_size': PAGE_SIZE}


def get_order(db, project, order_id):
    row = db.execute(f'''SELECT o.*, count(s.id) AS shipments,
        count(CASE WHEN {shipped_condition('s')} THEN 1 END) AS shipped
        FROM shipping_ks_orders o LEFT JOIN shipping_records s ON s.project_id=o.project_id AND s.ks_order_id=o.id
          AND s.deleted_at IS NULL
        WHERE o.project_id=? AND o.id=? GROUP BY o.id''', (project, order_id)).fetchone()
    if not row:
        raise ShippingError('KS 订单不存在', 404)
    links = db.execute('''SELECT id,reference,channel,shipped_on,tracking FROM shipping_records
        WHERE project_id=? AND ks_order_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC''',
        (project, order_id))
    return {**decode_order(row), 'shipment_links': [{**dict(link), 'backer': row['backer']} for link in links]}


def find_devices(db, project, query):
    term = string(query.get('q'), 100).lower()
    if not term:
        return []
    return [dict(row) for row in db.execute('''SELECT d.serial,d.prefix,
        (SELECT r.result FROM inspection_records r WHERE r.project_id=d.project_id AND r.serial=d.serial
         AND r.deleted_at IS NULL ORDER BY r.updated_at DESC,r.id DESC LIMIT 1) AS result,
        (SELECT group_concat(s.reference,'、') FROM shipping_devices sd JOIN shipping_records s
          ON s.project_id=sd.project_id AND s.id=sd.shipment_id
          WHERE sd.project_id=d.project_id AND sd.serial=d.serial AND s.deleted_at IS NULL) AS shipments
        FROM inspection_devices d WHERE d.project_id=? AND instr(lower(d.serial),?)>0
        ORDER BY (lower(d.serial)=?) DESC,d.serial LIMIT 20''', (project, term, term))]


def for_device(db, project, serial):
    return [dict(row) for row in db.execute('''SELECT s.id,s.reference,s.channel,s.shipped_on,s.tracking,o.backer
        FROM shipping_devices d JOIN shipping_records s ON s.project_id=d.project_id AND s.id=d.shipment_id
        LEFT JOIN shipping_ks_orders o ON o.project_id=s.project_id AND o.id=s.ks_order_id
        WHERE d.project_id=? AND d.serial=? AND s.deleted_at IS NULL
        ORDER BY s.created_at DESC,s.id DESC''', (project, serial))]


def save_shipment(db, project, shipment_id, data, stamp, actor, *, source_id=None, imported=False):
    old = db.execute('SELECT * FROM shipping_records WHERE project_id=? AND id=?',
                     (project, shipment_id)).fetchone()
    if data.get('version') is not None and (not old or data['version'] != old['updated_at']):
        raise ShippingError('发货记录已更新，请刷新后重试', 409)
    if old and data.get('version') != old['updated_at']:
        raise ShippingError('发货记录已存在，请刷新后重试', 409)
    if old and old['deleted_at']:
        raise ShippingError('请先恢复发货记录再编辑', 409)
    channel = data.get('channel')
    if channel not in ('ks', 'other') or (old and channel != old['channel']):
        raise ShippingError('发货渠道无效')
    parent_id = string(data.get('parent_id', old['parent_id'] if old else None), 100) or None
    parent = validate_parent(db, project, shipment_id, channel, parent_id)
    order = string(data.get('ks_order_id'), 100) or None
    if order and (channel != 'ks' or not db.execute(
        'SELECT 1 FROM shipping_ks_orders WHERE project_id=? AND id=?', (project, order),
    ).fetchone()):
        raise ShippingError('KS 订单不存在', 404)
    if old and old['ks_order_id'] and order != old['ks_order_id']:
        raise ShippingError('已关联的 KS 订单不能在发货台账中更改', 409)
    if channel == 'ks' and not order and not (imported or (old and not old['ks_order_id'])
                                              or (parent and not parent['ks_order_id'])):
        raise ShippingError('请选择 KS 订单')
    reference = string(data.get('reference'), 150) if channel == 'other' or imported else ''
    if not reference:
        if channel == 'other':
            if not imported and not (old and old['source_id']):
                raise ShippingError('请填写订单号')
        else:
            reference = old['reference'] if old else 'KS-' + stamp[:10].replace('-', '') + '-' + shipment_id[:8].upper()
    ks_ledger = channel == 'ks' and not imported
    details = clean_details(data.get('details', {}), SHIPPING_FIELDS if ks_ledger else DETAIL_KEYS)
    if details.get('shipment_status', '') not in ('', 'shipped', 'pending'):
        raise ShippingError('发货状态无效')
    if ks_ledger and old:
        details.update({key: value for key, value in json.loads(old['details']).items()
                        if key not in SHIPPING_FIELDS})
    if channel == 'other' and details.get('source'):
        db.execute('INSERT OR IGNORE INTO shipping_sources(project_id,name) VALUES(?,?)',
                   (project, details['source']))
    carriers = carrier_names(details.get('carrier', ''))
    db.executemany('INSERT OR IGNORE INTO shipping_carriers(project_id,name) VALUES(?,?)',
                   ((project, name) for name in carriers))
    tracking = string(data.get('tracking'), 500)
    shipped_on = shipment_date(data.get('shipped_on'))
    raw_serials = data.get('devices', [])
    if not isinstance(raw_serials, list) or len(raw_serials) > 500:
        raise ShippingError('每笔发货最多关联 500 台设备')
    serials = list(dict.fromkeys(string(serial, 100) for serial in raw_serials))
    previous = {row['serial'] for row in shipment_devices(db, project, [shipment_id]).get(shipment_id, [])}
    for serial in serials:
        if not serial:
            raise ShippingError('设备编号不能为空')
        if not (imported or serial in previous) and not db.execute(
            'SELECT 1 FROM inspection_devices WHERE project_id=? AND serial=?', (project, serial),
        ).fetchone():
            raise ShippingError(f'设备 {serial} 尚未在当前项目登记', 404)
    if old:
        db.execute('''UPDATE shipping_records SET reference=?,ks_order_id=?,shipped_on=?,tracking=?,details=?,
                      updated_at=?,operator_id=?,parent_id=? WHERE project_id=? AND id=?''',
                   (reference, order, shipped_on, tracking, json_data(details), stamp, actor, parent_id, project, shipment_id))
    else:
        db.execute('''INSERT INTO shipping_records
                      (project_id,id,channel,reference,ks_order_id,shipped_on,tracking,details,source_id,
                       created_at,updated_at,operator_id,parent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                   (project, shipment_id, channel, reference, order, shipped_on, tracking,
                    json_data(details), source_id, stamp, stamp, actor, parent_id))
    db.executemany('DELETE FROM shipping_devices WHERE project_id=? AND shipment_id=? AND serial=?',
                   ((project, shipment_id, serial) for serial in previous - set(serials)))
    db.executemany('INSERT INTO shipping_devices VALUES(?,?,?)',
                   ((project, shipment_id, serial) for serial in serials if serial not in previous))
    return {'id': shipment_id, 'reference': reference}


HEADERS = {
    'backer': ('Backer Number', 'Backer #', 'Backer #Number', 'Backer ID', 'Backer 编号', '支持者编号', '众筹编号'),
    'name': ('Name', 'Full Name', 'Backer Name', 'Shipping Name', 'Shipping Address Name', 'Recipient', 'Shipping Recipient', '姓名', '全名', '收件人'),
    'email': ('Email', 'Backer Email', 'E-mail', '邮箱'),
    'phone': ('Phone', 'Phone Number', 'Shipping Phone Number', '电话号码', '电话'),
    'country': ('Country', 'Shipping Country', 'Shipping Country Name', '国家', '国家 / 地区'),
    'country_code': ('Country Code', 'Shipping Country Code', '简写'),
    'region': ('State', 'State/Province', 'Shipping State', 'Shipping State/Province', 'Province', '州', '省', '州 / 省'),
    'city': ('City', 'Shipping City', '城市'),
    'postcode': ('Postal Code', 'Zip Code', 'ZIP', 'Shipping Postal Code', 'Shipping Zip', '邮编'),
    'address': ('Address', 'Address 1', 'Address Line 1', 'Shipping Address 1', 'Shipping Address Line 1', 'Shipping Address', '地址1', '地址'),
    'address2': ('Address 2', 'Address Line 2', 'Shipping Address 2', 'Shipping Address Line 2', '地址2', '地址补充'),
    'pb': ('PB编号', 'PB', 'PledgeBox ID'),
    'sku': ('SKU', 'Reward', 'Reward Title', '购买SKU'),
    'address_status': ('地址确认', '是否确认地址', 'Address Confirmed'),
    'main_unit': ('L7', 'L7主机', '主机'), 'base': ('L7底座', '底座'), 'case': ('收纳包',),
    'strip': ('反光贴（条）', '反光贴-条', '条形反光贴'), 'patch': ('反光贴（块）', '反光贴-块', '块状反光贴'),
    'notes': ('备注', 'Notes'), 'pledged': ('KS承诺金额', 'Pledge Amount'),
    'amount_due': ('KS应付金额',), 'paid': ('已支付金额',), 'balance': ('欠款',),
}
ALIASES = {normalized(label): key for key, labels in HEADERS.items() for label in labels}


def parse_orders(blob, filename):
    try:
        if filename.lower().endswith('.csv'):
            rows = read_csv(blob)
        elif filename.lower().endswith('.xlsx'):
            _, _, rows = read_xlsx(blob)
        else:
            raise ShippingError('请选择 CSV 或 XLSX 文件')
    except (ElectronicBomError, ValueError, OSError, RuntimeError, KeyError) as exc:
        raise ShippingError('无法读取订单表，' + str(exc)) from None
    for index, (_, header) in enumerate(rows[:12]):
        columns = [ALIASES.get(normalized(value)) for value in header]
        if 'backer' in columns:
            break
    else:
        raise ShippingError('缺少 Backer Number 列')
    if len(set(columns) - {None, 'backer'}) == 0:
        raise ShippingError('未找到收件资料或订单字段')
    return order_entries(rows[index + 1:], columns)


def order_entries(rows, columns):
    entries, invalid, duplicate = {}, [], 0
    for line, row in rows:
        if not any(value not in (None, '') for value in row):
            continue
        try:
            cells = {}
            for key, value in zip(columns, row):
                if key and string(value, 3000):
                    cells.setdefault(key, value)
            backer = string(cells.get('backer'), 80).lstrip('#').strip()
            if not backer or backer.startswith('#未缓存'):
                raise ShippingError('Backer 编号为空或无效')
            details = clean_details(cells, ORDER_KEYS)
            key = backer.casefold()
            if key in entries:
                duplicate += 1
                if details != entries[key][1]:
                    invalid.append({'row': line, 'error': '同一个 Backer 编号的资料不一致'})
                continue
            entries[key] = (backer, details)
        except ShippingError as exc:
            invalid.append({'row': line, 'error': str(exc)})
    return list(entries.values()), invalid, duplicate


def edit_order(db, project, order_id, version, values, stamp):
    row = db.execute('SELECT * FROM shipping_ks_orders WHERE project_id=? AND id=?', (project, order_id)).fetchone()
    if not row:
        raise ShippingError('KS 订单不存在', 404)
    if version != row['updated_at']:
        raise ShippingError('KS 订单已更新，请刷新后重试', 409)
    details = json.loads(row['details'])
    changes = clean_details(values, ORDER_KEYS)
    for key in values.keys() & set(ORDER_KEYS):
        details.pop(key, None)
    details.update(changes)
    save_order(db, project, order_id, row['backer'], details, stamp)
    return get_order(db, project, order_id)


def paste_orders(db, project, payload, stamp, new_id):
    clipboard = payload.get('clipboard')
    if not isinstance(clipboard, str) or len(clipboard) > 2_000_000:
        raise ShippingError('粘贴内容格式无效或过大')
    try:
        cells = list(csv.reader(io.StringIO(clipboard.lstrip('\ufeff'), newline=''), delimiter='\t', strict=True))
    except csv.Error as exc:
        raise ShippingError('无法读取剪贴板表格') from exc
    if not cells or len(cells) > 1001:
        raise ShippingError('每次最多粘贴 1,000 条记录')
    headings = [ALIASES.get(normalized(cell)) for cell in cells[0]]
    if 'backer' in headings and len(set(headings) - {None, 'backer'}) > 0:
        entries, invalid, duplicate = order_entries(enumerate(cells[1:], 2), headings)
        targets = []
    else:
        columns = payload.get('columns')
        targets = payload.get('targets', [])
        if (not isinstance(columns, list) or not columns or not isinstance(targets, list)
                or any(not isinstance(key, str) or key not in ('backer', *ORDER_KEYS) for key in columns)
                or len(set(columns)) != len(columns)):
            raise ShippingError('请选中可填写的起始单元格')
        if max(map(len, cells)) > len(columns):
            raise ShippingError('粘贴范围超过可见字段，请显示更多字段或粘贴带表头的数据')
        if targets:
            if len(cells) > len(targets):
                raise ShippingError('粘贴范围超过已加载的行，请向下滚动后再试')
            updated = 0
            for position, (values, target) in enumerate(zip(cells, targets), 1):
                if not isinstance(target, dict):
                    raise ShippingError('请选择起始记录')
                order_id = string(target.get('id'), 24)
                changes = {key: value for key, value in zip(columns, values) if value.strip()}
                backer = changes.pop('backer', '').strip().lstrip('#')
                if backer and backer != target.get('backer'):
                    raise ShippingError(f'第 {position} 行的 Backer 编号与选中记录不符')
                if changes:
                    current = edit_order(db, project, order_id, target.get('version'), changes, stamp)
                    updated += current['updated_at'] == stamp
            return {'added': 0, 'updated': updated, 'unchanged': len(cells) - updated, 'duplicate': 0}
        if columns[0] != 'backer':
            raise ShippingError('粘贴新记录请从 Backer 编号开始，或复制带表头的数据')
        entries, invalid, duplicate = order_entries(enumerate(cells, 1), columns)
    if invalid:
        row = invalid[0]
        raise ShippingError(f"粘贴第 {row['row']} 行：{row['error']}")
    if not entries:
        raise ShippingError('没有可粘贴的记录')
    added = 0
    for backer, details in entries:
        if not lookup_order(db, project, backer):
            save_order(db, project, new_id(), backer, details, stamp)
            added += 1
    return {'added': added, 'updated': 0, 'unchanged': len(entries) - added, 'duplicate': duplicate}


def apply_orders(db, project, entries, invalid, duplicate, stamp, new_id, *, commit=False):
    added = updated = unchanged = 0
    for backer, data in entries:
        old = lookup_order(db, project, backer)
        details = {**(old['details'] if old else {}), **data}
        if old and details == old['details']:
            unchanged += 1
            continue
        added += not old
        updated += bool(old)
        if commit:
            save_order(db, project, new_id(), backer, details, stamp)
    return {'added': added, 'updated': updated, 'unchanged': unchanged,
            'duplicate': duplicate, 'invalid': len(invalid), 'errors': invalid[:20]}

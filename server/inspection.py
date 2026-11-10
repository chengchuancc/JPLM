"""Project-scoped production inspection forms and records."""
import csv
import io
import json
import math
import re
import zipfile
from datetime import datetime
from xml.sax.saxutils import escape

from electronic_import import ElectronicBomError, normalized, read_csv, read_xlsx

INITIAL_TABLES = ('inspection_templates', 'inspection_records')
TABLES = ('inspection_templates', 'inspection_devices', 'inspection_records', 'inspection_options')
RESULTS = ('合格', '不良', '未完成', '待检测')
LIMIT = 5000
SCHEMA = (
    """CREATE TABLE IF NOT EXISTS inspection_templates (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
        config TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project_id,id), UNIQUE(project_id,name)
    )""",
    """CREATE TABLE IF NOT EXISTS inspection_records (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, template_id TEXT NOT NULL,
        serial TEXT NOT NULL, prefix TEXT NOT NULL, production_date TEXT NOT NULL,
        result TEXT NOT NULL CHECK(result IN ('合格','不良','未完成','待检测')),
        values_json TEXT NOT NULL, template_snapshot TEXT NOT NULL,
        operator_id TEXT REFERENCES users(id), operator_name TEXT NOT NULL,
        source_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE(project_id,template_id,serial),
        FOREIGN KEY(project_id,template_id) REFERENCES inspection_templates(project_id,id)
    )""",
    """CREATE INDEX IF NOT EXISTS idx_inspection_recent
       ON inspection_records(project_id,template_id,updated_at DESC,id DESC)""",
    """CREATE INDEX IF NOT EXISTS idx_inspection_prefix
       ON inspection_records(project_id,template_id,prefix,updated_at DESC)""",
    """CREATE TABLE IF NOT EXISTS inspection_devices (
        project_id TEXT NOT NULL REFERENCES projects(id),
        serial TEXT NOT NULL, prefix TEXT NOT NULL, production_date TEXT NOT NULL,
        registered_at TEXT NOT NULL, operator_id TEXT REFERENCES users(id), operator_name TEXT NOT NULL,
        PRIMARY KEY(project_id,serial)
    )""",
    """CREATE INDEX IF NOT EXISTS idx_inspection_devices_recent
       ON inspection_devices(project_id,registered_at DESC,serial)""",
    """CREATE INDEX IF NOT EXISTS idx_inspection_device_records
       ON inspection_records(project_id,serial,updated_at DESC)""",
    """CREATE TABLE IF NOT EXISTS inspection_options (
        project_id TEXT NOT NULL, template_id TEXT NOT NULL, field_key TEXT NOT NULL,
        value TEXT NOT NULL, created_at TEXT NOT NULL, hidden_at TEXT,
        PRIMARY KEY(project_id,template_id,field_key,value),
        FOREIGN KEY(project_id,template_id) REFERENCES inspection_templates(project_id,id)
    )""",
)


class InspectionError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def item(key, label, group, kind, *, required=False, options=(), fail=(), unit='',
         minimum=None, maximum=None, custom=False, display='buttons', block='', auto_from=''):
    return dict(key=key, label=label, group=group, type=kind, required=required,
                options=list(options), fail=list(fail), unit=unit, minimum=minimum,
                maximum=maximum, custom=custom, display=display, block=block, auto_from=auto_from)


BASE_HEADERS = {
    'serial': ('S/N', 'SN', '机器编号', '完整机器编号', '序列号', 'serial', 'machine_code'),
    'result': ('检测结果', 'result'),
    'created_at': ('创建时间', 'created_at'),
    'updated_at': ('更新时间', 'updated_at'),
    'operator_name': ('检测人', '检测员', 'operator_name'),
    'source_id': ('原记录 ID', 'ID', 'source_id'),
}
L7_HEADERS = {
    'interaction_test': ('交互检测', '功能与反馈'),
    'far_distance_legacy': ('远距离测量检测', '远距离检测'),
    'space_value_1': ('数据1',), 'space_value_2': ('数据2',), 'space_value_3': ('数据3',),
    'quality_grade': ('等级',), 'other_note': ('其他', '备注'),
}
BASE_ALIASES = {normalized(label): key for key, labels in BASE_HEADERS.items() for label in labels}
RESERVED_HEADERS = set(BASE_ALIASES) | {normalized(x) for x in ('前6位', 'L7编号', '生产日期', '尾号')}


def text(value, limit=500):
    if value is None:
        return ''
    if isinstance(value, (dict, list, bool)):
        raise InspectionError('文本格式错误')
    value = str(value).strip()
    if len(value) > limit or any(ord(c) < 32 and c not in '\n\t\r' for c in value):
        raise InspectionError('文本过长或包含控制字符')
    return value


def number(value):
    if isinstance(value, bool):
        raise InspectionError('请输入有效数字')
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise InspectionError('请输入有效数字') from None
    if not math.isfinite(value) or abs(value) > 1e15:
        raise InspectionError('数字超出有效范围')
    return value


def limit(value):
    return None if value in (None, '') else number(value)


def clean_config(data):
    if not isinstance(data, dict):
        raise InspectionError('检测表格式错误')
    name = text(data.get('name'), 80)
    mode = data.get('serial_mode')
    fields = data.get('fields')
    if not name or mode not in ('dated', 'text') or not isinstance(fields, list) or not 1 <= len(fields) <= 60:
        raise InspectionError('请填写检测表名称、编号规则和 1 至 60 个检测项')
    result, keys, labels = [], set(), set()
    for index, field in enumerate(fields, 1):
        if not isinstance(field, dict):
            raise InspectionError(f'第 {index} 个检测项格式错误')
        key = text(field.get('key'), 40)
        label = text(field.get('label'), 80)
        group = text(field.get('group'), 60) or '检测项'
        kind = field.get('type')
        label_key = normalized(label)
        if not re.fullmatch(r'[a-z][a-z0-9_]{0,39}', key) or key in keys or normalized(key) in RESERVED_HEADERS:
            raise InspectionError(f'第 {index} 个检测项标识重复或无效')
        if not label_key or label_key in labels or label_key in RESERVED_HEADERS:
            raise InspectionError(f'第 {index} 个检测项名称重复、保留或为空')
        if kind not in ('choice', 'multi', 'number', 'text'):
            raise InspectionError(f'第 {index} 个检测项类型无效')
        display = field.get('display', 'buttons')
        if display not in ('buttons', 'dropdown'):
            raise InspectionError(f'「{label}」选择样式无效')
        block = text(field.get('block'), 60)
        auto_from = text(field.get('auto_from'), 40)
        options, fail = [], []
        custom = kind == 'multi' and field.get('custom') is True
        if kind in ('choice', 'multi'):
            raw_options, raw_fail = field.get('options', []), field.get('fail', [])
            if not isinstance(raw_options, list) or len(raw_options) > 150 or not isinstance(raw_fail, list):
                raise InspectionError(f'「{label}」选项格式无效')
            options = list(dict.fromkeys(text(option, 250) for option in raw_options if option))
            fail = list(dict.fromkeys(text(option, 250) for option in raw_fail if option))
            if (not options and not custom) or not set(fail) <= set(options):
                raise InspectionError(f'「{label}」需要选项，且不良选项必须在选项列表中')
        minimum = limit(field.get('minimum')) if kind == 'number' else None
        maximum = limit(field.get('maximum')) if kind == 'number' else None
        if minimum is not None and maximum is not None and minimum > maximum:
            raise InspectionError(f'「{label}」下限不能大于上限')
        result.append(item(key, label, group, kind, required=field.get('required') is True,
                           options=options, fail=fail, unit=text(field.get('unit'), 24) if kind == 'number' else '',
                           minimum=minimum, maximum=maximum, custom=custom,
                           display=display if kind in ('choice', 'multi') else 'buttons', block=block,
                           auto_from=auto_from))
        keys.add(key)
        labels.add(label_key)
    by_key = {field['key']: field for field in result}
    automatic_sources = set()
    for field in result:
        source_key = field['auto_from']
        if not source_key:
            continue
        source = by_key.get(source_key)
        if (field['type'] != 'choice' or set(field['options']) != {'OK', 'NG'} or field['fail'] != ['NG']
                or not source or source['type'] != 'number'
                or (source['minimum'] is None and source['maximum'] is None)
                or (field['group'], field['block']) != (source['group'], source['block'])
                or source_key in automatic_sources):
            raise InspectionError(f'「{field["label"]}」自动判定需要同一组合内有合格范围的数值项')
        automatic_sources.add(source_key)
    return dict(name=name, serial_mode=mode, fields=result)


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def decode_template(row):
    if not row:
        raise InspectionError('检测表不存在', 404)
    return {**json.loads(row['config']), 'id': row['id'], 'revision': row['revision']}


def template(db, project_id, template_id):
    return decode_template(db.execute('SELECT * FROM inspection_templates WHERE project_id=? AND id=?',
                                      (project_id, template_id)).fetchone())


def templates(db, project_id):
    return [decode_template(row) for row in db.execute(
        'SELECT * FROM inspection_templates WHERE project_id=? ORDER BY rowid', (project_id,))]


def save_template(db, project_id, template_id, data, stamp, existing=None):
    config = clean_config(data)
    if db.execute('SELECT 1 FROM inspection_templates WHERE project_id=? AND name=? AND id<>?',
                  (project_id, config['name'], template_id)).fetchone():
        raise InspectionError('已有同名检测表', 409)
    if existing:
        if data.get('revision') != existing['revision']:
            raise InspectionError('检测表已更新，请刷新后再保存', 409)
        if config['serial_mode'] != existing['serial_mode'] and db.execute(
            'SELECT 1 FROM inspection_records WHERE project_id=? AND template_id=? LIMIT 1',
            (project_id, template_id),
        ).fetchone():
            raise InspectionError('已有检测记录的表不能更改编号规则，请新建检测表', 409)
        revision = existing['revision'] + 1
        db.execute('UPDATE inspection_templates SET name=?,revision=?,config=?,updated_at=? WHERE project_id=? AND id=?',
                   (config['name'], revision, dumps(config), stamp, project_id, template_id))
    else:
        revision = 1
        db.execute('INSERT INTO inspection_templates VALUES(?,?,?,?,?,?)',
                   (template_id, project_id, config['name'], revision, dumps(config), stamp))
    return {**config, 'id': template_id, 'revision': revision}


def parse_serial(value, mode):
    serial = text(value, 100)
    if mode == 'dated':
        if not re.fullmatch(r'[0-9]{16}', serial):
            raise InspectionError('S/N 必须是 16 位数字，请将 Excel 的 S/N 列设置为文本')
        try:
            produced = datetime.strptime(serial[6:12], '%y%m%d').date().isoformat()
        except ValueError:
            raise InspectionError('S/N 中的生产日期无效') from None
        return serial, serial[:6], produced
    if not serial or any(c in serial for c in '\r\n\t'):
        raise InspectionError('请输入有效的 S/N')
    return serial, serial[:6], ''


def clean_values(config, values, previous=None, historical=False):
    if not isinstance(values, dict):
        raise InspectionError('检测数据格式错误')
    previous = previous or {}
    known = {field['key'] for field in config['fields']}
    if values.keys() - known:
        raise InspectionError('检测项已变更，请重新打开检测表', 409)
    result = {}
    for field in config['fields']:
        key, kind = field['key'], field['type']
        if field.get('auto_from'):
            continue
        value = values.get(key)
        if value in (None, '', []):
            continue
        try:
            if kind == 'number':
                result[key] = number(value)
            elif kind == 'multi':
                if not isinstance(value, list) or len(value) > 100:
                    raise InspectionError('请选择有效选项')
                selected = list(dict.fromkeys(text(entry, 250) for entry in value if entry))
                known_options = set(field['options']) | set(previous.get(key, []))
                if not (field['custom'] or historical) and not set(selected) <= known_options:
                    raise InspectionError('请选择有效选项')
                if selected:
                    result[key] = selected
            else:
                entered = text(value, 2000 if kind == 'text' else 250)
                if kind == 'choice' and not historical and entered not in field['options'] and entered != previous.get(key):
                    raise InspectionError('请选择有效选项')
                if entered:
                    result[key] = entered
        except InspectionError as exc:
            raise InspectionError(f'「{field["label"]}」{exc}') from None
    by_key = {field['key']: field for field in config['fields']}
    for field in config['fields']:
        source = field.get('auto_from')
        if not source:
            continue
        key = field['key']
        if historical and values.get(key):
            if values[key] not in field['options']:
                raise InspectionError(f'「{field["label"]}」判定无效')
            result[key] = values[key]
        elif previous.get(source) == values.get(source) and key in previous:
            result[key] = previous[key]
        elif source in result:
            result[key] = 'NG' if outside_range(by_key[source], result[source]) else 'OK'
    return result


def outside_range(field, value):
    return ((field['minimum'] is not None and value < field['minimum'])
            or (field['maximum'] is not None and value > field['maximum']))


def grade(config, values):
    incomplete = False
    for field in config['fields']:
        value = values.get(field['key'])
        if value in (None, '', []):
            incomplete |= field['required']
        elif field['type'] == 'number':
            if outside_range(field, value):
                return '不良'
        else:
            choices = value if isinstance(value, list) else [value]
            if any(choice in field['fail'] for choice in choices):
                return '不良'
    return '未完成' if incomplete or not values else '合格'


def decode_record(row):
    record = dict(row)
    record['values'] = json.loads(record.pop('values_json'))
    record['form'] = json.loads(record.pop('template_snapshot'))
    return record


def exact_record(db, project_id, template_id, serial, *, include_deleted=False):
    row = db.execute('''SELECT * FROM inspection_records WHERE project_id=? AND template_id=? AND serial=?
                       AND (? OR deleted_at IS NULL)''',
                     (project_id, template_id, serial, include_deleted)).fetchone()
    return decode_record(row) if row else None


def records_for_device(db, project_id, serial):
    return [decode_record(row) for row in db.execute(
        '''SELECT * FROM inspection_records WHERE project_id=? AND serial=? AND deleted_at IS NULL
           ORDER BY updated_at DESC,id DESC''', (project_id, serial))]


def save_record(db, project_id, config, data, user, stamp, record_id):
    serial, prefix, produced = parse_serial(data.get('serial'), config['serial_mode'])
    old = exact_record(db, project_id, config['id'], serial, include_deleted=True)
    if old and old['deleted_at']:
        raise InspectionError('该 S/N 的检测记录已删除，请联系管理员恢复', 409)
    current_form = old['form'] if old else config
    if data.get('version') != (old['updated_at'] if old else None) or data.get('revision') != current_form['revision']:
        raise InspectionError('检测记录或检测表已更新，请重新读取后再保存', 409)
    values = clean_values(current_form, data.get('values'), old['values'] if old else None)
    result = grade(current_form, values)
    register_device(db, project_id, serial, prefix, produced, stamp, user['id'], user['name'])
    remember_options(db, project_id, current_form, values, stamp)
    if old:
        db.execute('UPDATE inspection_records SET result=?,values_json=?,operator_id=?,operator_name=?,updated_at=? WHERE id=? AND project_id=?',
                   (result, dumps(values), user['id'], user['name'], stamp, old['id'], project_id))
    else:
        insert_record(db, project_id, current_form, record_id, serial, prefix, produced, result, values,
                      user['id'], user['name'], '', stamp, stamp)
    return exact_record(db, project_id, config['id'], serial)


def insert_record(db, project_id, config, record_id, serial, prefix, produced, result, values,
                  operator_id, operator_name, source_id, created_at, updated_at):
    db.execute('''INSERT INTO inspection_records(
        id,project_id,template_id,serial,prefix,production_date,result,values_json,template_snapshot,
        operator_id,operator_name,source_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
        record_id, project_id, config['id'], serial, prefix, produced, result, dumps(values),
        dumps(config), operator_id, operator_name, source_id, created_at, updated_at,
    ))


def list_records(db, project_id, template_id, query, *, exporting=False):
    for start, end, label in (('from', 'to', '日期'), ('prefix_from', 'prefix_to', '编号前缀')):
        lower, upper = text(query.get(start), 100), text(query.get(end), 100)
        if lower and upper and lower > upper:
            raise InspectionError(f'起始{label}不能大于结束{label}')
    where = ['project_id=?', 'template_id=?',
             'deleted_at IS NOT NULL' if query.get('deleted') == '1' else 'deleted_at IS NULL']
    parameters = [project_id, template_id]
    for key, clause in (
        ('serial', 'instr(lower(serial), lower(?)) > 0'),
        ('prefix', 'prefix=?'), ('result', 'result=?'),
        ('prefix_from', 'prefix>=?'), ('prefix_to', 'prefix<=?'),
        ('from', "COALESCE(NULLIF(production_date,''),substr(created_at,1,10))>=?"),
        ('to', "COALESCE(NULLIF(production_date,''),substr(created_at,1,10))<=?"),
    ):
        value = text(query.get(key), 100)
        if value:
            where.append(clause)
            parameters.append(value)
    keyword = text(query.get('keyword'), 100)
    if keyword:
        where.append("""instr(lower(serial||' '||production_date||' '||result||
                        ' '||operator_name||' '||values_json), lower(?))>0""")
        parameters.append(keyword)
    predicate = ' AND '.join(where)
    total = db.execute(f'SELECT COUNT(*) FROM inspection_records WHERE {predicate}', parameters).fetchone()[0]
    export_all = exporting and query.get('scope') != 'page'
    if export_all and total > LIMIT:
        raise InspectionError(f'一次最多导出 {LIMIT} 条，请缩小筛选范围')
    page = max(1, min(int(query.get('page') or 1), 100000))
    per_page = int(query.get('per_page') or 50)
    if per_page not in (20, 50, 100, 200):
        per_page = 50
    cap = LIMIT if export_all else per_page
    sort = query.get('sort')
    if sort not in ('serial', 'prefix', 'production_date', 'result', 'created_at', 'updated_at'):
        sort = 'updated_at'
    direction = 'ASC' if query.get('direction') == 'asc' else 'DESC'
    rows = db.execute(f'''SELECT * FROM inspection_records WHERE {predicate}
                          ORDER BY {sort} {direction},id DESC LIMIT ? OFFSET ?''',
                      (*parameters, cap, 0 if export_all else (page - 1) * cap))
    return dict(records=[decode_record(row) for row in rows], total=total, page=page, per_page=per_page)

def timestamp(value, fallback):
    value = text(value, 40)
    if not value:
        return fallback
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).isoformat()
    except ValueError:
        raise InspectionError('记录时间格式无效') from None


def split_options(value, options=(), *, legacy=False):
    if value.startswith('['):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return parsed
        except ValueError:
            pass
    if value in options:
        return [value]
    if legacy:
        return [item.strip() for item in value.split(' / ') if item.strip()]
    return [option.strip() for option in re.split(r'[;；、\n]|\s*/\s*', value) if option.strip()]


def spreadsheet_rows(blob, filename, config):
    try:
        if filename.lower().endswith('.xlsx'):
            _, _, rows = read_xlsx(blob)
        elif filename.lower().endswith('.csv'):
            rows = read_csv(blob)
        else:
            raise InspectionError('请选择 Excel (.xlsx) 或 CSV 文件')
    except (ElectronicBomError, ValueError, OSError, KeyError, RuntimeError, zipfile.BadZipFile) as exc:
        raise InspectionError(str(exc)) from None

    fields = {field['key']: field for field in config['fields']}
    aliases = dict(BASE_ALIASES)
    for field in fields.values():
        aliases[normalized(field['label'])] = field['key']
        aliases.setdefault(normalized(field['key']), field['key'])
    for canonical, synonyms in L7_HEADERS.items():
        target = canonical if canonical in fields else None
        if not target:
            standard_labels = {
                'interaction_test': '功能与反馈',
                'space_value_1': '空间测量1', 'space_value_2': '空间测量2',
                'space_value_3': '空间测量3', 'quality_grade': '品质等级', 'other_note': '其他说明',
            }
            target = aliases.get(normalized(standard_labels.get(canonical, canonical)))
            if not target and canonical == 'interaction_test':
                target = aliases.get(normalized('交互检测'))
            if not target and canonical == 'other_note':
                target = aliases.get(normalized('备注'))
        if canonical == 'far_distance_legacy' and any(
            normalized(label) in aliases for label in ('远距离检测判定', '远距离测量值')
        ):
            target = canonical
        if target:
            for synonym in synonyms:
                aliases.setdefault(normalized(synonym), target)

    columns = None
    for index, (_, header) in enumerate(rows[:12]):
        mapped = [aliases.get(normalized(value)) for value in header]
        if 'serial' in mapped:
            columns = mapped
            break
    if columns is None:
        raise InspectionError('找不到 S/N 或机器编号列')
    keys = [key for key in columns if key]
    if len(keys) != len(set(keys)):
        raise InspectionError('检测表头存在重复列')
    if len(rows) - index - 1 > LIMIT:
        raise InspectionError(f'一次最多导入 {LIMIT} 条')
    ignored = [str(value) for value, key in zip(header, columns)
               if value and not key and normalized(value) not in RESERVED_HEADERS]
    if not fields.keys() & set(keys) and 'far_distance_legacy' not in keys:
        raise InspectionError('没有匹配的检测项，请选择对应检测表或下载导入模板')
    return columns, rows[index + 1:], ignored, aliases


def import_batch(db, project_id, config, blob, filename, stamp):
    columns, rows, ignored, aliases = spreadsheet_rows(blob, filename, config)
    known = {row[0] for row in db.execute(
        'SELECT serial FROM inspection_records WHERE project_id=? AND template_id=?',
        (project_id, config['id']),
    )}
    fields = {field['key']: field for field in config['fields']}
    legacy_l7 = ({'charging_value', 'charging_status', 'far_distance_status'} <= fields.keys()
                 and fields['charging_value']['type'] == 'number')
    errors, ready, duplicates = [], [], 0
    for row_number, values in rows:
        if not any(value not in (None, '') for value in values):
            continue
        try:
            cells = {key: text(value, 12000) for key, value in zip(columns, values) if key}
            # CSV exports protect spreadsheet formulas with a leading apostrophe.
            if filename.lower().endswith('.csv'):
                cells = {k: v[1:] if re.match(r"^'[=+@\-]", v) else v for k, v in cells.items()}
            serial, prefix, produced = parse_serial(cells.get('serial'), config['serial_mode'])
            if serial in known:
                duplicates += 1
                continue
            raw = {}
            for key, field in fields.items():
                value = cells.get(key)
                if not value:
                    continue
                if field['type'] == 'multi':
                    value = split_options(value, field['options'], legacy=legacy_l7)
                if field['type'] == 'choice' and set(field['options']) == {'是', '否'}:
                    value = {'1': '是', '0': '否'}.get(value, value)
                raw[key] = value
            if legacy_l7 and raw.get('charging_value', '').upper() in ('OK', 'NG'):
                raw.setdefault('charging_status', raw.pop('charging_value').upper())
            far = cells.get('far_distance_legacy')
            if far:
                status_key = aliases.get(normalized('远距离检测判定'))
                value_key = aliases.get(normalized('远距离测量值'))
                if status_key:
                    raw.setdefault(status_key, 'NG' if far.upper() == 'NG' else 'OK')
                if value_key and far.upper() not in ('OK', 'NG'):
                    raw.setdefault(value_key, far)
            clean = clean_values(config, raw, historical=bool(cells.get('result')))
            result = cells.get('result') or grade(config, clean)
            if result not in RESULTS:
                raise InspectionError('检测结果无效')
            operator = text(cells.get('operator_name'), 100)
            source = text(cells.get('source_id'), 100)
            created = timestamp(cells.get('created_at'), stamp)
            updated = timestamp(cells.get('updated_at'), created)
            ready.append((serial, prefix, produced, result, clean, operator, source, created, updated))
            known.add(serial)
        except InspectionError as exc:
            errors.append({'row': row_number, 'error': str(exc)})
    return ready, dict(ready=len(ready), duplicates=duplicates, invalid=len(errors),
                       errors=errors[:30], ignored=ignored,
                       sample=[{'serial': row[0], 'result': row[3]} for row in ready[:8]])


def export_rows(config, records):
    fields = {field['key']: field['label'] for field in config['fields']}
    for record in records:
        for field in record['form']['fields']:
            fields.setdefault(field['key'], field['label'])
    headers = ['S/N', '前6位', '生产日期', '检测结果', '检测员', '创建时间', '更新时间', '原记录 ID']
    used = set(map(normalized, headers))
    for key, label in fields.items():
        display = label
        if normalized(display) in used:
            display += f' [{key}]'
        used.add(normalized(display))
        headers.append(display)
    if len(headers) > 100:
        raise InspectionError('历史检测项列数过多，请按生产日期缩小筛选范围')
    rows = [headers]
    for record in records:
        row = [record[key] for key in ('serial', 'prefix', 'production_date', 'result',
                                       'operator_name', 'created_at', 'updated_at', 'source_id')]
        for key in fields:
            value = record['values'].get(key, '')
            row.append(dumps(value) if isinstance(value, list) else value)
        rows.append(row)
    return rows


def csv_file(rows):
    stream = io.StringIO(newline='')
    writer = csv.writer(stream)
    for row in rows:
        writer.writerow(["'" + value if isinstance(value, str) and value.lstrip().startswith(('=', '+', '-', '@'))
                         else value for value in row])
    return stream.getvalue().encode('utf-8-sig')


def column_letter(number):
    name = ''
    while number:
        number, digit = divmod(number - 1, 26)
        name = chr(65 + digit) + name
    return name


def xlsx_file(rows):
    """Write text cells explicitly so Excel preserves 16-digit S/Ns."""
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    package = 'http://schemas.openxmlformats.org/package/2006'
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as book:
        book.writestr('[Content_Types].xml', f'''<Types xmlns="{package}/content-types">
          <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
          <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
          <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
        </Types>''')
        book.writestr('_rels/.rels', f'''<Relationships xmlns="{package}/relationships">
          <Relationship Id="rId1" Type="{rel}/officeDocument" Target="xl/workbook.xml"/>
        </Relationships>''')
        book.writestr('xl/_rels/workbook.xml.rels', f'''<Relationships xmlns="{package}/relationships">
          <Relationship Id="rId1" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/>
        </Relationships>''')
        book.writestr('xl/workbook.xml', f'''<workbook xmlns="{ns}" xmlns:r="{rel}">
          <sheets><sheet name="检测记录" sheetId="1" r:id="rId1"/></sheets>
        </workbook>''')
        with book.open('xl/worksheets/sheet1.xml', 'w') as sheet:
            sheet.write(f'''<worksheet xmlns="{ns}"><sheetViews><sheetView workbookViewId="0">
              <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
              </sheetView></sheetViews><cols><col min="1" max="1" width="23" customWidth="1"/></cols><sheetData>'''.encode())
            for row_no, row in enumerate(rows, 1):
                cells = []
                for col, value in enumerate(row, 1):
                    if value == '':
                        continue
                    ref = column_letter(col) + str(row_no)
                    if isinstance(value, (int, float)):
                        cells.append(f'<c r="{ref}"><v>{value}</v></c>')
                    else:
                        cells.append(f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{escape(str(value))}</t></is></c>')
                sheet.write(f'<row r="{row_no}">{"".join(cells)}</row>'.encode())
            sheet.write(f'</sheetData><autoFilter ref="A1:{column_letter(len(rows[0]))}{len(rows)}"/></worksheet>'.encode())
    return output.getvalue()


def get_device(db, project_id, serial):
    row = db.execute('SELECT * FROM inspection_devices WHERE project_id=? AND serial=?',
                     (project_id, serial)).fetchone()
    return dict(row) if row else None


def register_device(db, project_id, serial, prefix, produced, stamp, operator_id, operator_name):
    created = db.execute('INSERT OR IGNORE INTO inspection_devices VALUES(?,?,?,?,?,?,?)',
                         (project_id, serial, prefix, produced, stamp, operator_id, operator_name)).rowcount
    if not created and produced:
        db.execute("""UPDATE inspection_devices SET production_date=?
                      WHERE project_id=? AND serial=? AND production_date=''""",
                   (produced, project_id, serial))
    return get_device(db, project_id, serial), bool(created)


def list_devices(db, project_id, query):
    page = max(1, min(int(query.get('page') or 1), 100000))
    search = text(query.get('serial'), 100)
    prefix = text(query.get('prefix'), 6)
    predicate = "project_id=? AND instr(lower(serial),lower(?))>0 AND (?='' OR prefix=?)"
    parameters = (project_id, search, prefix, prefix)
    count = db.execute(f'SELECT COUNT(*) FROM inspection_devices WHERE {predicate}', parameters).fetchone()[0]
    devices = db.execute(f'''SELECT d.*,
        (SELECT COUNT(*) FROM inspection_records r
         WHERE r.project_id=d.project_id AND r.serial=d.serial AND r.deleted_at IS NULL) AS records,
        (SELECT result FROM inspection_records r
         WHERE r.project_id=d.project_id AND r.serial=d.serial AND r.deleted_at IS NULL
         ORDER BY r.updated_at DESC,r.id DESC LIMIT 1) AS result
        FROM (SELECT * FROM inspection_devices WHERE {predicate}
              ORDER BY registered_at DESC,serial LIMIT 50 OFFSET ?) AS d
        ORDER BY d.registered_at DESC,d.serial''', (*parameters, (page - 1) * 50))
    return dict(devices=[dict(row) for row in devices], total=count, page=page)


def latest_record(db, project_id, template_id, prefix):
    if len(text(prefix, 6)) != 6:
        raise InspectionError('请输入编号前 6 位')
    row = db.execute('''SELECT * FROM inspection_records WHERE project_id=? AND template_id=?
                       AND prefix=? AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT 1''',
                     (project_id, template_id, prefix)).fetchone()
    return decode_record(row) if row else None


def set_record_deleted(db, project_id, record_id, deleted, stamp):
    row = db.execute('SELECT * FROM inspection_records WHERE project_id=? AND id=?',
                     (project_id, record_id)).fetchone()
    if not row:
        raise InspectionError('检测记录不存在', 404)
    if bool(row['deleted_at']) != deleted:
        # Change the version as well so a pre-deletion draft cannot overwrite a restored record.
        db.execute('UPDATE inspection_records SET deleted_at=?,updated_at=? WHERE project_id=? AND id=?',
                   (stamp if deleted else None, stamp, project_id, record_id))
    return row


def remember_options(db, project_id, config, values, stamp):
    rows = (
        (project_id, config['id'], field['key'], value, stamp)
        for field in config['fields'] if field['type'] == 'multi' and field['custom']
        for value in values.get(field['key'], []) if value not in field['options']
    )
    db.executemany('INSERT OR IGNORE INTO inspection_options VALUES(?,?,?,?,?,NULL)', rows)


def list_options(db, project_id, config):
    keys = {field['key'] for field in config['fields'] if field['type'] == 'multi' and field['custom']}
    return [dict(row) for row in db.execute(
        '''SELECT field_key,value,hidden_at FROM inspection_options WHERE project_id=? AND template_id=?
           ORDER BY created_at DESC,value''', (project_id, config['id']),
    ) if row['field_key'] in keys]


def hide_option(db, project_id, config, data, stamp):
    key = text(data.get('field_key'), 40)
    value = text(data.get('value'), 250)
    if not isinstance(data.get('hidden'), bool):
        raise InspectionError('选项状态无效')
    result = db.execute('''UPDATE inspection_options SET hidden_at=?
                           WHERE project_id=? AND template_id=? AND field_key=? AND value=?''',
                        (stamp if data['hidden'] else None, project_id, config['id'], key, value))
    if not result.rowcount:
        raise InspectionError('现场选项不存在', 404)


def backfill_from_records(db):
    db.execute('''INSERT OR IGNORE INTO inspection_devices
                  SELECT project_id,serial,prefix,production_date,created_at,operator_id,operator_name
                  FROM inspection_records ORDER BY created_at,id''')
    for row in db.execute('SELECT project_id,template_snapshot,values_json,updated_at FROM inspection_records'):
        remember_options(db, row['project_id'], json.loads(row['template_snapshot']),
                         json.loads(row['values_json']), row['updated_at'])

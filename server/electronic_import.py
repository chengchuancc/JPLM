"""Read XLSX/CSV electronic BOMs without executing formulas or external links."""
import csv
import io
import math
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile


class ElectronicBomError(ValueError):
    pass


ALIASES = {
    'name': ('名称', '物料名称', '零件名称', '品名', '元件名称', 'name', 'comment', 'value'),
    'qty': ('单机用量', '单套用量', '数量', '用量', 'qty', 'quantity'),
    'external_code': ('物料编号', '外部料号', '供应商料号', '商品编号', '料号', 'lcsc', 'lcscpartnumber', 'supplierpartnumber'),
    'internal_code': ('系统编号', '系统物料编号', '物料编码', 'code'),
    'spec': ('封装', '规格型号', '规格', '型号', 'package', 'footprint', 'spec'),
    'brand': ('品牌', '厂商', '制造商', 'manufacturer', 'brand'),
    'notes': ('备注', '说明', 'notes', 'remark', 'remarks'),
    'reference': ('位号', '标号', 'designator', 'designators', 'reference'),
    'price': ('单价', '参考单价', '采购单价', 'unitprice', 'price'),
    'source_total': ('总价', '小计', '金额', 'total', 'totalprice'),
    'unit': ('单位', '计量单位', 'unit'),
}


def normalized(value):
    return re.sub(r'[\s_\-（）():：/]+', '', str(value or '').replace('\ufeff', '').casefold())


def local(tag):
    return tag.rsplit('}', 1)[-1]


def xml(blob):
    if len(blob) > 24 * 1024 * 1024 or b'<!DOCTYPE' in blob.upper() or b'<!ENTITY' in blob.upper():
        raise ElectronicBomError('工作表 XML 不被支持')
    try:
        return ET.fromstring(blob)
    except ET.ParseError as exc:
        raise ElectronicBomError('工作表格式错误') from exc


def read_xlsx(blob, sheet_name=''):
    try:
        book = zipfile.ZipFile(io.BytesIO(blob))
    except (zipfile.BadZipFile, OSError) as exc:
        raise ElectronicBomError('无法读取 XLSX 文件') from exc
    with book:
        entries = book.infolist()
        if len(entries) > 4000 or sum(e.file_size for e in entries) > 80 * 1024 * 1024:
            raise ElectronicBomError('Excel 解压后过大，请拆分文件')
        names = set(book.namelist())
        if 'xl/workbook.xml' not in names or 'xl/_rels/workbook.xml.rels' not in names:
            raise ElectronicBomError('不是有效的 XLSX 工作簿')
        workbook = xml(book.read('xl/workbook.xml'))
        relations = xml(book.read('xl/_rels/workbook.xml.rels'))
        targets = {r.get('Id'): r.get('Target') for r in relations if r.get('TargetMode') != 'External'}
        sheets = []
        for node in workbook.iter():
            if local(node.tag) != 'sheet':
                continue
            rid = next((v for k, v in node.attrib.items() if local(k) == 'id'), None)
            target = targets.get(rid)
            if not target:
                continue
            path = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join('xl', target))
            if path.startswith('xl/worksheets/') and path in names:
                sheets.append((node.get('name') or 'Sheet', path))
        if not sheets:
            raise ElectronicBomError('工作簿中没有可读取的工作表')
        selected = next((s for s in sheets if s[0] == sheet_name), None) if sheet_name else sheets[0]
        if selected is None:
            raise ElectronicBomError('所选工作表不存在')
        strings = []
        if 'xl/sharedStrings.xml' in names:
            for si in xml(book.read('xl/sharedStrings.xml')):
                strings.append(''.join(t.text or '' for t in si.iter() if local(t.tag) == 't'))
        rows = []
        cells_seen = 0
        for row in xml(book.read(selected[1])).iter():
            if local(row.tag) != 'row':
                continue
            if len(rows) > 10000:
                raise ElectronicBomError('工作表行数过多，请拆分文件')
            number = int(row.get('r') or len(rows) + 1)
            values = {}
            for cell in row:
                if local(cell.tag) != 'c':
                    continue
                cells_seen += 1
                if cells_seen > 350000:
                    raise ElectronicBomError('工作表单元格过多')
                reference = cell.get('r') or ''
                letters = re.match(r'([A-Z]+)', reference.upper())
                col = 0
                if letters:
                    for c in letters[1]:
                        col = col * 26 + ord(c) - 64
                    col -= 1
                else:
                    col = len(values)
                if col >= 100:
                    continue
                kind = cell.get('t')
                if kind == 'inlineStr':
                    value = ''.join(t.text or '' for t in cell.iter() if local(t.tag) == 't')
                else:
                    value_node = next((c for c in cell if local(c.tag) == 'v'), None)
                    value = value_node.text if value_node is not None else None
                    if kind == 's' and value is not None:
                        try:
                            value = strings[int(value)]
                        except (IndexError, ValueError) as exc:
                            raise ElectronicBomError('共享字符串索引错误') from exc
                    elif any(local(c.tag) == 'f' for c in cell) and value is None:
                        value = '#未缓存公式'
                values[col] = value
            if values:
                rows.append((number, [values.get(i) for i in range(max(values) + 1)]))
        return [s[0] for s in sheets], selected[0], rows


def read_csv(blob):
    text = None
    for encoding in ('utf-8-sig', 'gb18030'):
        try:
            text = blob.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise ElectronicBomError('CSV 编码无法识别')
    try:
        dialect = csv.Sniffer().sniff(text[:5000], delimiters=',;\t')
    except csv.Error:
        dialect = csv.excel
    try:
        rows = [(i, r) for i, r in enumerate(csv.reader(io.StringIO(text), dialect), 1)]
    except csv.Error as exc:
        raise ElectronicBomError('CSV 格式错误') from exc
    if len(rows) > 10000:
        raise ElectronicBomError('CSV 行数过多')
    return rows


def clean(value):
    return '' if value is None else str(value).strip()


def numeric(value, label, required=False):
    if value is None or clean(value) == '':
        if required:
            raise ElectronicBomError(f'{label}为空')
        return None
    try:
        n = float(str(value).replace(',', '').replace('￥', '').replace('¥', '').strip())
    except (ValueError, TypeError) as exc:
        raise ElectronicBomError(f'{label}不是有效数字') from exc
    if not math.isfinite(n) or n < 0 or n > 1e9 or (required and n == 0):
        raise ElectronicBomError(f'{label}超出范围')
    if required and round(n, 6) == 0:
        raise ElectronicBomError('用量至少为 0.000001')
    return round(n, 6)


def parse_electronic_file(blob, filename, sheet_name=''):
    if not blob or len(blob) > 20 * 1024 * 1024:
        raise ElectronicBomError('文件为空或超过 20 MB')
    if filename.lower().endswith('.xlsx'):
        try:
            sheets, selected, grid = read_xlsx(blob, sheet_name)
        except (zipfile.BadZipFile,KeyError,RuntimeError) as exc:
            raise ElectronicBomError('XLSX 文件损坏或已加密') from exc
    elif filename.lower().endswith('.csv'):
        sheets, selected, grid = ['CSV'], 'CSV', read_csv(blob)
    else:
        raise ElectronicBomError('请选择 XLSX 或 CSV 文件')
    lookup = {normalized(alias): key for key, aliases in ALIASES.items() for alias in aliases}
    header = None
    mapping = {}
    for index, (number, values) in enumerate(grid[:50]):
        candidate = {}
        for col, v in enumerate(values):
            key = lookup.get(normalized(v))
            if key and key not in candidate:
                candidate[key] = col
        if 'name' in candidate and 'qty' in candidate:
            mapping, header = candidate, index
            break
    if header is None:
        raise ElectronicBomError('未找到“名称”和“单机用量 / 数量”表头')
    result = []
    skipped = 0
    for number, values in grid[header + 1:]:
        if not any(clean(v) for v in values):
            skipped += 1
            continue
        get = lambda key: values[mapping[key]] if key in mapping and mapping[key] < len(values) else None
        name = clean(get('name'))
        if not name and not clean(get('qty')) and not clean(get('external_code')) and not clean(get('internal_code')):
            skipped += 1
            continue
        if name in ('合计', '总计', '小计', '总价') and not clean(get('qty')):
            skipped += 1
            continue
        row = {k: clean(get(k)) for k in ('name', 'external_code', 'internal_code', 'spec', 'brand', 'notes', 'reference')}
        row.update(source_row=number, unit=clean(get('unit')) or 'PCS', warnings=[], errors=[])
        if not name:
            row['errors'].append('名称为空')
        for key, label in [('qty', '用量'), ('price', '单价'), ('source_total', '原表总价')]:
            try:
                row[key] = numeric(get(key), label, required=key == 'qty')
            except ElectronicBomError as exc:
                row[key] = None
                row['errors'].append(str(exc))
        excluded = bool(re.search(r'不贴|不焊|不装|不安装|测试点|\bDNP\b|\bDNI\b', row['notes'], re.I) or normalized(name) in ('nc', 'testpoint'))
        row['excluded'] = excluded
        if excluded:
            row['warnings'].append('不贴 / 不焊 / 测试点')
        if row['qty'] is not None and row['price'] is not None and row['source_total'] is not None:
            if abs(row['qty'] * row['price'] - row['source_total']) > 0.00001:
                row['warnings'].append('原表总价与用量 × 单价不一致')
        row['selected'] = not excluded and not row['errors']
        result.append(row)
        if len(result) > 5000:
            raise ElectronicBomError('每次最多导入 5000 条物料')
    if not result:
        raise ElectronicBomError('工作表中没有物料明细')
    return {'sheets': sheets, 'sheet': selected, 'header_row': grid[header][0], 'rows': result, 'skipped_rows': skipped}

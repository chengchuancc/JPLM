#!/usr/bin/env python3
"""Extract and import only Feishu order, shipment and referenced device data."""
import argparse
import base64
import gzip
import hashlib
import io
import json
import os
import sys
from collections import Counter
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import app
import shipping

ORDER_MAP = {
    'name': ('全名', '姓名'), 'email': ('E-mail',), 'phone': ('电话号码',), 'country': ('Country',),
    'country_code': ('简写',), 'region': ('州',), 'city': ('城市',), 'postcode': ('邮编',),
    'address': ('地址1',), 'address2': ('地址2',), 'pb': ('PB编号',), 'sku': ('购买SKU',),
    'main_unit': ('L7',), 'base': ('L7底座',), 'case': ('收纳包',),
    'strip': ('反光贴（条）',), 'patch': ('反光贴（块）',), 'pledged': ('KS承诺金额',),
    'amount_due': ('KS应付金额',), 'paid': ('已支付金额',), 'balance': ('欠款',),
}
COMMON = {
    'carrier': ('货代公司',), 'domestic_cost': ('国内运费',),
    'international_cost': ('海外运费',), 'weight': ('包裹重量（g）',),
}
OTHER = {
    'source': ('来源',), 'name': ('客户名字',), 'phone': ('电话',), 'email': ('邮箱',),
    'address': ('地址',), 'country': ('国家',), 'warehouse_cost': ('海外仓运费',),
    'main_unit': ('L7主机',), 'base': ('L7底座',), 'case': ('收纳包',),
    'strip': ('反光贴-条',), 'patch': ('反光贴-块',), 'notes': ('其他',),
}
TZ = timezone(timedelta(hours=8))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def timestamp(value, zone=timezone.utc):
    return datetime.fromtimestamp(value / 1000 if abs(value) >= 100_000_000_000 else value, zone)


class Table:
    def __init__(self, data):
        self.records = data['recordMap']
        self.metadata = data['recordMeta']
        self.fields = {field['name']: (key, field) for key, field in data['table']['fieldMap'].items()}

    def cell(self, row, name):
        field = self.fields.get(name)
        if field:
            return (row.get(field[0]) or {}).get('value')
        return None

    def value(self, row, name):
        value = self.cell(row, name)
        if value is None or value == []:
            return ''
        _, field = self.fields[name]
        if field['type'] in (3, 4):
            options = {option['id']: option['name'] for option in field['property']['options']}
            if isinstance(value, list):
                return '、'.join(options[item] for item in value)
            return options[value]
        if field['type'] == 1005:
            return value[0]['number']
        if isinstance(value, list):
            return ''.join(segment.get('text') or segment.get('link') or '' for segment in value)
        return value

    def details(self, row, keys):
        result = {}
        for key, names in keys.items():
            for name in names:
                value = self.value(row, name)
                if value != '':
                    result[key] = value
                    break
        return result

    def stamp(self, record_id, field):
        return timestamp(self.metadata[record_id]['recMeta'][field]).isoformat()


def extract(path):
    snapshot = json.loads(path.read_bytes())['gzipSnapshot']
    with gzip.GzipFile(fileobj=io.BytesIO(base64.b64decode(snapshot, validate=True))) as stream:
        raw = stream.read(48 * 1024 * 1024 + 1)
    require(len(raw) <= 48 * 1024 * 1024, '附件解压后过大')
    documents = json.loads(raw)
    tables = {}
    for document in documents:
        schema = document['schema']
        data = schema['data']
        table_id = data['table']['meta']['id']
        name = schema['tableMap'][table_id]['name']
        if name in ('KS发货信息', 'KS发货管理', '其他发货管理', '生产管理', '生产管理-作废'):
            tables[name] = Table(data)
    orders_table = tables['KS发货信息']
    orders = []
    backers = {}
    for rid, row in orders_table.records.items():
        backer = str(orders_table.value(row, 'Backer Number'))
        require(backer and backer not in backers.values(), '附件有重复或空白 Backer 编号')
        backers[rid] = backer
        details = orders_table.details(row, ORDER_MAP)
        answer = orders_table.value(row, '问题1').strip()
        if answer in ("OK", "I'm on it!", '0'):
            details['address_status'] = '未确认' if answer == '0' else '已确认'
        orders.append(dict(backer=backer, details=shipping.clean_details(details, shipping.ORDER_KEYS),
                           created_at=orders_table.stamp(rid, 'createdTime'),
                           updated_at=orders_table.stamp(rid, 'modifiedTime')))
    records = []
    links = Counter()
    for channel, name, date_field, ref_field, field_pairs in (
        ('ks', 'KS发货管理', 'Shipping Date', 'No.',
         (('产品编号', '生产管理'), ('产品编号作废', '生产管理-作废'))),
        ('other', '其他发货管理', '发货日期', '订单号',
         (('产品编号2', '生产管理'), ('产品编号', '生产管理-作废'))),
    ):
        table = tables[name]
        for rid, row in table.records.items():
            parents = table.cell(row, '父记录') or []
            require(len(parents) <= 1 and all(parent in table.records for parent in parents),
                    '附件的父记录关联无效')
            linked = table.cell(row, 'Backer #Number') or []
            require(len(linked) <= 1, '一笔 KS 发货关联了多个 Backer')
            devices = []
            for field, target in field_pairs:
                device_table = tables[target]
                for device_id in table.cell(row, field) or []:
                    device = device_table.records[device_id]
                    serial = device_table.value(device, 'S/N')
                    if not serial:
                        serial = device_table.value(device, 'L7编号') or device_id
                        links['fallback_number'] += 1
                    links['source_links'] += 1
                    devices.append(str(serial))
            devices = list(dict.fromkeys(devices))
            details = table.details(row, COMMON if channel == 'ks' else {**COMMON, **OTHER})
            shipped_on = table.value(row, date_field)
            records.append(dict(channel=channel, source_id=rid,
                                parent_source_id=parents[0] if parents else None,
                                backer=backers[linked[0]] if linked else '',
                                reference=shipping.string(table.value(row, ref_field), 150),
                                tracking=shipping.string(table.value(row, 'Tracking Number'), 500),
                                shipped_on=timestamp(shipped_on, TZ).date().isoformat() if shipped_on else '',
                                details=shipping.clean_details(details, shipping.DETAIL_KEYS), devices=devices,
                                created_at=table.stamp(rid, 'createdTime'),
                                updated_at=table.stamp(rid, 'modifiedTime')))
    return dict(orders=orders, records=records, source_links=links['source_links'],
                fallback_number=links['fallback_number'])


def parent_links(records):
    return [(row['channel'], row['source_id'], row['parent_source_id'])
            for row in records if row.get('parent_source_id')]


def apply_parent_links(db, project, links):
    count = 0
    for channel, child_source_id, parent_source_id in links:
        child = db.execute('''SELECT id,parent_id,deleted_at FROM shipping_records
            WHERE project_id=? AND channel=? AND source_id=?''', (project, channel, child_source_id)).fetchone()
        parent = db.execute('''SELECT id FROM shipping_records
            WHERE project_id=? AND channel=? AND source_id=?''', (project, channel, parent_source_id)).fetchone()
        require(child and parent and child['parent_id'] in (None, parent['id']), '原始父子关系与当前台账不一致')
        if child['parent_id'] == parent['id']:
            continue
        require(not child['deleted_at'], '子记录已删除，请先恢复')
        shipping.validate_parent(db, project, child['id'], channel, parent['id'])
        db.execute('UPDATE shipping_records SET parent_id=? WHERE project_id=? AND id=?',
                   (parent['id'], project, child['id']))
        count += 1
    return count


def apply(db, project, payload):
    order_ids = {}
    added_orders = 0
    for order in payload['orders']:
        backer = order['backer']
        current = shipping.lookup_order(db, project, backer)
        if current:
            order_ids[backer] = current['id']
        else:
            order_id = app.uid()
            shipping.save_order(db, project, order_id, backer, order['details'], order['updated_at'],
                                created_at=order.get('created_at'))
            order_ids[backer] = order_id
            added_orders += 1
    added = Counter()
    shipment_ids = []
    for record in payload['records']:
        source_id, channel = record['source_id'], record['channel']
        existing = db.execute('SELECT id FROM shipping_records WHERE project_id=? AND channel=? AND source_id=?',
                              (project, channel, source_id)).fetchone()
        if existing:
            shipment_ids.append(existing['id'])
            continue
        shipment_id = app.uid()
        shipping.save_shipment(db, project, shipment_id, {
            **record, 'ks_order_id': order_ids[record['backer']] if record['backer'] else None,
        }, record['created_at'], None, source_id=source_id, imported=True)
        db.execute('UPDATE shipping_records SET updated_at=? WHERE project_id=? AND id=?',
                   (record['updated_at'], project, shipment_id))
        shipment_ids.append(shipment_id)
        added[channel] += 1

    added_parents = apply_parent_links(db, project, parent_links(payload['records']))
    total = Counter()
    for record, shipment_id in zip(payload['records'], shipment_ids):
        row = db.execute('SELECT * FROM shipping_records WHERE project_id=? AND id=?',
                         (project, shipment_id)).fetchone()
        for field in ('channel', 'source_id', 'reference', 'shipped_on', 'tracking', 'created_at', 'updated_at'):
            require(row[field] == record[field], '发货记录字段核对不一致')
        require(json.loads(row['details']) == record['details'], '发货明细核对不一致')
        require(row['ks_order_id'] == order_ids.get(record['backer']), 'Backer 关联核对不一致')
        devices = shipping.shipment_devices(db, project, [shipment_id]).get(shipment_id, [])
        require([device['serial'] for device in devices] == record['devices'], '发货设备关联核对不一致')
        total['matched_devices'] += sum(device['registered'] for device in devices)
        total['unmatched_devices'] += sum(not device['registered'] for device in devices)
        total['ks_missing_backer'] += record['channel'] == 'ks' and not record['backer']
        total['other_missing_reference'] += record['channel'] == 'other' and not record['reference']
    for order in payload['orders']:
        row = shipping.lookup_order(db, project, order['backer'])
        require(row and row['details'] == order['details'], 'KS 收件资料核对不一致')
    require(db.execute('PRAGMA foreign_key_check').fetchone() is None, '关联完整性检查失败')
    if added or added_orders or added_parents:
        db.project_id = project
        app.log_activity(db, {'id': None, 'name': '系统迁移'}, '导入飞书发货台账', '', '发货管理',
                         f'新增 KS 资料 {added_orders}、KS 发货 {added["ks"]}、其他发货 {added["other"]}、父子关系 {added_parents}')
    return {**total, 'orders': len(order_ids), 'ks': sum(r['channel'] == 'ks' for r in payload['records']),
            'other': sum(r['channel'] == 'other' for r in payload['records']), 'added_orders': added_orders,
            'added_shipments': sum(added.values()), 'added_parents': added_parents, 'source_links': payload['source_links'],
            'fallback_number': payload['fallback_number']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('extract', 'preview', 'commit'))
    parser.add_argument('input', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--project', default='legacy')
    parser.add_argument('--name', default='Tanos')
    args = parser.parse_args()
    os.umask(0o077)
    if args.mode == 'extract':
        require(args.output is not None, '请指定提取结果路径')
        payload = extract(args.input)
        with args.output.open('x') as output:
            json.dump(payload, output, ensure_ascii=False, separators=(',', ':'))
        report = {'orders': len(payload['orders']), 'shipments': len(payload['records']),
                  'parent_links': len(parent_links(payload['records'])),
                  'source_links': payload['source_links'], 'fallback_number': payload['fallback_number']}
    else:
        payload = json.loads(args.input.read_bytes())
        db = app.connect()
        with closing(db):
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT name,archived_at,deleted_at FROM projects WHERE id=?', (args.project,)).fetchone()
            require(row and tuple(row) == (args.name, None, None), '导入项目与预期不符')
            report = apply(db, args.project, payload)
            if args.mode == 'commit':
                db.commit()
            else:
                db.rollback()
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()

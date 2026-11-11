"""Read orders from the configured Shopify shop for the global shipping ledger."""
import json
import os
import re
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

import shipping

API_VERSION = '2026-10'
MAX_IMPORT = 20
ORDER_ID = re.compile(r'gid://shopify/Order/[0-9]{1,30}')

LIST_ORDERS = """
query JplmRecentOrders($after: String) {
  orders(first: 25, after: $after, sortKey: CREATED_AT, reverse: true) {
    nodes {
      id name createdAt cancelledAt displayFulfillmentStatus
      shippingAddress { name address1 countryCodeV2 }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"""

GET_ORDERS = """
query JplmSelectedOrders($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order {
      id name cancelledAt email
      shippingAddress { name phone country countryCodeV2 province city zip address1 address2 }
      lineItems(first: 10) {
        nodes { title variantTitle sku currentQuantity requiresShipping }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
"""

GET_LINES = """
query JplmOrderLines($id: ID!, $after: String!) {
  order(id: $id) {
    lineItems(first: 100, after: $after) {
      nodes { title variantTitle sku currentQuantity requiresShipping }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = build_opener(NoRedirect())
token_lock = threading.Lock()
settings_lock = threading.Lock()
cached_token = None


def credentials(directory):
    try:
        with (directory / 'shopify-credentials.json').open() as source:
            data = json.load(source)
        return data['shop'], data['client_id'], data['client_secret']
    except FileNotFoundError:
        return (os.getenv('PLM_SHOPIFY_SHOP', '').strip().lower(),
                os.getenv('PLM_SHOPIFY_CLIENT_ID', '').strip(),
                os.getenv('PLM_SHOPIFY_CLIENT_SECRET', '').strip())
    except (OSError, ValueError, KeyError, TypeError):
        raise shipping.ShippingError('无法读取 Shopify 配置，请检查服务器配置文件', 500) from None


def valid_shop(shop):
    return bool(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com', shop))


def configuration(directory):
    config = credentials(directory)
    if not valid_shop(config[0]) or not all(config[1:]):
        raise shipping.ShippingError('Shopify 尚未连接，请在「系统设置 → Shopify」填写应用凭据', 503)
    return config


def public_settings(config):
    shop, client_id, secret = config
    return {'shop': shop, 'client_id': client_id, 'has_secret': bool(secret),
            'configured': valid_shop(shop) and bool(client_id and secret)}


def save_settings(directory, data):
    if not isinstance(data, dict):
        raise shipping.ShippingError('Shopify 配置格式无效')
    shop = shipping.string(data.get('shop'), 80).lower()
    client_id = shipping.string(data.get('client_id'), 256)
    secret = shipping.string(data.get('client_secret'), 512)
    if not valid_shop(shop) or not client_id:
        raise shipping.ShippingError('请填写有效的 myshopify.com 店铺域名和 Client ID')
    with settings_lock:
        if not secret:
            saved_shop, saved_id, saved_secret = credentials(directory)
            if (shop, client_id) != (saved_shop, saved_id) or not saved_secret:
                raise shipping.ShippingError('请填写 Client secret')
            secret = saved_secret
        config = (shop, client_id, secret)
        access_token(config, refresh=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=directory, delete=False) as target:
                temporary = target.name
                json.dump({'shop': shop, 'client_id': client_id, 'client_secret': secret}, target)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, directory / 'shopify-credentials.json')
        except OSError:
            raise shipping.ShippingError('Shopify 配置保存失败，请检查服务器存储', 500) from None
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)
    return public_settings(config)


def post(url, body, headers, *, authentication=False):
    try:
        with opener.open(Request(url, body, headers, method='POST'), timeout=12) as response:
            result = json.load(response)
    except HTTPError as error:
        status = error.code
        error.close()
        if status == 429:
            raise shipping.ShippingError('Shopify 请求过多，请稍后重试', 503) from None
        if authentication or status in (401, 403):
            raise shipping.ShippingError('Shopify 授权失败，请检查应用安装、凭据和订单读取权限', 502) from None
        raise shipping.ShippingError('Shopify 暂时无法返回订单，请稍后重试', 502) from None
    except (OSError, URLError, ValueError):
        raise shipping.ShippingError('无法连接 Shopify 或读取响应，请稍后重试', 502) from None
    if not isinstance(result, dict):
        raise shipping.ShippingError('Shopify 响应格式异常', 502)
    return result


def access_token(config, *, refresh=False):
    global cached_token
    shop, client_id, secret = config
    with token_lock:
        if not refresh and cached_token and cached_token[0] == config and cached_token[2] > time.monotonic():
            return cached_token[1]
        payload = urlencode({'grant_type': 'client_credentials', 'client_id': client_id, 'client_secret': secret})
        data = post(f'https://{shop}/admin/oauth/access_token', payload.encode(),
                    {'Content-Type': 'application/x-www-form-urlencoded'}, authentication=True)
        token = data.get('access_token')
        expires = data.get('expires_in')
        if not isinstance(token, str) or not token or not isinstance(expires, int) or expires <= 0:
            raise shipping.ShippingError('Shopify 未返回有效的访问令牌', 502)
        if 'read_orders' not in str(data.get('scope', '')).split(','):
            raise shipping.ShippingError('Shopify 应用缺少 read_orders 权限', 502)
        cached_token = (config, token, time.monotonic() + max(0, expires - 60))
        return token


def query(config, operation, variables):
    shop = config[0]
    data = post(f'https://{shop}/admin/api/{API_VERSION}/graphql.json',
                json.dumps({'query': operation, 'variables': variables}).encode(),
                {'Content-Type': 'application/json', 'X-Shopify-Access-Token': access_token(config)})
    if data.get('errors') or not isinstance(data.get('data'), dict):
        codes = {error.get('extensions', {}).get('code') for error in data.get('errors', [])}
        if 'ACCESS_DENIED' in codes:
            raise shipping.ShippingError('Shopify 拒绝读取订单或收件信息，请检查应用权限', 502)
        if 'THROTTLED' in codes:
            raise shipping.ShippingError('Shopify 请求过多，请稍后重试', 503)
        raise shipping.ShippingError('Shopify 订单读取失败，请稍后重试', 502)
    return data['data']


def list_orders(config, cursor):
    result = query(config, LIST_ORDERS, {'after': cursor or None})['orders']
    info = result['pageInfo']
    return result['nodes'], info['endCursor'] if info['hasNextPage'] else None


def unavailable(order):
    if order.get('cancelledAt'):
        return '已取消'
    address = order.get('shippingAddress') or {}
    if not all(str(address.get(key) or '').strip() for key in ('name', 'address1', 'countryCodeV2')):
        return '缺少收件姓名、地址或国家'
    return ''


def source_id(config, order_id):
    return f'shopify:{config[0]}:{order_id}'


def existing_sources(db, config, order_ids):
    keys = [source_id(config, order_id) for order_id in order_ids]
    if not keys:
        return set()
    placeholders = ','.join('?' for _ in keys)
    return {row[0] for row in db.execute(f"""SELECT source_id FROM shipping_records
        WHERE channel='other' AND source_id IN ({placeholders})
        UNION SELECT source_id FROM shipping_pending_shopify WHERE source_id IN ({placeholders})""", (*keys, *keys))}


def duplicate_reason(db, config, order, existing, projects):
    if source_id(config, order['id']) in existing:
        return '已导入'
    try:
        shipping.check_order_reference(db, order['name'], projects)
    except shipping.ShippingError as error:
        if error.status != 409:
            raise
        return 'PLM 已有同订单号'
    return ''


def get_orders(config, ids):
    result = query(config, GET_ORDERS, {'ids': ids})
    return {order['id']: order for order in result['nodes'] if order and 'id' in order}


def complete_address(details, *, existing=False):
    street = str(details.get('address') or '').strip()
    if not street:
        return street
    parts = [street]
    normalized = lambda value: ' '.join(value.casefold().split())
    seen = {normalized(street)}
    if existing:
        # Preserve a manually combined address and append only missing components.
        seen.update(normalized(part) for part in re.split(r'[,，\n]', street))
        whole = normalized(street)
        locality = [normalized(str(details.get(key) or '')) for key in ('city', 'region', 'postcode', 'country')]
        present = {part for part in locality if part and re.search(r'(?<!\w)' + re.escape(part) + r'(?!\w)', whole)}
        if len(present) >= 2:
            seen.update(present)
        extra = normalized(str(details.get('address2') or ''))
        if extra and re.search(r'(?<!\w)' + re.escape(extra) + r'(?!\w)', whole):
            seen.add(extra)
    for key in ('address2', 'city', 'region', 'postcode', 'country'):
        part = str(details.get(key) or '').strip()
        canonical = normalized(part)
        if canonical and canonical not in seen:
            parts.append(part)
            seen.add(canonical)
    return ', '.join(parts)


def backfill_addresses(db, stamp):
    marker = 'shopify_complete_address_v1'
    if db.execute('SELECT 1 FROM settings WHERE key=?', (marker,)).fetchone():
        return
    for table in ('shipping_records', 'shipping_pending_shopify'):
        rows = db.execute(f"SELECT rowid,details FROM {table} WHERE source_id LIKE 'shopify:%'").fetchall()
        for row in rows:
            try:
                details = json.loads(row['details'])
            except ValueError:
                continue
            if not isinstance(details, dict):
                continue
            address = complete_address(details, existing=True)
            if not address or address == details.get('address'):
                continue
            details['address'] = address
            data = shipping.json_data(details)
            if table == 'shipping_records':
                db.execute('UPDATE shipping_records SET details=?, updated_at=? WHERE rowid=?', (data, stamp, row['rowid']))
            else:
                db.execute('UPDATE shipping_pending_shopify SET details=? WHERE rowid=?', (data, row['rowid']))
    db.execute('INSERT INTO settings(key,value) VALUES(?,?)', (marker, stamp))


def shipment_details(config, order):
    address = order['shippingAddress']
    notes = []
    notes_length = 0
    lines = order['lineItems']
    while True:
        for item in lines['nodes']:
            if not item['requiresShipping'] or item['currentQuantity'] <= 0:
                continue
            variant = item.get('variantTitle')
            sku = item.get('sku')
            label = item['title']
            if variant and variant != 'Default Title':
                label += ' / ' + variant
            if sku:
                label += f'（SKU {sku}）'
            entry = f"{label} × {item['currentQuantity']}"
            notes_length += len(entry) + bool(notes)
            if notes_length > 3000:
                raise shipping.ShippingError('商品明细超过备注长度上限')
            notes.append(entry)
        page = lines['pageInfo']
        if not page['hasNextPage']:
            break
        next_order = query(config, GET_LINES, {'id': order['id'], 'after': page['endCursor']})['order']
        if next_order is None:
            raise shipping.ShippingError('Shopify 订单已不可用')
        lines = next_order['lineItems']
    details = {
        'name': address['name'],
        'phone': address.get('phone'),
        'email': order.get('email'),
        'country': address.get('country') or address.get('countryCodeV2'),
        'region': address.get('province'),
        'city': address.get('city'),
        'postcode': address.get('zip'),
        'address': address['address1'],
        'address2': address.get('address2'),
        'source': 'Shopify',
        'notes': '\n'.join(notes),
    }
    details['address'] = complete_address(details)
    return shipping.clean_details(details, shipping.DETAIL_KEYS)

"""Feishu application bot with a verified event inbox and durable message outbox."""

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import subprocess
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


API_ROOT = 'https://open.feishu.cn/open-apis/'
SETTINGS_FILE = 'feishu-settings.json'
CHAT_ID = re.compile(r'oc_[a-zA-Z0-9_-]{1,150}')
MESSAGE_ID = re.compile(r'om_[a-zA-Z0-9_-]{1,150}')
OPEN_ID = re.compile(r'ou_[a-zA-Z0-9_-]{1,150}')
SETTINGS_LOCK = threading.Lock()
WORKER_LOCK = threading.Lock()
NOTIFICATIONS = ('low_stock', '入库', '出库', '退库', '报废')
SCHEMA = (
    '''CREATE TABLE IF NOT EXISTS feishu_chats (
        app_id TEXT NOT NULL, chat_id TEXT NOT NULL, last_seen REAL NOT NULL,
        PRIMARY KEY(app_id,chat_id)
    )''',
    '''CREATE TABLE IF NOT EXISTS feishu_jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, app_id TEXT NOT NULL,
        chat_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL,
        last_error TEXT NOT NULL DEFAULT ''
    )''',
    'CREATE INDEX IF NOT EXISTS idx_feishu_jobs_pending ON feishu_jobs(status,next_at)',
    '''CREATE TABLE IF NOT EXISTS feishu_low_stock (
        app_id TEXT NOT NULL, project_id TEXT NOT NULL, chat_id TEXT NOT NULL,
        part_id TEXT NOT NULL, job_id TEXT NOT NULL,
        PRIMARY KEY(app_id,project_id,chat_id,part_id)
    )''',
    '''CREATE TABLE IF NOT EXISTS feishu_user_bindings (
        app_id TEXT NOT NULL, open_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at REAL NOT NULL,
        PRIMARY KEY(app_id,open_id), UNIQUE(app_id,user_id)
    )''',
    '''CREATE TABLE IF NOT EXISTS feishu_binding_codes (
        app_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE, expires REAL NOT NULL,
        PRIMARY KEY(app_id,user_id)
    )''',
)


class FeishuError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def initialize(db):
    for statement in SCHEMA:
        db.execute(statement)


def load_settings(directory):
    try:
        with (directory / SETTINGS_FILE).open() as source:
            return json.load(source)
    except FileNotFoundError:
        return {'app_id': '', 'app_secret': '', 'verification_token': '', 'encrypt_key': '',
                'enabled': False, 'queries': True, 'low_stock': False, 'movements': True, 'bindings': []}
    except (OSError, ValueError, TypeError):
        raise FeishuError('飞书配置读取失败，请检查服务器配置', 500) from None


def configured(config):
    return all(config.get(field) for field in ('app_id', 'app_secret', 'verification_token'))


def notification_groups(config):
    if 'groups' in config:
        return config['groups']
    # Upgrade existing project associations to group destinations without losing recipients.
    notifications = (['low_stock'] if config.get('low_stock') else [])
    if config.get('movements', True):
        notifications += list(NOTIFICATIONS[1:])
    return [{'chat_id': chat_id, 'name': '', 'notifications': notifications[:]} for chat_id in dict.fromkeys(
        binding['chat_id'] for binding in config.get('bindings', []))]


def account_binding(db, config, user_id, method):
    if method == 'DELETE':
        db.execute('DELETE FROM feishu_user_bindings WHERE app_id=? AND user_id=?', (config['app_id'], user_id))
        db.execute('DELETE FROM feishu_binding_codes WHERE app_id=? AND user_id=?', (config['app_id'], user_id))
    result = {'configured': bool(configured(config)), 'enabled': config['enabled'],
              'bound': db.execute('SELECT 1 FROM feishu_user_bindings WHERE app_id=? AND user_id=?',
                                  (config['app_id'], user_id)).fetchone() is not None}
    if method == 'POST':
        if not configured(config) or not config['enabled']:
            raise FeishuError('请先由管理员配置并启用飞书连接')
        code = secrets.token_urlsafe(12)
        expires = time.time() + 600
        db.execute('''INSERT INTO feishu_binding_codes VALUES(?,?,?,?)
            ON CONFLICT(app_id,user_id) DO UPDATE SET code_hash=excluded.code_hash,expires=excluded.expires''',
            (config['app_id'], user_id, hashlib.sha256(code.encode()).hexdigest(), expires))
        result.update(command='绑定 ' + code, expires=expires)
    return result


def public_settings(config, db):
    result = {key: config[key] for key in ('app_id', 'enabled', 'queries')}
    result['groups'] = notification_groups(config)
    result.update({f'has_{key}': bool(config.get(key))
                   for key in ('app_secret', 'verification_token', 'encrypt_key')})
    result['configured'] = bool(configured(config))
    result['chats'] = [dict(row) for row in db.execute(
        'SELECT chat_id,last_seen FROM feishu_chats WHERE app_id=? ORDER BY last_seen DESC LIMIT 100',
        (config['app_id'],))]
    result['jobs'] = [dict(row) for row in db.execute('''SELECT kind,chat_id,status,attempts,
        last_error,updated_at FROM feishu_jobs WHERE app_id=? ORDER BY created_at DESC LIMIT 20''',
        (config['app_id'],))]
    return result


def save_settings(directory, data, db):
    if not isinstance(data, dict):
        raise FeishuError('飞书配置格式无效')
    with SETTINGS_LOCK:
        old = load_settings(directory)
        app_id = str(data.get('app_id', '')).strip()
        if not re.fullmatch(r'cli_[a-zA-Z0-9_-]{1,100}', app_id):
            raise FeishuError('请填写有效的飞书 App ID')
        config = {'app_id': app_id}
        for key in ('app_secret', 'verification_token', 'encrypt_key'):
            value = data.get(key, '')
            if not isinstance(value, str) or len(value) > 512:
                raise FeishuError('飞书凭据格式无效')
            config[key] = value.strip() or (old.get(key, '') if app_id == old['app_id'] else '')
        if data.get('clear_encrypt_key') is True:
            config['encrypt_key'] = ''
        if not configured(config):
            raise FeishuError('请填写 App Secret 和 Verification Token')
        for key in ('enabled', 'queries'):
            value = data.get(key, old.get(key, True))
            if type(value) is not bool:
                raise FeishuError('提醒开关格式无效')
            config[key] = value
        groups = data.get('groups', notification_groups(old) if app_id == old['app_id'] else [])
        if not isinstance(groups, list) or len(groups) > 200:
            raise FeishuError('通知群配置格式无效')
        config['groups'] = []
        seen = set()
        for group in groups:
            if not isinstance(group, dict):
                raise FeishuError('通知群配置格式无效')
            chat_id = group.get('chat_id')
            if not isinstance(chat_id, str) or not CHAT_ID.fullmatch(chat_id):
                raise FeishuError('飞书群 ID 应以 oc_ 开头')
            name = group.get('name', '')
            notifications = group.get('notifications', [])
            if not isinstance(name, str) or len(name.strip()) > 100:
                raise FeishuError('群名称请控制在 100 个字符以内')
            if not isinstance(notifications, list) or any(item not in NOTIFICATIONS for item in notifications):
                raise FeishuError('通知类型无效')
            if chat_id in seen:
                raise FeishuError('同一个飞书群只需配置一次')
            config['groups'].append({'chat_id': chat_id, 'name': name.strip(),
                                     'notifications': [item for item in NOTIFICATIONS if item in notifications]})
            seen.add(chat_id)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=directory, delete=False) as target:
                temporary = target.name
                json.dump(config, target, ensure_ascii=False)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, directory / SETTINGS_FILE)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
    return public_settings(config, db)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self):
        self.opener = build_opener(NoRedirect())
        self.identity = None
        self.token = ''
        self.expires = 0
        self.bot_open_id = ''

    def request(self, path, payload=None, token=''):
        headers = {'Content-Type': 'application/json; charset=utf-8'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        request = Request(API_ROOT + path, headers=headers,
                          data=json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None)
        try:
            with self.opener.open(request, timeout=8) as response:
                result = json.loads(response.read(1024 * 1024))
        except HTTPError as error:
            if error.code == 401:
                self.expires = 0
            raise FeishuError(f'飞书接口请求失败（HTTP {error.code}）', 502) from None
        except (URLError, OSError, ValueError):
            raise FeishuError('飞书连接失败，请检查应用配置或网络', 502) from None
        if not isinstance(result, dict) or result.get('code') != 0:
            code = result.get('code') if isinstance(result, dict) else None
            code = code if isinstance(code, int) else '未知'
            if code in (99991661, 99991663, 99991664, 99991668, 99991677):
                self.expires = 0
            raise FeishuError(f'飞书接口返回错误（{code}），请检查凭据及应用权限', 502)
        return result

    def access_token(self, config):
        identity = (config['app_id'], config['app_secret'])
        if identity != self.identity or time.time() >= self.expires:
            result = self.request('auth/v3/tenant_access_token/internal',
                                  {'app_id': config['app_id'], 'app_secret': config['app_secret']})
            token = result.get('tenant_access_token')
            if not isinstance(token, str) or not token:
                raise FeishuError('飞书未返回有效的应用访问凭据', 502)
            self.token = token
            self.identity = identity
            self.expires = time.time() + max(1, int(result.get('expire', 7200)) - 120)
            self.bot_open_id = ''
        return self.token

    def bot_id(self, config):
        token = self.access_token(config)
        if not self.bot_open_id:
            result = self.request('bot/v3/info', token=token)
            self.bot_open_id = result.get('bot', {}).get('open_id', '')
            if not self.bot_open_id:
                raise FeishuError('请先在飞书应用中开启机器人能力', 502)
        return self.bot_open_id

    def send(self, config, chat_id, text, job_id):
        paragraphs = []
        linked = False
        for line in text.split('\n'):
            paragraph = []
            start = 0
            for match in re.finditer(r'https?://[^\s]+/(#projects/[a-zA-Z0-9_-]+/parts/[a-f0-9]{24}|#settings)(?=\s|$)', line):
                if match.start() > start:
                    paragraph.append({'tag': 'text', 'text': line[start:match.start()]})
                label = '打开 PLM' if match[1] == '#settings' else '查看物料'
                paragraph.append({'tag': 'a', 'text': label, 'href': match[0]})
                linked = True
                start = match.end()
            if start < len(line) or not paragraph:
                paragraph.append({'tag': 'text', 'text': line[start:] or ' '})
            paragraphs.append(paragraph)
        content = {'zh_cn': {'title': '', 'content': paragraphs}} if linked else {'text': text}
        return self.request('im/v1/messages?receive_id_type=chat_id', {
            'receive_id': chat_id, 'msg_type': 'post' if linked else 'text',
            'content': json.dumps(content, ensure_ascii=False),
            'uuid': hashlib.sha256(job_id.encode()).hexdigest()[:40],
        }, self.access_token(config))


def decode_event(raw, headers, config):
    try:
        payload = json.loads(raw)
        key = config.get('encrypt_key', '')
        if not configured(config):
            # URL registration can happen before application credentials are saved.
            # This response only echoes the supplied challenge and queues no event.
            if (not key and not config.get('verification_token') and isinstance(payload, dict)
                    and payload.get('type') == 'url_verification'):
                challenge = payload.get('challenge')
                if not isinstance(challenge, str) or not 1 <= len(challenge) <= 512:
                    raise FeishuError('飞书验证参数无效')
                return {'type': 'url_verification', 'challenge': challenge}
            raise FeishuError('请先在 PLM 系统设置中配置飞书应用', 503)
        if key:
            encrypted = base64.b64decode(payload['encrypt'], validate=True)
            if len(encrypted) < 32 or len(encrypted) % 16:
                raise ValueError('invalid encrypted event')
            result = subprocess.run(['openssl', 'enc', '-d', '-aes-256-cbc',
                '-K', hashlib.sha256(key.encode()).hexdigest(), '-iv', encrypted[:16].hex()],
                input=encrypted[16:], capture_output=True, timeout=1, check=False)
            if result.returncode:
                raise ValueError('invalid encrypted event')
            payload = json.loads(result.stdout)
        if not isinstance(payload, dict):
            raise ValueError('invalid event')
        header = payload.get('header', {})
        token = payload.get('token') or header.get('token', '')
        if not isinstance(token, str) or not hmac.compare_digest(token, config['verification_token']):
            raise FeishuError('飞书事件验证失败', 403)
        if payload.get('type') != 'url_verification':
            if header.get('app_id') != config['app_id']:
                raise FeishuError('飞书应用不匹配', 403)
            if key:
                timestamp = headers.get('X-Lark-Request-Timestamp', '')
                nonce = headers.get('X-Lark-Request-Nonce', '')
                signature = hashlib.sha256((timestamp + nonce + key).encode() + raw).hexdigest()
                if not hmac.compare_digest(signature, headers.get('X-Lark-Signature', '')):
                    raise FeishuError('飞书事件签名无效', 403)
        return payload
    except FeishuError:
        raise
    except (ValueError, KeyError, TypeError, AttributeError, OSError, subprocess.TimeoutExpired):
        raise FeishuError('飞书事件格式或加密配置无效', 400) from None


def enqueue(db, kind, config, chat_id, payload, *, project_id='', job_id=None):
    job_id = job_id or secrets.token_hex(16)
    stamp = time.time()
    db.execute('''INSERT OR IGNORE INTO feishu_jobs
        (id,kind,app_id,chat_id,project_id,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)''',
        (job_id, kind, config['app_id'], chat_id, project_id,
         json.dumps(payload, ensure_ascii=False), stamp, stamp))
    return job_id


def accept_event(db, config, event):
    if event.get('type') == 'url_verification':
        challenge = event.get('challenge')
        if not isinstance(challenge, str) or len(challenge) > 512:
            raise FeishuError('飞书验证参数无效')
        return {'challenge': challenge}
    if not config['enabled'] or event.get('header', {}).get('event_type') != 'im.message.receive_v1':
        return {'ok': True}
    content = event.get('event', {})
    message = content.get('message', {})
    chat_id = message.get('chat_id', '')
    message_id = message.get('message_id', '')
    chat_type = message.get('chat_type')
    sender_id = content.get('sender', {}).get('sender_id', {}).get('open_id', '')
    if (content.get('sender', {}).get('sender_type') != 'user' or chat_type not in ('group', 'p2p')
            or message.get('message_type') != 'text'
            or not isinstance(chat_id, str) or not CHAT_ID.fullmatch(chat_id)
            or not isinstance(message_id, str) or not MESSAGE_ID.fullmatch(message_id)):
        return {'ok': True}
    if chat_type == 'group' and not message.get('mentions'):
        return {'ok': True}
    if chat_type == 'p2p' and (not isinstance(sender_id, str) or not OPEN_ID.fullmatch(sender_id)):
        return {'ok': True}
    message = {**message, 'sender_open_id': sender_id}
    enqueue(db, 'query', config, chat_id, message, job_id=config['app_id'] + ':' + message_id)
    return {'ok': True}


def scoped_materials(db, project_id):
    return db.execute('''SELECT DISTINCT p.id,p.project_id,p.code,p.name,p.spec,p.external_code,
        p.stock,p.min_stock,p.unit,p.location,u.name AS custodian_name FROM parts p
        JOIN projects source ON source.id=p.project_id LEFT JOIN users u ON u.id=p.custodian_id
        WHERE p.deleted_at IS NULL AND source.deleted_at IS NULL AND (p.project_id=? OR p.id IN (
            SELECT part_id FROM bom_lines WHERE project_id=?
            UNION SELECT child_id FROM material_links WHERE project_id=?
        )) ORDER BY p.code''', (project_id, project_id, project_id)).fetchall()


def global_materials(db):
    return db.execute('''SELECT p.id,p.project_id,p.code,p.name,p.spec,p.external_code,
        p.stock,p.min_stock,p.unit,p.location,p.material_level,u.name AS custodian_name,j.name AS project_name
        FROM parts p JOIN projects j ON j.id=p.project_id LEFT JOIN users u ON u.id=p.custodian_id
        WHERE p.deleted_at IS NULL AND j.deleted_at IS NULL ORDER BY p.code''').fetchall()


def single_line(value, limit=80):
    return ' '.join(str(value or '—').split())[:limit]


def material_url(part, base_url):
    return f'{base_url}/#projects/{part["project_id"]}/parts/{part["id"]}'


def enqueue_movement(db, directory, movement, part, handler_name):
    # The outbox is committed with the stock record, so rolled-back operations never notify.
    try:
        config = load_settings(directory)
    except FeishuError:
        logging.warning('飞书配置读取失败，库存记录正常保存')
        return
    if not configured(config) or not config['enabled'] or part['material_level'] != 1:
        return
    project = db.execute('SELECT name FROM projects WHERE id=?', (part['project_id'],)).fetchone()[0]
    unit = single_line(part['unit'], 20)
    text = (f'【{movement["type"]}】{single_line(project)}｜'
            f'{single_line(part["code"])} {single_line(part["name"])}｜'
            f'{movement["type"]} {movement["qty"]:g} {unit}｜'
            f'结存 {part["stock"]:g} {unit}｜经办人：{single_line(handler_name)}')
    if movement['type'] == '报废':
        text += '｜原因：' + single_line(movement['reason'], 60)
    for group in notification_groups(config):
        if movement['type'] not in group['notifications']:
            continue
        chat_id = group['chat_id']
        enqueue(db, 'movement', config, chat_id,
                {'part_id': part['id'], 'text': text, 'project_id': part['project_id'],
                 'movement_type': movement['type']},
                project_id=part['project_id'], job_id=f'{config["app_id"]}:movement:{movement["id"]}:{chat_id}')
    # Capture recovery and subsequent shortages even when both happen between worker ticks.
    enqueue_low_stock(db, config)


def enqueue_low_stock(db, config):
    current = set()
    groups = [group for group in notification_groups(config) if 'low_stock' in group['notifications']]
    low = [part for part in global_materials(db)
           if part['material_level'] == 1 and part['stock'] < part['min_stock']] if groups else []
    episodes = {(row['chat_id'], row['part_id']): row['job_id'] for row in db.execute(
        'SELECT chat_id,part_id,job_id FROM feishu_low_stock WHERE app_id=?', (config['app_id'],))}
    for group in groups:
        chat_id = group['chat_id']
        for part in low:
            current.add((config['app_id'], part['project_id'], chat_id, part['id']))
            key = (chat_id, part['id'])
            job_id = episodes.get(key)
            if not job_id:
                job_id = enqueue(db, 'low_stock', config, chat_id,
                                 {'part_ids': [part['id']]}, project_id=part['project_id'])
            db.execute('INSERT OR IGNORE INTO feishu_low_stock VALUES(?,?,?,?,?)',
                       (config['app_id'], part['project_id'], chat_id, part['id'], job_id))
    for row in db.execute('SELECT app_id,project_id,chat_id,part_id FROM feishu_low_stock').fetchall():
        if tuple(row) not in current:
            db.execute('DELETE FROM feishu_low_stock WHERE app_id=? AND project_id=? AND chat_id=? AND part_id=?', tuple(row))


def material_text(part, base_url):
    detail = material_url(part, base_url)
    return (f'{part["code"]} {part["name"][:100]}\n'
            f'库存 {part["stock"]:g} {part["unit"]} · 最低库存 {part["min_stock"]:g}\n'
            f'规格 {part["spec"][:100] or "—"} · 外部料号 {part["external_code"][:80] or "—"}\n'
            f'库位 {part["location"][:80] or "—"} · 负责人 {part["custodian_name"] or "—"}\n{detail}')


def private_query_scope(db, config, message, text, base_url):
    open_id = message['sender_open_id']
    if text.startswith('绑定 '):
        completed = db.execute('''SELECT u.name FROM feishu_user_bindings b JOIN users u ON u.id=b.user_id
            WHERE b.app_id=? AND b.open_id=? AND b.message_id=? AND u.must_change=0''',
            (config['app_id'], open_id, message['message_id'])).fetchone()
        if completed:
            return [], f'已绑定 PLM 账号「{completed["name"]}」。可以直接发送「查询 前壳」或「低库存」。'
        code = text[3:].strip()
        pending = db.execute('''SELECT c.user_id FROM feishu_binding_codes c JOIN users u ON u.id=c.user_id
            WHERE c.app_id=? AND c.code_hash=? AND c.expires>? AND u.must_change=0''',
            (config['app_id'], hashlib.sha256(code.encode()).hexdigest(), time.time())).fetchone()
        if not pending:
            return [], '绑定码无效或已过期，请在 PLM「系统设置 → 个人资料 → 飞书账号」重新生成。'
        occupied = db.execute('SELECT user_id FROM feishu_user_bindings WHERE app_id=? AND open_id=?',
                              (config['app_id'], open_id)).fetchone()
        if occupied and occupied['user_id'] != pending['user_id']:
            return [], '这个飞书账号已绑定其他 PLM 账号，请先登录原账号解除绑定。'
        db.execute('DELETE FROM feishu_user_bindings WHERE app_id=? AND user_id=?',
                   (config['app_id'], pending['user_id']))
        db.execute('INSERT INTO feishu_user_bindings VALUES(?,?,?,?,?,?)',
                   (config['app_id'], open_id, pending['user_id'], message['chat_id'], message['message_id'], time.time()))
        db.execute('DELETE FROM feishu_binding_codes WHERE app_id=? AND user_id=?',
                   (config['app_id'], pending['user_id']))
        name = db.execute('SELECT name FROM users WHERE id=?', (pending['user_id'],)).fetchone()[0]
        return [], f'已绑定 PLM 账号「{name}」。可以直接发送「查询 前壳」「查询物料 JC110001」或「低库存」。'
    user = db.execute('''SELECT u.id,u.role,u.must_change FROM users u JOIN feishu_user_bindings b ON b.user_id=u.id
        WHERE b.app_id=? AND b.open_id=?''', (config['app_id'], open_id)).fetchone()
    if not user or user['must_change']:
        return [], ('你好，我是 JPLM 物料助手。请先登录 PLM，在「系统设置 → 个人资料 → 飞书账号」生成绑定码，'
                    '再把「绑定 ...」整行发给我。\n' + base_url + '/#settings')
    projects = [dict(row) for row in db.execute('''SELECT p.id AS project_id FROM projects p
        WHERE p.deleted_at IS NULL AND p.archived_at IS NULL AND (? OR EXISTS(
            SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=?))''',
        (user['role'] == 'admin', user['id']))]
    return projects, ''


def query_response(db, config, job, client, base_url):
    message = json.loads(job['payload'])
    try:
        text = json.loads(message['content'])['text']
    except (ValueError, KeyError, TypeError):
        return None
    if not isinstance(text, str):
        return None
    for mention in message.get('mentions', []):
        text = text.replace(mention.get('key', '@_user_'), '')
    text = text.strip()
    if message.get('chat_type') == 'p2p':
        bindings, response = private_query_scope(db, config, message, text, base_url)
        if response:
            return response
    else:
        bot_id = client.bot_id(config)
        if not any(mention.get('id', {}).get('open_id') == bot_id for mention in message.get('mentions', [])):
            return None
        db.execute('INSERT INTO feishu_chats VALUES(?,?,?) ON CONFLICT(app_id,chat_id) DO UPDATE SET last_seen=excluded.last_seen',
                   (config['app_id'], job['chat_id'], time.time()))
    if not config['queries']:
        return None
    low_only = text in ('低库存', '库存不足')
    term = re.sub(r'^(?:查询物料|查询库存|查库存|查物料|查询|查)(?:\s|[：:])*', '', text).strip()
    if not term or text.casefold() in ('帮助', 'help', 'hello', '你好', '绑定群'):
        return '发送「查询物料 JC110001」「查询 前壳」或「低库存」。支持料号、外部料号、名称和规格，群内请 @机器人。'
    if len(term) > 100:
        return '查询内容请控制在 100 个字符以内。'
    matches = {}
    candidates = global_materials(db) if message.get('chat_type') == 'group' else (
        part for binding in bindings for part in scoped_materials(db, binding['project_id']))
    for part in candidates:
        fields = (part['code'], part['name'], part['spec'], part['external_code'])
        if (low_only and 0 < part['stock'] < part['min_stock']) or (
            not low_only and any(term.casefold() in field.casefold() for field in fields)
        ):
            matches[part['id']] = part
    parts = sorted(matches.values(), key=lambda part: (part['code'].casefold() != term.casefold(), part['code']))
    if not parts:
        return '没有库存大于 0 的低库存物料。' if low_only else f'未找到「{term}」。'
    title = f'找到 {len(parts)} 项物料，显示前 {min(5, len(parts))} 项'
    return title + '\n\n' + '\n\n'.join(material_text(part, base_url) for part in parts[:5])


def job_text(db, config, job, client, base_url):
    if not config['enabled'] or job['app_id'] != config['app_id']:
        return None
    if job['kind'] == 'query':
        return query_response(db, config, job, client, base_url)
    payload = json.loads(job['payload'])
    group = next((group for group in notification_groups(config) if group['chat_id'] == job['chat_id']), None)
    if not group:
        return None
    if job['kind'] == 'movement':
        if payload['movement_type'] not in group['notifications']:
            return None
        if not db.execute('SELECT 1 FROM parts WHERE id=? AND material_level=1',
                          (payload['part_id'],)).fetchone():
            return None
        return payload['text'] + '｜' + material_url(
            {'project_id': payload['project_id'], 'id': payload['part_id']}, base_url)
    if job['kind'] != 'low_stock' or 'low_stock' not in group['notifications']:
        return None
    current_ids = {row[0] for row in db.execute('SELECT part_id FROM feishu_low_stock WHERE job_id=?', (job['id'],))}
    parts = [part for part in global_materials(db)
             if part['material_level'] == 1 and part['id'] in payload['part_ids']
             and part['id'] in current_ids and part['stock'] < part['min_stock']]
    if not parts:
        return None
    return '\n'.join(
        f'【低库存】{single_line(part["project_name"])}｜{single_line(part["code"])} {single_line(part["name"])}｜'
        f'库存 {part["stock"]:g} {single_line(part["unit"], 20)}｜最低 {part["min_stock"]:g}｜'
        + material_url(part, base_url) for part in parts)


def tick(directory, connect, client, base_url):
    if not WORKER_LOCK.acquire(blocking=False):
        return
    try:
        config = load_settings(directory)
        if not configured(config) or not config['enabled']:
            return
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            enqueue_low_stock(db, config)
            # Retain message IDs for seven days to deduplicate event delivery.
            db.execute("DELETE FROM feishu_jobs WHERE status IN ('sent','ignored') AND updated_at<?",
                       (time.time() - 7 * 86400,))
            jobs = [dict(row) for row in db.execute('''SELECT * FROM feishu_jobs WHERE status='pending'
                AND next_at<=? AND app_id=? ORDER BY created_at LIMIT 5''', (time.time(), config['app_id']))]
        for job in jobs:
            try:
                config = load_settings(directory)
                with connect() as db:
                    text = job_text(db, config, job, client, base_url)
                if text:
                    client.send(config, job['chat_id'], text, job['id'])
                with connect() as db:
                    db.execute('''UPDATE feishu_jobs SET status=?,updated_at=?,last_error='',payload='{}'
                        WHERE id=?''', ('sent' if text else 'ignored', time.time(), job['id']))
            except FeishuError as error:
                attempts = job['attempts'] + 1
                with connect() as db:
                    db.execute('''UPDATE feishu_jobs SET attempts=?,last_error=?,next_at=?,updated_at=?,status=? WHERE id=?''',
                        (attempts, str(error), time.time() + min(60 * 2 ** attempts, 1800), time.time(),
                         'failed' if attempts >= 8 else 'pending', job['id']))
    finally:
        WORKER_LOCK.release()


def run(directory, connect, stop, base_url):
    client = Client()
    while not stop.is_set():
        try:
            tick(directory, connect, client, base_url)
        except (FeishuError, sqlite3.Error, OSError):
            logging.warning('飞书后台任务暂时失败，将稍后重试')
        stop.wait(3)

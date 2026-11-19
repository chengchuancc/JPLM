"""Registered warehouse scanners and their warehouse-only operator sessions."""

import hashlib
import re
import secrets
import struct
import time

try:
    from PIL import Image, ImageOps
except ImportError:
    Image = ImageOps = None

THUMBNAIL_SIZE = 80
THUMBNAIL_LENGTH = THUMBNAIL_SIZE ** 2 * 2
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_FIRMWARE_BYTES = 0x640000
OTA_MIN_VERSION = (0, 2, 7)
FIRMWARE_VERSION = re.compile(r'(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})')
FIRMWARE_MARKER = b'JPLM_OTA_ESP32S3_N16R8:'

BACKUP_TABLES = ('scanner_devices', 'scanner_device_users', 'scanner_movements')

SCHEMA = (
    """CREATE TABLE IF NOT EXISTS scanner_devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        mac TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
        firmware TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        last_seen_at TEXT, last_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        pending INTEGER NOT NULL DEFAULT 0 CHECK(pending IN (0, 1)),
        enrolled_from TEXT NOT NULL DEFAULT ''
    )""",
    """CREATE TABLE IF NOT EXISTS scanner_device_users (
        device_id TEXT NOT NULL REFERENCES scanner_devices(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY(device_id, user_id)
    )""",
    """CREATE TABLE IF NOT EXISTS scanner_sessions (
        token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, user_id TEXT NOT NULL,
        expires REAL NOT NULL,
        FOREIGN KEY(device_id, user_id) REFERENCES scanner_device_users(device_id, user_id) ON DELETE CASCADE
    )""",
    """CREATE INDEX IF NOT EXISTS idx_scanner_sessions_device ON scanner_sessions(device_id)""",
    """CREATE TABLE IF NOT EXISTS scanner_movements (
        movement_id TEXT PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES scanner_devices(id)
    )""",
    """CREATE TABLE IF NOT EXISTS scanner_updates (
        device_id TEXT PRIMARY KEY REFERENCES scanner_devices(id) ON DELETE CASCADE,
        version TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
        image BLOB, status TEXT NOT NULL, updated_at TEXT NOT NULL
    )""",
)


def initialize(db):
    for statement in SCHEMA:
        db.execute(statement)
    columns = {row[1] for row in db.execute('PRAGMA table_info(scanner_devices)')}
    if 'pending' not in columns:
        db.execute('ALTER TABLE scanner_devices ADD COLUMN pending INTEGER NOT NULL DEFAULT 0 CHECK(pending IN (0, 1))')
    if 'enrolled_from' not in columns:
        db.execute("ALTER TABLE scanner_devices ADD COLUMN enrolled_from TEXT NOT NULL DEFAULT ''")


def digest(secret):
    return hashlib.sha256(secret.encode('ascii')).hexdigest()


def version_tuple(version):
    match = FIRMWARE_VERSION.fullmatch(version)
    return tuple(map(int, match.groups())) if match else ()


def image_version(image):
    if (len(image) < 256 or image[0] != 0xe9 or not 1 <= image[1] <= 16
            or image[12:14] != b'\x09\x00' or image[32:36] != b'\x32\x54\xcd\xab'):
        return ''
    # The running firmware also uses this marker as its version source.
    marker = re.search(re.escape(FIRMWARE_MARKER) + rb'([0-9.]{5,14})\x00', image)
    return marker[1].decode('ascii') if marker else ''


def by_key(db, key, *, include_inactive=False):
    if not re.fullmatch(r'[0-9a-f]{64}', key or ''):
        return None
    return db.execute('''SELECT * FROM scanner_devices WHERE key_hash=?
        AND (? OR (enabled=1 AND pending=0))''', (digest(key), include_inactive)).fetchone()


def operators(db, device_id, *, user_id=None, limit=8, offset=0):
    return db.execute('''SELECT u.id,u.name FROM scanner_device_users a
        JOIN users u ON u.id=a.user_id
        WHERE a.device_id=? AND u.must_change=0 AND (? IS NULL OR u.id=?)
        ORDER BY u.name COLLATE NOCASE, u.id LIMIT ? OFFSET ?''',
                      (device_id, user_id, user_id, limit, offset)).fetchall()


def operator_session(db, auth):
    match = re.fullmatch(r'Bearer ([0-9a-f]{64})', auth or '')
    if not match:
        return None
    return db.execute('''SELECT u.id,u.name,u.role,u.must_change,s.device_id AS scanner_id
        FROM scanner_sessions s JOIN scanner_devices d ON s.device_id=d.id
        JOIN scanner_device_users a ON a.device_id=s.device_id AND a.user_id=s.user_id
        JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=? AND s.expires>? AND d.enabled=1 AND d.pending=0 AND u.must_change=0''',
                      (digest(match[1]), time.time())).fetchone()


def new_session(db, device_id, user_id):
    db.execute('DELETE FROM scanner_sessions WHERE device_id=? OR expires<=?', (device_id, time.time()))
    token = secrets.token_hex(32)
    db.execute('INSERT INTO scanner_sessions VALUES(?,?,?,?)',
               (digest(token), device_id, user_id, time.time() + 12 * 3600))
    return token


def list_devices(db):
    devices = []
    for row in db.execute('''SELECT d.id,d.name,d.enabled,d.pending,d.mac,d.ip,d.firmware,d.created_at,d.last_seen_at,
        upper(substr(d.key_hash,1,8)) AS verification,
        u.name AS last_user, o.version AS ota_version, o.status AS ota_status
        FROM scanner_devices d LEFT JOIN users u ON u.id=d.last_user_id
        LEFT JOIN scanner_updates o ON o.device_id=d.id
        ORDER BY d.pending DESC,d.name COLLATE NOCASE,d.id'''):
        devices.append({**dict(row), 'enabled': bool(row['enabled']), 'pending': bool(row['pending']),
                        'user_ids': [r[0] for r in db.execute(
            'SELECT user_id FROM scanner_device_users WHERE device_id=? ORDER BY user_id', (row['id'],))]})
    return devices


def thumbnail(source):
    """Fixed-size little-endian RGB565, ready for a 240-pixel ESP32 display."""
    if Image is None:
        return None
    try:
        with Image.open(source) as original:
            if original.width * original.height > 20_000_000:
                return None
            image = ImageOps.exif_transpose(original)
            image.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE))
            canvas = Image.new('RGB', (THUMBNAIL_SIZE, THUMBNAIL_SIZE))
            thumb = image.convert('RGBA')
            canvas.paste(thumb, ((THUMBNAIL_SIZE - image.width) // 2,
                                 (THUMBNAIL_SIZE - image.height) // 2), thumb)
            rgb = canvas.tobytes()
            pixels = [(r >> 3) << 11 | (g >> 2) << 5 | (b >> 3)
                      for r, g, b in zip(rgb[::3], rgb[1::3], rgb[2::3])]
            return struct.pack(f'<{len(pixels)}H', *pixels)
    except (OSError, ValueError, Image.DecompressionBombError):
        return None

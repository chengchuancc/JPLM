"""SQLite project ownership and the v8 to v9 migration."""

PROJECT_VERSION = 9
MATERIAL_CATEGORIES_VERSION = 20
MATERIAL_CODE_PREFIX_VERSION = 21
RECORD_DELETION_VERSION = 22
INVENTORY_TIME_VERSION = 23
COVER_SIZE_VERSION = 24
IMAGE_NAME_VERSION = 25
PROJECT_ROLE_VERSION = 26
SHARED_BOM_VERSION = 27
MATERIAL_PROJECT_VERSION = 28
SHARED_MATERIAL_LINK_VERSION = 29
PRODUCT_MOLD_VERSION = 30
MOLD_PART_VERSION = 31
MOLD_MOQ_VERSION = 32
MOLD_AMORTIZATION_VERSION = 33
VERSION = MOLD_AMORTIZATION_VERSION
LEGACY_PROJECT_ID = 'legacy'
BUSINESS_TABLES = (
    'products', 'parts', 'suppliers', 'quotes', 'bom_versions', 'bom_lines',
    'purchases', 'purchase_lines', 'movements', 'files', 'material_links',
    'material_code_aliases',
)
PROJECT_BUSINESS_TABLES = (*BUSINESS_TABLES, 'product_molds')
SCOPED_TABLES = (*PROJECT_BUSINESS_TABLES, 'import_runs')
LEGACY_SCOPED_TABLES = (*BUSINESS_TABLES, 'import_runs')
RELATIONS = {
    'parts': (('sub_product_id', 'products'), ('numbering_product_id', 'products')),
    'quotes': (('part_id', 'parts'), ('supplier_id', 'suppliers')),
    'bom_versions': (('product_id', 'products'),),
    'bom_lines': (('version_id', 'bom_versions'), ('part_id', 'parts')),
    'purchases': (('supplier_id', 'suppliers'),),
    'purchase_lines': (('purchase_id', 'purchases'), ('part_id', 'parts')),
    'movements': (
        ('part_id', 'parts'), ('product_id', 'products'),
        ('purchase_line_id', 'purchase_lines'), ('original_id', 'movements'),
    ),
    'material_links': (('parent_id', 'parts'), ('child_id', 'parts')),
    'material_code_aliases': (('part_id', 'parts'),),
}
SYSTEM_ACTIONS = (
    '登录', '退出登录', '新增用户', '修改用户', '重置密码', '恢复备份',
)

PRODUCT_MOLD_TABLE = """
CREATE TABLE IF NOT EXISTS product_molds (
    project_id TEXT NOT NULL REFERENCES projects(id),
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(trim(name)<>''),
    code TEXT NOT NULL DEFAULT '',
    supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
    cost REAL CHECK(cost>=0),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id,product_id) REFERENCES products(project_id,id),
    FOREIGN KEY(project_id,supplier_id) REFERENCES suppliers(project_id,id)
)
"""
MOLD_PART_TABLE = """
CREATE TABLE IF NOT EXISTS product_mold_parts (
    mold_id TEXT NOT NULL REFERENCES product_molds(id) ON DELETE CASCADE,
    part_id TEXT NOT NULL REFERENCES parts(id),
    PRIMARY KEY (mold_id,part_id)
)
"""

PROJECT_TABLE = """
CREATE TABLE projects (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    owner_id TEXT REFERENCES users(id), archived_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)
"""
MEMBER_TABLE = """
CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (project_id, user_id)
)
"""
COVER_TABLE = """
CREATE TABLE IF NOT EXISTS project_covers (
    project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id),
    mime TEXT NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')),
    image BLOB NOT NULL CHECK(length(image) > 0),
    updated_at TEXT NOT NULL
)
"""

MATERIAL_CATEGORY_TABLE = """CREATE TABLE IF NOT EXISTS material_categories (
    project_id TEXT NOT NULL REFERENCES projects(id),
    name_key TEXT NOT NULL, name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 64),
    PRIMARY KEY (project_id,name_key)
)"""

MATERIAL_PROJECT_TABLE = """CREATE TABLE IF NOT EXISTS material_projects (
    part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id),
    PRIMARY KEY (part_id, project_id)
)"""


def migrate_material_categories(db):
    old_check = "CHECK(category IN ('结构物料','电子物料'))"
    db.execute('PRAGMA foreign_keys=OFF')
    db.execute('PRAGMA legacy_alter_table=ON')
    try:
        db.execute('BEGIN IMMEDIATE')
        sql = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='parts'").fetchone()[0]
        if old_check in sql:
            statements = [row[0] for row in db.execute("""SELECT sql FROM sqlite_master
                WHERE tbl_name='parts' AND type IN ('index','trigger') AND sql IS NOT NULL""")]
            schema = sql[sql.index('('):].replace(old_check, 'CHECK(length(trim(category)) BETWEEN 1 AND 64)', 1)
            db.execute('CREATE TABLE parts_category_upgrade ' + schema)
            db.execute('INSERT INTO parts_category_upgrade SELECT * FROM parts ORDER BY rowid')
            db.execute('DROP TABLE parts')
            db.execute('ALTER TABLE parts_category_upgrade RENAME TO parts')
            for statement in statements:
                db.execute(statement)
        db.execute(MATERIAL_CATEGORY_TABLE)
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise RuntimeError('物料类别升级后的关联校验未通过')
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.execute('PRAGMA legacy_alter_table=OFF')
        db.execute('PRAGMA foreign_keys=ON')

def migrate_inventory(db):
    old_check = 'CHECK(received>=0 AND received<=qty)'
    db.execute('PRAGMA foreign_keys=OFF')
    db.execute('PRAGMA legacy_alter_table=ON')
    try:
        db.execute('BEGIN IMMEDIATE')
        sql = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='purchase_lines'").fetchone()[0]
        if old_check in sql:
            indexes = [row[0] for row in db.execute("""SELECT sql FROM sqlite_master
                WHERE tbl_name='purchase_lines' AND type IN ('index','trigger') AND sql IS NOT NULL""")]
            schema = sql[sql.index('('):].replace(old_check, 'CHECK(received>=0)', 1)
            db.execute('CREATE TABLE purchase_lines_inventory_upgrade ' + schema)
            db.execute('INSERT INTO purchase_lines_inventory_upgrade SELECT * FROM purchase_lines ORDER BY rowid')
            db.execute('DROP TABLE purchase_lines')
            db.execute('ALTER TABLE purchase_lines_inventory_upgrade RENAME TO purchase_lines')
            for statement in indexes:
                db.execute(statement)
        if 'occurred_at' not in {row['name'] for row in db.execute('PRAGMA table_info(movements)')}:
            db.execute("ALTER TABLE movements ADD COLUMN occurred_at TEXT NOT NULL DEFAULT ''")
        db.execute("UPDATE movements SET occurred_at=created_at WHERE occurred_at=''")
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise RuntimeError('库存升级后的关联校验未通过')
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.execute('PRAGMA legacy_alter_table=OFF')
        db.execute('PRAGMA foreign_keys=ON')


def migrate_shared_bom(db):
    if 'part_project_id' in {row['name'] for row in db.execute('PRAGMA table_info(bom_lines)')}:
        return
    db.execute('''CREATE TABLE bom_lines_shared (
        project_id TEXT NOT NULL REFERENCES projects(id),
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES bom_versions(id) ON DELETE CASCADE,
        part_id TEXT NOT NULL REFERENCES parts(id),
        qty REAL NOT NULL CHECK(qty>0),
        reference TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        part_project_id TEXT NOT NULL,
        UNIQUE(version_id,part_id),
        FOREIGN KEY(project_id,version_id) REFERENCES bom_versions(project_id,id),
        FOREIGN KEY(part_project_id,part_id) REFERENCES parts(project_id,id)
    )''')
    db.execute('''INSERT INTO bom_lines_shared
        SELECT project_id,id,version_id,part_id,qty,reference,notes,project_id FROM bom_lines ORDER BY rowid''')
    db.execute('DROP TABLE bom_lines')
    db.execute('ALTER TABLE bom_lines_shared RENAME TO bom_lines')
    db.execute('CREATE INDEX idx_bom_lines_project ON bom_lines(project_id)')
    db.execute('CREATE INDEX idx_bom_lines_part ON bom_lines(part_id)')


def migrate_shared_material_links(db):
    if 'child_project_id' in {row['name'] for row in db.execute('PRAGMA table_info(material_links)')}:
        return
    db.execute('''CREATE TABLE material_links_shared (
        project_id TEXT NOT NULL REFERENCES projects(id),
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
        child_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
        qty REAL NOT NULL DEFAULT 1 CHECK(qty>0),
        created_at TEXT NOT NULL,
        reference TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        child_project_id TEXT NOT NULL,
        UNIQUE(parent_id,child_id),
        CHECK(parent_id<>child_id),
        FOREIGN KEY(project_id,parent_id) REFERENCES parts(project_id,id),
        FOREIGN KEY(child_project_id,child_id) REFERENCES parts(project_id,id)
    )''')
    db.execute('''INSERT INTO material_links_shared
        SELECT project_id,id,parent_id,child_id,qty,created_at,reference,notes,project_id
        FROM material_links ORDER BY rowid''')
    db.execute('DROP TABLE material_links')
    db.execute('ALTER TABLE material_links_shared RENAME TO material_links')
    db.execute('CREATE INDEX idx_material_links_project ON material_links(project_id)')
    db.execute('CREATE INDEX idx_material_links_child ON material_links(child_id)')
    db.execute('CREATE INDEX idx_material_links_child_project ON material_links(child_project_id)')


def _scoped_schema(table, legacy_sql):
    """Keep v8 columns and constraints and add ownership constraints."""
    start = legacy_sql.index('(')
    columns = legacy_sql[start + 1:legacy_sql.rindex(')')]
    if table == 'import_runs':
        columns = columns.replace('id TEXT PRIMARY KEY', 'id TEXT NOT NULL', 1)
        columns += ', PRIMARY KEY (project_id, id)'
    if table in {parent for refs in RELATIONS.values() for _, parent in refs}:
        columns += ', UNIQUE (project_id, id)'
    for column, parent in RELATIONS.get(table, ()):
        # The original v8 FK still provides its existing cascade behavior.
        columns += f', FOREIGN KEY (project_id, {column}) REFERENCES {parent}(project_id, id)'
    return f'''CREATE TABLE {table} (
        project_id TEXT NOT NULL REFERENCES projects(id), {columns}
    )'''


def migrate_projects(db, stamp):
    """Run with foreign keys disabled before opening the transaction.

    SQLite cannot add a composite FK in place. Rebuild the affected tables in
    one transaction, keeping all original values and the row order used by UI.
    """
    db.execute('PRAGMA foreign_keys=OFF')
    db.execute('PRAGMA legacy_alter_table=ON')
    try:
        db.execute('BEGIN IMMEDIATE')
        if db.execute('PRAGMA user_version').fetchone()[0] >= PROJECT_VERSION:
            db.commit()
            return
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise RuntimeError('升级前发现无效关联，请检查备份')
        db.execute(PROJECT_TABLE)
        db.execute(MEMBER_TABLE)
        db.execute('CREATE INDEX idx_project_members_user ON project_members(user_id, project_id)')
        db.execute('ALTER TABLE activity ADD COLUMN project_id TEXT REFERENCES projects(id)')
        placeholders = ','.join('?' for _ in SYSTEM_ACTIONS)
        business_log = f'action NOT IN ({placeholders})'
        has_data = any(db.execute(f'SELECT 1 FROM {table} LIMIT 1').fetchone()
                       for table in LEGACY_SCOPED_TABLES)
        if has_data or db.execute(f'SELECT 1 FROM activity WHERE {business_log} LIMIT 1', SYSTEM_ACTIONS).fetchone():
            owner = db.execute("SELECT id FROM users WHERE role='admin' ORDER BY rowid LIMIT 1").fetchone()
            db.execute('INSERT INTO projects VALUES(?,?,?,?,?,?,?)',
                       (LEGACY_PROJECT_ID, 'PJ-000001', '存量项目', owner[0] if owner else None,
                        None, stamp, stamp))
            db.execute('INSERT INTO project_members SELECT ?,id FROM users', (LEGACY_PROJECT_ID,))
            db.execute(f'UPDATE activity SET project_id=? WHERE {business_log}',
                       (LEGACY_PROJECT_ID, *SYSTEM_ACTIONS))
        for table in LEGACY_SCOPED_TABLES:
            sql = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
            db.execute(f'ALTER TABLE {table} RENAME TO old_{table}')
            db.execute(_scoped_schema(table, sql))
            db.execute(f'INSERT INTO {table} SELECT ?,old_{table}.* FROM old_{table} ORDER BY rowid',
                       (LEGACY_PROJECT_ID,))
        for table in reversed(LEGACY_SCOPED_TABLES):
            db.execute(f'DROP TABLE old_{table}')
        db.execute("CREATE UNIQUE INDEX idx_product_english_code ON products(project_id,english_code) WHERE english_code<>''")
        db.execute('CREATE UNIQUE INDEX idx_material_serial ON parts(material_serial)')
        db.execute('CREATE INDEX idx_material_links_child ON material_links(child_id)')
        db.execute('CREATE INDEX idx_movements_part ON movements(part_id)')
        db.execute('CREATE INDEX idx_files_owner ON files(owner_type,owner_id)')
        db.execute('CREATE INDEX idx_purchase_lines_order ON purchase_lines(purchase_id)')
        db.execute('CREATE INDEX idx_project_activity ON activity(project_id,id)')
        for table in LEGACY_SCOPED_TABLES:
            db.execute(f'CREATE INDEX idx_{table}_project ON {table}(project_id)')
        # Files have two possible owner tables. Use the same ownership check on
        # writes as for a normal FK, while preserving historical file records.
        for operation in ('INSERT', 'UPDATE OF project_id, owner_type, owner_id'):
            suffix = operation.split()[0].lower()
            db.execute(f'''
                CREATE TRIGGER files_project_{suffix}
                BEFORE {operation} ON files
                WHEN (NEW.owner_type='products' AND NOT EXISTS (
                    SELECT 1 FROM products WHERE id=NEW.owner_id AND project_id=NEW.project_id
                )) OR (NEW.owner_type='parts' AND NOT EXISTS (
                    SELECT 1 FROM parts WHERE id=NEW.owner_id AND project_id=NEW.project_id
                ))
                BEGIN SELECT RAISE(ABORT, 'FOREIGN KEY project file owner'); END
            ''')
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise RuntimeError('项目迁移后的关联校验未通过')
        db.execute(f'PRAGMA user_version={PROJECT_VERSION}')
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.execute('PRAGMA legacy_alter_table=OFF')
        db.execute('PRAGMA foreign_keys=ON')

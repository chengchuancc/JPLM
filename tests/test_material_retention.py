"""Deleted-material retention, global recovery and safe permanent deletion."""
import sqlite3
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import test_app as fixtures

app = fixtures.app


class MaterialRetentionTests(unittest.TestCase):
    setUpClass = classmethod(fixtures.IntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.IntegrationTests.tearDownClass.__func__)
    setUp = fixtures.IntegrationTests.setUp
    request = fixtures.IntegrationTests.request
    state = fixtures.IntegrationTests.state
    product = fixtures.IntegrationTests.product
    supplier = fixtures.IntegrationTests.supplier
    upload = fixtures.IntegrationTests.upload

    def part_named(self, name, **data):
        return self.request('parts', 'POST', {'name': name, **data})['id']

    def deleted(self):
        return self.request('global-materials', project=False)['deleted_parts']

    def age(self, id, stamp):
        with app.transaction() as db:
            db.execute('UPDATE parts SET deleted_at=? WHERE id=?', (stamp.isoformat(), id))

    def test_global_deleted_list_and_recovery_use_the_source_project(self):
        other = self.request('projects', 'POST', {'name': '物料来源项目'})['id']
        part = self.request('parts', 'POST', {'name': '待清理外壳'}, project=other)['id']
        image = self.upload('外壳.png', b'\x89PNG\r\n\x1a\nimage', part=part, project=other)['ids'][0]
        self.request('parts/' + part, 'DELETE', {}, project=other)
        row = next(row for row in self.deleted() if row['id'] == part)
        self.assertEqual(row['project_name'], '物料来源项目')
        self.assertEqual(row['purge_blockers'], [])
        self.assertEqual(datetime.fromisoformat(row['purge_after']) - datetime.fromisoformat(row['deleted_at']), timedelta(days=30))
        self.request('deleted-parts/' + part, 'PUT', {}, 404)
        self.request('deleted-parts/' + part, 'PUT', {}, project=other)
        self.assertNotIn(part, {row['id'] for row in self.deleted()})
        self.request('parts/' + part, 'DELETE', {}, project=other)
        self.request('deleted-parts/' + part, 'DELETE', {'confirm': True}, project=other)
        self.assertNotIn(part, {row['id'] for row in self.deleted()})
        self.assertFalse((app.DATA / 'uploads' / image).exists())
        with app.connect() as db:
            self.assertIsNone(db.execute('SELECT id FROM parts WHERE id=?', (part,)).fetchone())
            self.assertIsNone(db.execute('SELECT id FROM files WHERE id=?', (image,)).fetchone())
            self.assertIsNone(db.execute('PRAGMA foreign_key_check').fetchone())

    def test_automatic_cleanup_respects_boundary_restore_and_project_lifecycle(self):
        current = datetime(2026, 11, 19, 8, tzinfo=timezone.utc)
        old = self.part_named('到期物料')
        image = self.upload('到期.png', b'\x89PNG\r\n\x1a\nimage', part=old)['ids'][0]
        attachment = self.upload('资料.txt', b'part document', part=old)['ids'][0]
        boundary = self.part_named('刚满30天')
        recent = self.part_named('未到期物料')
        restored = self.part_named('恢复物料')
        for id in (old, boundary, recent, restored):
            self.request('parts/' + id, 'DELETE', {})
        self.age(old, current - timedelta(days=30, seconds=1))
        self.age(boundary, current - timedelta(days=30))
        self.age(recent, current - timedelta(days=29))
        self.age(restored, current - timedelta(days=60))
        self.request('deleted-parts/' + restored, 'PUT', {})
        other = self.request('projects', 'POST', {'name': '已归档项目'})['id']
        archived = self.request('parts', 'POST', {'name': '归档项目物料'}, project=other)['id']
        self.request('parts/' + archived, 'DELETE', {}, project=other)
        self.age(archived, current - timedelta(days=60))
        self.request('projects/' + other, 'PUT', {'archived': True})
        self.assertEqual(app.cleanup_deleted_parts(current_time=current), 1)
        self.assertFalse((app.DATA / 'uploads' / image).exists())
        self.assertFalse((app.DATA / 'uploads' / attachment).exists())
        with app.connect() as db:
            for id in (boundary, recent, restored, archived):
                self.assertIsNotNone(db.execute('SELECT id FROM parts WHERE id=?', (id,)).fetchone())
            log = db.execute("SELECT actor_name,detail FROM activity WHERE action='自动永久删除物料'").fetchone()
            self.assertEqual(log['actor_name'], '系统')
            self.assertIn('30 天', log['detail'])
        self.assertEqual(app.cleanup_deleted_parts(current_time=current), 0)
        self.request('parts/' + restored, 'DELETE', {})
        row = next(row for row in self.deleted() if row['id'] == restored)
        self.assertGreater(datetime.fromisoformat(row['deleted_at']), current - timedelta(days=1))

    def test_references_block_manual_and_automatic_cleanup(self):
        current = datetime.now(timezone.utc)
        product = self.product()
        version = next(row['id'] for row in self.state()['bom_versions'] if row['product_id'] == product)
        bom = self.part_named('BOM 引用')
        purchase = self.part_named('采购引用')
        movement = self.part_named('流水引用')
        mold = self.part_named('模具引用')
        parent = self.part_named('一级关联引用')
        child = self.part_named('二级关联引用', material_level=2, parent_ids=[parent])
        self.request('bom-lines', 'POST', {'version_id': version, 'part_id': bom, 'qty': 1})
        self.request('purchases', 'POST', {'supplier_id': self.supplier(), 'date': '2026-11-19',
                     'lines': [{'part_id': purchase, 'qty': 1, 'price': 1}]})
        self.request('movements', 'POST', {'type': '入库', 'part_id': movement, 'qty': 1})
        self.request('product-molds', 'POST', {'name': '保护模具', 'product_id': product, 'part_ids': [mold]})
        for id in (bom, purchase, movement, mold, parent, child):
            self.request('parts/' + id, 'DELETE', {})
            self.age(id, current - timedelta(days=60))
            self.request('deleted-parts/' + id, 'DELETE', {'confirm': True}, 409)
        self.assertTrue(all(row['purge_blockers'] for row in self.deleted()))
        self.assertEqual(app.cleanup_deleted_parts(current_time=current), 0)
        self.assertEqual(len(self.deleted()), 6)
        line = next(row['id'] for row in self.state()['bom_lines'] if row['part_id'] == bom)
        self.request('bom-lines/' + line, 'DELETE', {})
        self.assertEqual(app.cleanup_deleted_parts(current_time=current), 1)
        self.assertEqual(len(self.deleted()), 5)

    def test_failed_cleanup_restores_files_and_does_not_stop_the_batch(self):
        current = datetime.now(timezone.utc)
        image = self.upload('测试.png', b'\x89PNG\r\n\x1a\nimage')['ids'][0]
        self.request('parts/' + self.part, 'DELETE', {})
        self.age(self.part, current - timedelta(days=60))
        with patch.object(app, 'log_activity', side_effect=sqlite3.OperationalError('test rollback')):
            self.assertEqual(app.cleanup_deleted_parts(current_time=current), 0)
        self.assertTrue((app.DATA / 'uploads' / image).exists())
        self.assertIn(self.part, {row['id'] for row in self.deleted()})
        self.assertEqual(app.cleanup_deleted_parts(current_time=current), 1)
        self.assertFalse((app.DATA / 'uploads' / image).exists())

    def test_deleted_list_and_writes_preserve_permissions(self):
        self.request('parts/' + self.part, 'DELETE', {})
        admin = self.cookie
        account = {'name': '其他项目成员', 'email': 'retention@example.test', 'password': 'initial-password'}
        user = self.request('users', 'POST', account)['id']
        other = self.request('projects', 'POST', {'name': '成员项目', 'members': [user]})['id']
        self.request('projects/' + other, 'PUT', {'members': [user], 'member_roles': {user: []}})
        self.request('auth/login', 'POST', account)
        self.request('account/password', 'POST', {'current_password': account['password'], 'password': 'updated-password'})
        self.assertIn(self.part, {row['id'] for row in self.deleted()})
        self.request('deleted-parts/' + self.part, 'PUT', {}, 404)
        self.request('deleted-parts/' + self.part, 'DELETE', {'confirm': True}, 403)
        self.cookie = ''
        self.request('global-materials', status=401, project=False)
        self.cookie = admin
        self.request('deleted-parts/' + self.part, 'DELETE', {}, 400)

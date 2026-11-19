"""Feishu callback security, project scoping and durable notification delivery."""

import base64
import hashlib
import json
import os
import subprocess
import time
import unittest
from unittest.mock import Mock

import test_app as fixtures
import feishu_bot

app = fixtures.app


class FeishuTests(unittest.TestCase):
    setUpClass = classmethod(fixtures.IntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.IntegrationTests.tearDownClass.__func__)
    request = fixtures.IntegrationTests.request
    state = fixtures.IntegrationTests.state
    product = fixtures.IntegrationTests.product
    move = fixtures.IntegrationTests.move

    def setUp(self):
        fixtures.IntegrationTests.setUp(self)
        self.addCleanup(lambda: (app.DATA / feishu_bot.SETTINGS_FILE).unlink(missing_ok=True))
        with app.transaction() as db:
            for table in ('feishu_jobs', 'feishu_low_stock', 'feishu_chats'):
                db.execute('DELETE FROM ' + table)
        self.config = {'app_id': 'cli_test', 'app_secret': 'test-secret',
                       'verification_token': 'test-verification', 'encrypt_key': '',
                       'enabled': True, 'queries': True,
                       'groups': [{'name': '测试群', 'chat_id': 'oc_project', 'notifications': []}]}

    def save(self, **changes):
        self.config.update(changes)
        return self.request('settings/feishu', 'PUT', self.config, project=False)

    def event(self, message_id='om_query', chat_id='oc_project', text='查询 测试', **changes):
        message = {'message_id': message_id, 'chat_id': chat_id, 'chat_type': 'group',
                   'message_type': 'text', 'content': json.dumps({'text': '@_user_1 ' + text}),
                   'mentions': [{'key': '@_user_1', 'id': {'open_id': 'ou_bot'}}]}
        message.update(changes)
        return {'schema': '2.0', 'header': {'app_id': 'cli_test', 'token': 'test-verification',
                'event_type': 'im.message.receive_v1', 'event_id': message_id},
                'event': {'sender': {'sender_type': 'user'}, 'message': message}}

    def deliver(self, event, status=200, headers=None):
        return self.request('feishu/events', 'POST', event, status, project=False, headers=headers)

    def client(self):
        client = Mock()
        client.bot_id.return_value = 'ou_bot'
        return client

    def tick(self, client):
        feishu_bot.tick(app.DATA, app.connect, client, 'https://plm.example/JPLM')

    def test_feishu_settings_are_admin_only_and_secrets_are_masked(self):
        public = self.save()
        self.assertTrue(public['has_app_secret'])
        self.assertNotIn('app_secret', public)
        self.assertNotIn('verification_token', public)
        self.assertEqual(os.stat(app.DATA / feishu_bot.SETTINGS_FILE).st_mode & 0o777, 0o600)
        self.request('settings/feishu', 'PUT', {**self.config, 'app_secret': '', 'verification_token': ''},
                     project=False)
        self.assertEqual(feishu_bot.load_settings(app.DATA)['app_secret'], 'test-secret')
        admin = self.cookie
        self.cookie = ''
        self.request('settings/feishu', status=401, project=False)
        challenge = {'type': 'url_verification', 'challenge': 'check', 'token': 'test-verification'}
        self.assertEqual(self.deliver(challenge), {'challenge': 'check'})
        self.deliver({**challenge, 'token': 'wrong'}, 403)
        self.cookie = admin
        account = {'name': '项目成员', 'email': 'feishu@example.test', 'password': 'initial-password'}
        self.request('users', 'POST', account)
        self.request('auth/login', 'POST', account)
        self.request('account/password', 'POST', {'current_password': account['password'], 'password': 'new-password'})
        self.request('settings/feishu', status=403, project=False)
        self.request('settings/feishu', 'PUT', self.config, 403, project=False)

    def test_feishu_material_urls_are_rich_text_hyperlinks(self):
        client = feishu_bot.Client()
        client.access_token = Mock(return_value='mock-token')
        client.request = Mock(return_value={'code': 0})
        url = 'https://work.makagic.com/JPLM/#projects/legacy/parts/' + 'a' * 24
        client.send(self.config, 'oc_test', 'JC110006 <中框> *原文*\n库存 234\n' + url, 'link-test')
        body = client.request.call_args.args[1]
        self.assertEqual(body['msg_type'], 'post')
        paragraphs = json.loads(body['content'])['zh_cn']['content']
        self.assertEqual(paragraphs[0], [{'tag': 'text', 'text': 'JC110006 <中框> *原文*'}])
        self.assertEqual(paragraphs[-1], [{'tag': 'a', 'text': '查看物料', 'href': url}])
        client.send(self.config, 'oc_test', '【入库】测试项目｜结存 10 个｜' + url, 'inline-link-test')
        paragraphs = json.loads(client.request.call_args.args[1]['content'])['zh_cn']['content']
        self.assertEqual(len(paragraphs), 1)
        self.assertEqual(paragraphs[0][-1], {'tag': 'a', 'text': '查看物料', 'href': url})
        client.send(self.config, 'oc_test', '帮助', 'plain-test')
        self.assertEqual(client.request.call_args.args[1]['msg_type'], 'text')

    def test_feishu_url_registration_before_credentials_only_echoes_challenge(self):
        self.cookie = ''
        challenge = {'type': 'url_verification', 'challenge': 'setup-before-credentials', 'token': 'platform-token'}
        self.assertEqual(self.deliver(challenge), {'challenge': 'setup-before-credentials'})
        self.deliver({**challenge, 'challenge': ''}, 400)
        self.deliver({**challenge, 'challenge': {'invalid': True}}, 400)
        self.deliver(self.event(), 503)
        with app.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM feishu_jobs').fetchone()[0], 0)

    def test_feishu_encrypted_challenge_and_signed_event(self):
        self.save(encrypt_key='test-encrypt-key')
        key = hashlib.sha256(self.config['encrypt_key'].encode()).hexdigest()

        def encrypted(payload):
            iv = os.urandom(16)
            result = subprocess.run(['openssl', 'enc', '-aes-256-cbc', '-K', key, '-iv', iv.hex()],
                                    input=json.dumps(payload).encode(), capture_output=True, check=True)
            return {'encrypt': base64.b64encode(iv + result.stdout).decode()}

        challenge = encrypted({'type': 'url_verification', 'token': 'test-verification', 'challenge': 'encrypted-check'})
        self.assertEqual(self.deliver(challenge), {'challenge': 'encrypted-check'})
        event = encrypted(self.event())
        raw = json.dumps(event).encode()
        timestamp, nonce = str(int(time.time())), 'nonce'
        signature = hashlib.sha256((timestamp + nonce + 'test-encrypt-key').encode() + raw).hexdigest()
        self.deliver(event, 403)
        self.deliver(event, headers={'X-Lark-Request-Timestamp': timestamp,
                     'X-Lark-Request-Nonce': nonce, 'X-Lark-Signature': signature})
        with app.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM feishu_jobs').fetchone()[0], 1)

    def test_feishu_group_queries_cover_all_projects_and_messages_are_deduplicated(self):
        self.save()
        other = self.request('projects', 'POST', {'name': '外部项目'})['id']
        private = self.request('parts', 'POST', {'name': '全局查询物料'}, project=other)['id']
        shared = self.request('parts', 'POST', {'name': '已引用外壳', 'spec': 'TEST-CASE'}, project=other)['id']
        product = self.product()
        version = next(row['id'] for row in self.state()['bom_versions'] if row['product_id'] == product)
        self.request('bom-lines', 'POST', {'part_id': shared, 'version_id': version, 'qty': 1})
        event = self.event(text='查询 外壳')
        self.deliver(event)
        event['header']['event_id'] = 'another-delivery'
        self.deliver(event)
        self.deliver(self.event('om_private', text='查询 全局查询物料'))
        self.deliver(self.event('om_p2p', chat_type='p2p'))
        self.deliver(self.event('om_not_mentioned', mentions=[]))
        client = self.client()
        self.tick(client)
        self.assertEqual(client.send.call_count, 2)
        text = client.send.call_args_list[0].args[2]
        self.assertIn('已引用外壳', text)
        self.assertIn('全局查询物料', client.send.call_args_list[1].args[2])
        self.tick(client)
        self.assertEqual(client.send.call_count, 2)
        self.deliver(self.event('om_unbound', chat_id='oc_unbound', text='查询 全局查询物料'))
        self.tick(client)
        self.assertIn('全局查询物料', client.send.call_args.args[2])
        self.assertEqual({row['chat_id'] for row in self.request('settings/feishu', project=False)['chats']},
                         {'oc_project', 'oc_unbound'})

    def test_feishu_low_stock_retries_and_rearms_after_stock_recovers(self):
        self.save(groups=[{'name': '库存群', 'chat_id': 'oc_project', 'notifications': ['low_stock']}])
        client = self.client()
        client.send.side_effect = feishu_bot.FeishuError('测试网络故障')
        self.tick(client)
        with app.connect() as db:
            row = dict(db.execute("SELECT * FROM feishu_jobs WHERE kind='low_stock'").fetchone())
            self.assertEqual((row['attempts'], row['status']), (1, 'pending'))
        client.send.side_effect = None
        self.tick(client)
        self.assertEqual(client.send.call_count, 1)
        with app.transaction() as db:
            db.execute('UPDATE feishu_jobs SET next_at=0')
        self.tick(client)
        self.assertEqual(client.send.call_count, 2)
        self.assertEqual(client.send.call_args_list[0].args[3], client.send.call_args_list[1].args[3])
        self.assertIn(self.code, client.send.call_args.args[2])
        self.assertTrue(client.send.call_args.args[2].startswith('【低库存】'))
        self.assertNotIn('\n', client.send.call_args.args[2])
        self.tick(client)
        self.assertEqual(client.send.call_count, 2)
        self.move('入库', 3)
        self.tick(client)
        self.move('出库', 2)
        self.tick(client)
        self.assertEqual(client.send.call_count, 3)
        self.save(groups=[])
        self.move('入库', 5)
        self.move('出库', 5)
        self.tick(client)
        self.assertEqual(client.send.call_count, 3)

    def test_feishu_groups_upgrade_validate_and_route_new_movements(self):
        old = {**self.config, 'low_stock': True,
               'bindings': [{'project_id': self.project_id, 'chat_id': 'oc_project'},
                            {'project_id': 'other', 'chat_id': 'oc_project'}]}
        del old['groups']
        self.assertEqual(feishu_bot.notification_groups(old), [
            {'name': '', 'chat_id': 'oc_project', 'notifications': list(feishu_bot.NOTIFICATIONS)}])
        self.move('入库', 10)  # Historical records are not replayed when a group is enabled.
        groups = [{'name': '仓库群', 'chat_id': 'oc_warehouse', 'notifications': ['入库', '出库', '退库']},
                  {'name': '报废群', 'chat_id': 'oc_scrap', 'notifications': ['报废']}]
        public = self.save(groups=groups)
        self.assertEqual(public['groups'], groups)
        self.assertNotIn('bindings', public)
        self.request('settings/feishu', 'PUT', {**self.config, 'groups': [groups[0], groups[0]]}, 400, project=False)
        self.request('settings/feishu', 'PUT', {**self.config, 'groups': [
            {**groups[0], 'notifications': ['bad']}]}, 400, project=False)
        self.move('入库', 2)
        out = self.move('出库', 3)['id']
        self.move('退库', 1, original_id=out)
        self.move('报废', 1, reason='外壳\n损坏')
        self.request('movements', 'POST', {'type': '出库', 'part_id': self.part, 'qty': 100}, 400)
        with self.assertRaisesRegex(RuntimeError, 'rollback'):
            with app.transaction() as db:
                db.project_id = self.project_id
                app.record_movement(db, {'type': '入库', 'part_id': self.part, 'qty': 7})
                raise RuntimeError('rollback')
        client = self.client()
        self.tick(client)
        messages = [call.args for call in client.send.call_args_list]
        self.assertEqual(len(messages), 4)
        self.assertEqual([message[1] for message in messages], ['oc_warehouse'] * 3 + ['oc_scrap'])
        self.assertEqual([text[2].split('｜')[3] for text in messages],
                         ['结存 12 个', '结存 9 个', '结存 10 个', '结存 9 个'])
        self.assertIn('原因：外壳 损坏', messages[-1][2])
        self.assertTrue(all('\n' not in message[2] and self.code in message[2] for message in messages))
        self.assertTrue(all('经办人：' in message[2] for message in messages))
        self.assertEqual(next(part['stock'] for part in self.state()['parts'] if part['id'] == self.part), 9)
        self.tick(client)
        self.assertEqual(client.send.call_count, 4)

    def test_feishu_warehouse_retries_notify_once_and_respect_updated_routes(self):
        self.save(groups=[{'name': '仓库群', 'chat_id': 'oc_project', 'notifications': ['入库']}])
        payload = {'project_id': self.project_id, 'part_id': self.part,
                   'type': '入库', 'qty': 10, 'request_id': 'a' * 32}
        first = self.request('warehouse/movements', 'POST', payload, project=False)
        self.assertEqual(self.request('warehouse/movements', 'POST', payload, project=False), first)
        client = self.client()
        client.send.side_effect = feishu_bot.FeishuError('temporary failure')
        self.tick(client)
        self.assertEqual(client.send.call_count, 1)
        with app.transaction() as db:
            db.execute('UPDATE feishu_jobs SET next_at=0')
        client.send.side_effect = None
        self.tick(client)
        self.assertEqual(client.send.call_count, 2)
        self.assertEqual(client.send.call_args_list[0].args[3], client.send.call_args_list[1].args[3])
        self.move('入库', 1)
        self.save(groups=[{'name': '仓库群', 'chat_id': 'oc_project', 'notifications': ['报废']}])
        self.tick(client)
        self.assertEqual(client.send.call_count, 2)

    def test_feishu_global_shortages_rearm_between_worker_ticks(self):
        other = self.request('projects', 'POST', {'name': '其他项目'})['id']
        shared = self.request('parts', 'POST', {'name': '跨项目物料', 'min_stock': 50}, project=other)['id']
        self.save(groups=[{'name': '全局库存群', 'chat_id': 'oc_project', 'notifications': ['low_stock']}])
        client = self.client()
        self.tick(client)
        self.assertEqual(client.send.call_count, 2)
        self.assertTrue(any(shared in call.args[2] for call in client.send.call_args_list))
        self.move('入库', 3)
        self.move('出库', 2)
        self.tick(client)
        self.assertEqual(client.send.call_count, 3)
        self.tick(client)
        self.assertEqual(client.send.call_count, 3)

    def test_feishu_queries_keep_secondary_parts_but_low_stock_ignores_zero(self):
        self.save()
        secondary = self.request('parts', 'POST', {
            'name': '二级查询物料', 'material_level': 2, 'min_stock': 5})['id']
        self.request('movements', 'POST', {'type': '入库', 'part_id': secondary, 'qty': 1})
        state = self.state()
        secondary_code = next(part['code'] for part in state['parts'] if part['id'] == secondary)
        client = self.client()
        binding = self.request('account/feishu', 'POST', {}, project=False)

        def query(id, text, private=False):
            event = self.event(id, text=text)
            if private:
                event['event']['message'].update(chat_type='p2p', chat_id='oc_private', mentions=[],
                                                 content=json.dumps({'text': text}))
                event['event']['sender']['sender_id'] = {'open_id': 'ou_member'}
            self.deliver(event)
            self.tick(client)
            return client.send.call_args.args[2]

        self.assertIn('已绑定', query('om_bind_filter', binding['command'], True))
        for private in (False, True):
            for index, term in enumerate(('低库存', '库存不足')):
                text = query(f'om_low_filter_{private}_{index}', term, private)
                self.assertIn(secondary_code, text)
                self.assertNotIn(self.code, text)  # This primary part has zero stock.
                self.assertIn('找到 1 项物料', text)
            self.assertIn(secondary_code, query(f'om_secondary_{private}', '查询 ' + secondary_code, private))
            self.assertIn(self.code, query(f'om_zero_{private}', '查询 ' + self.code, private))
        self.request('movements', 'POST', {'type': '入库', 'part_id': secondary, 'qty': 4})
        self.assertIn('没有', query('om_at_minimum', '低库存'))

    def test_feishu_notifications_exclude_secondary_parts_and_keep_primary_zero_alerts(self):
        self.save(groups=[{'name': '通知群', 'chat_id': 'oc_project',
                           'notifications': list(feishu_bot.NOTIFICATIONS)}])
        secondary = self.request('parts', 'POST', {
            'name': '二级免通知物料', 'material_level': 2, 'min_stock': 50})['id']
        client = self.client()
        self.tick(client)
        self.assertEqual(client.send.call_count, 1)
        self.assertIn('库存 0 ', client.send.call_args.args[2])
        self.assertIn(self.code, client.send.call_args.args[2])
        self.request('movements', 'POST', {'type': '入库', 'part_id': secondary, 'qty': 10})
        out = self.request('movements', 'POST', {'type': '出库', 'part_id': secondary, 'qty': 2})['id']
        self.request('movements', 'POST', {'type': '退库', 'part_id': secondary, 'qty': 1, 'original_id': out})
        self.request('movements', 'POST', {'type': '报废', 'part_id': secondary, 'qty': 1, 'reason': '损坏'})
        with app.transaction() as db:
            feishu_bot.enqueue(db, 'movement', self.config, 'oc_project', {
                'part_id': secondary, 'project_id': self.project_id, 'movement_type': '入库',
                'text': '旧版排队的二级入库通知'}, job_id='old-secondary-movement')
            job_id = feishu_bot.enqueue(db, 'low_stock', self.config, 'oc_project',
                                        {'part_ids': [secondary]}, job_id='old-secondary-low')
            db.execute('INSERT INTO feishu_low_stock VALUES(?,?,?,?,?)',
                       (self.config['app_id'], self.project_id, 'oc_project', secondary, job_id))
        self.tick(client)
        self.assertEqual(client.send.call_count, 1)
        with app.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM feishu_low_stock WHERE part_id=?',
                                        (secondary,)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM feishu_jobs WHERE id LIKE 'old-secondary-%' AND status='ignored'").fetchone()[0], 2)
        self.move('入库', 3)
        self.move('出库', 2)
        self.tick(client)
        self.assertEqual(client.send.call_count, 4)  # Two primary movements and a renewed shortage.
        self.assertTrue(all(secondary not in call.args[2] for call in client.send.call_args_list))

    def test_feishu_private_query_binds_account_and_tracks_current_project_access(self):
        self.save()
        admin = self.cookie
        outside = self.request('projects', 'POST', {'name': '其他部门'})['id']
        self.request('parts', 'POST', {'name': '其他部门保密外壳'}, project=outside)
        account = {'name': '私聊成员', 'email': 'private@example.test', 'password': 'initial-password'}
        member = self.request('users', 'POST', account)['id']
        self.request('projects/' + self.project_id, 'PUT', {'members': [member], 'member_roles': {member: []}})
        self.request('auth/login', 'POST', account)
        self.request('account/password', 'POST', {'current_password': account['password'], 'password': 'member-updated'})
        member_cookie = self.cookie
        binding = self.request('account/feishu', 'POST', {}, project=False)
        self.assertFalse(binding['bound'])
        client = self.client()

        def private(id, text):
            event = self.event(id, chat_id='oc_private', text=text, chat_type='p2p', mentions=[])
            event['event']['message']['content'] = json.dumps({'text': text})
            event['event']['sender']['sender_id'] = {'open_id': 'ou_member'}
            self.deliver(event)
            self.tick(client)
            return client.send.call_args.args[2]

        self.assertIn('绑定码', private('om_unbound_private', '查询 测试'))
        client.send.side_effect = feishu_bot.FeishuError('绑定确认发送失败')
        self.assertIn('已绑定', private('om_bind_private', binding['command']))
        client.send.side_effect = None
        with app.transaction() as db:
            db.execute("UPDATE feishu_jobs SET next_at=0 WHERE id='cli_test:om_bind_private'")
        self.tick(client)
        self.assertIn('已绑定', client.send.call_args.args[2])
        self.assertTrue(self.request('account/feishu', project=False)['bound'])
        self.assertIn(self.code, private('om_bound_query', '查询 测试'))
        self.assertIn('未找到', private('om_private_denied', '查询 其他部门保密外壳'))
        self.assertIn('已过期', private('om_code_used_twice', binding['command']))
        self.cookie = admin
        self.request('projects/' + self.project_id, 'PUT', {'members': [], 'member_roles': {}})
        self.cookie = member_cookie
        self.assertIn('未找到', private('om_access_removed', '查询 测试'))
        self.assertFalse(self.request('account/feishu', 'DELETE', project=False)['bound'])
        self.assertIn('绑定码', private('om_after_unbind', '查询 测试'))
        self.assertEqual(self.request('settings/feishu', status=403, project=False)['error'], '需要管理员权限')

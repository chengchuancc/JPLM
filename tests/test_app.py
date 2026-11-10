"""真实 HTTP + 临时 SQLite 的业务集成测试，不写入正式 data 目录。"""
import sys, base64, concurrent.futures, importlib.util, io, json, tempfile, threading, unittest, urllib.request, urllib.error, zipfile, os
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
os.environ['PLM_QUIET']='1'
spec=importlib.util.spec_from_file_location('plm_app',Path(__file__).resolve().parents[1]/'server/app.py')
app=importlib.util.module_from_spec(spec); spec.loader.exec_module(app)

class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(); app.DATA=Path(cls.tmp.name); app.init_db()
        cls.server=app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
        cls.base='http://127.0.0.1:'+str(cls.server.server_port)
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join();cls.tmp.cleanup()
    def setUp(self):
        with app.transaction() as db:
            for table in reversed(app.shipping.TABLES): db.execute('DELETE FROM '+table)
            for table in reversed(app.inspection.TABLES): db.execute('DELETE FROM '+table)
            for t in reversed(app.TABLES): db.execute('DELETE FROM '+t)
            for table in ('sessions', 'activity', 'import_runs', 'project_covers', 'project_members', 'projects', 'users', 'settings'):
                db.execute('DELETE FROM ' + table)
        app.Handler.attempts.clear();self.cookie=''
        self.request('auth/setup','POST',{'password':'test-password-1234'})
        self.project_id = self.request('projects', 'POST', {'name': '测试项目'})['id']
        self.part=self.request('parts','POST',{'name':'测试物料','category':'电子物料','price':1.5,'unit':'个','min_stock':2})['id']
        self.code=self.state()['parts'][0]['code']
    def request(self,path,method='GET',data=None,status=200,headers=None,raw=False,project=None):
        resource = path.split('/', 1)[0].split('?', 1)[0]
        system = {'auth', 'account', 'users', 'reset-password', 'avatars', 'projects', 'backup', 'restore', 'resolve'}
        if project is not False and resource not in system and 'kind=login' not in path:
            path = 'projects/' + (project or self.project_id) + '/' + path
        h={'Content-Type':'application/json','Cookie':self.cookie};h.update(headers or {})
        req=urllib.request.Request(self.base+'/api/'+path,data=data if isinstance(data,bytes) else json.dumps(data).encode() if data is not None else None,headers=h,method=method)
        try: r=urllib.request.urlopen(req)
        except urllib.error.HTTPError as e:r=e
        self.assertEqual(r.status,status,(path,r.read().decode(errors='replace')) if r.status!=status else path)
        if r.headers.get('Set-Cookie'):self.cookie=r.headers['Set-Cookie'].split(';')[0]
        b=r.read();r.close();return b if raw else json.loads(b)
    def state(self):return self.request('state')
    def stock(self):return self.state()['parts'][0]['stock']
    def move(self,type,qty,**kw):return self.request('movements','POST',{'type':type,'part_id':self.part,'qty':qty,**kw})
    def supplier(self):return self.request('suppliers','POST',{'name':'测试供应商'})['id']
    def supplier_for(self, part_id):
        supplier_id = self.supplier()
        self.request('quotes', 'POST', {'part_id': part_id, 'supplier_id': supplier_id})
        return supplier_id
    def product(self,code='P-1'):return self.request('products','POST',{'name':'测试产品','code':code,'status':'研发中'})['id']
    def test_stock_lifecycle_and_history(self):
        self.move('入库',10);out=self.move('出库',4)['id'];self.move('退库',2,original_id=out);self.move('报废',1,reason='损坏')
        self.assertEqual(self.stock(),7);self.assertEqual([m['balance'] for m in self.state()['movements']],[10,6,8,7])

    def test_shipping_import_and_ledgers_keep_project_and_device_links(self):
        from urllib.parse import urlencode
        def upload(action, csv_text):
            boundary = 'shipping-boundary'
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="orders.csv"\r\n'
                    'Content-Type: text/csv\r\n\r\n').encode() + csv_text.encode() + f'\r\n--{boundary}--\r\n'.encode()
            return self.request('shipping/orders/' + action, 'POST', body,
                                headers={'Content-Type': 'multipart/form-data; boundary=' + boundary})
        csv_text = 'Backer Number,Shipping Name,Shipping Address 1,Shipping Postal Code\n88,Test Person,Example St,00123'
        self.assertEqual(upload('preview', csv_text)['added'], 1)
        self.assertEqual(self.request('shipping/orders')['total'], 0)
        self.assertEqual(upload('import', csv_text)['added'], 1)
        self.assertEqual(upload('import', csv_text)['unchanged'], 1)
        order = self.request('shipping/orders?q=88')['rows'][0]
        self.assertEqual(order['details']['postcode'], '00123')
        serial = '1234562611100001'
        self.request('inspection/devices', 'POST', {'serial': serial})
        other = self.request('projects', 'POST', {'name': '其他项目'})['id']
        self.assertEqual(self.request('shipping/orders', project=other)['total'], 0)
        self.assertEqual(self.request('shipping/devices?q=123456', project=other), [])
        first = {'channel': 'ks', 'ks_order_id': order['id'], 'devices': [serial, serial], 'tracking': '001'}
        self.request('shipping/records', 'POST', first, 404, project=other)
        self.request('shipping/records', 'POST', {**first, 'devices': ['UNREGISTERED']}, 404)
        ks = self.request('shipping/records', 'POST', first)
        self.request('shipping/records', 'POST', {'channel': 'other', 'reference': '#SP-1', 'devices': [serial],
                                                  'details': {'source': 'Shopify', 'base': 1}})
        rows = self.request('shipping/records?' + urlencode({'channel': 'ks', 'backer': '88'}))['rows']
        self.assertEqual([r['id'] for r in rows], [ks['id']])
        self.assertEqual([d['serial'] for d in rows[0]['devices']], [serial])
        self.assertEqual(self.request('shipping/records/' + ks['id']), rows[0])
        self.request('shipping/records/' + ks['id'], status=404, project=other)
        self.assertEqual([link['id'] for link in self.request('shipping/orders/' + order['id'])['shipment_links']], [ks['id']])
        self.request('shipping/orders/' + order['id'], status=404, project=other)
        self.assertEqual(self.request('shipping/orders?status=shipped')['rows'][0]['shipped'], 1)
        links = self.request('shipping/device-records?serial=' + serial)
        self.assertEqual(len(links), 2)
        self.assertIn(ks['id'], [link['id'] for link in links])
        self.assertEqual(self.request('inspection/device-inspections?serial=' + serial)['records'], [])
        for label in ('出厂检测', '复检'):
            form = self.request('inspection/templates', 'POST', {'name': label, 'serial_mode': 'text',
                                'fields': [{'key': 'note', 'label': '备注', 'type': 'text'}]})
            self.request('inspection/records', 'POST', {'template_id': form['id'], 'serial': serial,
                         'values': {'note': label}, 'revision': 1})
        inspection = self.request('inspection/device-inspections?serial=' + serial)
        self.assertEqual({row['form']['name'] for row in inspection['records']}, {'出厂检测', '复检'})
        self.assertEqual(self.request('inspection/device-inspections?serial=' + serial, project=other),
                         {'device': None, 'records': []})
        self.request('shipping/records/' + ks['id'], 'PUT', {**first, 'version': 'stale'}, 409)
        self.request('shipping/records/' + ks['id'], 'PUT', {**first, 'version': rows[0]['updated_at'], 'devices': []})
        self.assertEqual(len(self.request('shipping/device-records?serial=' + serial)), 1)
        self.assertEqual(self.request('shipping/records?channel=other&status=pending')['total'], 1)
        archive = self.request('backup', raw=True)
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            backup = directory / 'backup.zip'
            backup.write_bytes(archive)
            staged, _ = app.stage_restore(backup, directory)
            with app.connect(staged) as db:
                self.assertEqual(app.shipping.list_orders(db, self.project_id, {})['total'], 1)
                self.assertEqual(len(app.shipping.for_device(db, self.project_id, serial)), 1)

    def test_shipment_children_and_reversible_deletion(self):
        records = 'shipping/records'
        payload = {'channel': 'other', 'reference': '#PARENT'}
        parent = self.request(records, 'POST', payload)
        serial = '1234562611100001'
        self.request('inspection/devices', 'POST', {'serial': serial})
        child = self.request(records, 'POST', {**payload, 'parent_id': parent['id'], 'tracking': 'CHILD-TRACK',
                                               'devices': [serial], 'details': {'notes': '补发'}})
        parent_path = f"{records}/{parent['id']}"
        child_path = f"{records}/{child['id']}"
        self.assertEqual(child['parent_reference'], '#PARENT')
        roots = self.request(records + '?channel=other&roots=1')['rows']
        self.assertEqual([(r['id'], r['child_count']) for r in roots], [(parent['id'], 1)])
        self.assertEqual(self.request(parent_path + '/children'), [child])
        self.assertEqual(self.request(records + '?channel=other&q=CHILD-TRACK')['rows'], [child])
        other = self.request('projects', 'POST', {'name': '隔离项目'})['id']
        self.request(records, 'POST', {**payload, 'parent_id': parent['id']}, 404, project=other)
        self.request(records, 'POST', {'channel': 'ks', 'parent_id': parent['id']}, 404)
        self.request(parent_path + '/children', status=404, project=other)
        self.request(parent_path, 'PUT', {**payload, 'version': parent['updated_at'], 'parent_id': child['id']}, 400)
        self.request(parent_path, 'DELETE', {'version': parent['updated_at']}, 409)
        self.request(child_path, 'DELETE', {'version': 'stale'}, 409)
        self.request(child_path, 'DELETE', {'version': child['updated_at']})
        self.assertEqual(self.request(parent_path + '/children'), [])
        self.assertEqual(self.request('shipping/device-records?serial=' + serial), [])
        self.assertEqual(self.request(records + '?channel=other&q=CHILD-TRACK')['rows'], [])
        deleted = self.request(records + '?channel=other&deleted=1')['rows'][0]
        self.assertEqual((deleted['tracking'], deleted['details'], deleted['devices']),
                         (child['tracking'], child['details'], child['devices']))
        self.request(parent_path, 'DELETE', {'version': parent['updated_at']})
        self.request(child_path + '/restore', 'POST', {'version': deleted['updated_at']}, 404)
        archive = self.request('backup', raw=True)
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            backup = directory / 'backup.zip'
            backup.write_bytes(archive)
            staged, _ = app.stage_restore(backup, directory)
            with app.connect(staged) as db:
                self.assertEqual(app.shipping.get_shipment(db, self.project_id, child['id']), deleted)
        self.request(parent_path + '/restore', 'POST', {'version': self.request(parent_path)['updated_at']})
        self.request(child_path + '/restore', 'POST', {'version': deleted['updated_at']})
        restored = self.request(parent_path + '/children')[0]
        self.assertIsNone(restored['deleted_at'])
        self.assertEqual(self.request('shipping/device-records?serial=' + serial)[0]['id'], child['id'])
        self.request(child_path, 'PUT', {**payload, 'parent_id': None, 'version': restored['updated_at']})
        self.assertEqual(self.request(records + '?channel=other&roots=1')['total'], 2)

    def test_ks_shipment_uses_order_details_and_explicit_shipping_status(self):
        self.request('shipping/orders/paste', 'POST', {
            'clipboard': 'Backer Number\t收件人\t主机\t底座\n88\t订单收件人\t2\t1\n89\t另一个收件人\t1\t0',
        })
        order = self.request('shipping/orders?q=88')['rows'][0]
        other = self.request('shipping/orders?q=89')['rows'][0]
        payload = {'channel': 'ks', 'ks_order_id': order['id'], 'tracking': 'YT-TEST',
                   'details': {'name': '错误的收件人', 'main_unit': 10, 'shipment_status': 'pending'}}
        row = self.request('shipping/records', 'POST', payload)
        self.assertEqual(row['details'], {'shipment_status': 'pending'})
        self.assertEqual((row['order_details']['name'], row['order_details']['main_unit']), ('订单收件人', 2))
        self.assertEqual(self.request('shipping/orders?status=shipped')['total'], 0)
        self.assertEqual(self.request('shipping/records?channel=ks&status=pending')['total'], 1)
        path = 'shipping/records/' + row['id']
        self.request(path, 'PUT', {**payload, 'ks_order_id': other['id'], 'version': row['updated_at']}, 409)
        self.request('shipping/orders/' + order['id'], 'PUT', {'version': order['updated_at'],
                                                              'details': {'main_unit': 3}})
        self.assertEqual(self.request(path)['order_details']['main_unit'], 3)
        self.request(path, 'PUT', {**payload, 'reference': '改编号', 'version': row['updated_at'],
                                   'tracking': '', 'details': {'shipment_status': 'shipped'}})
        self.assertEqual(self.request(path)['reference'], row['reference'])
        self.assertEqual(self.request('shipping/orders?status=shipped')['total'], 1)
        self.assertEqual(self.request('shipping/records?channel=ks&status=shipped')['total'], 1)

    def test_global_shipping_groups_order_and_limits_shared_project_data(self):
        other = self.request('projects', 'POST', {'name': '配件项目'})['id']
        first = self.request('products', 'POST', {'name': '新主机'})['id']
        second = self.request('products', 'POST', {'name': '新配件'}, project=other)['id']
        line = lambda project, product, count: {'project_id': project, 'product_id': product, 'quantity': count}
        original = self.request('global-shipping/packages', 'POST', {
            'project_id': self.project_id, 'reference': '#ORDER-88', 'tracking': 'TRACK-88',
            'details': {'name': '机密收件人', 'address': '机密地址'},
            'shipment_items': [line(self.project_id, first, 1), line(other, second, 2)],
        }, project=False)
        self.request('shipping/records', 'POST', {
            'channel': 'other', 'reference': 'order-88', 'shipment_items': [line(other, second, 1)],
        }, project=other)
        self.request('shipping/orders/paste', 'POST', {'clipboard': 'Backer Number\t主机\n88\t1'})
        ks = self.request('shipping/orders?q=88')['rows'][0]
        self.request('shipping/records', 'POST', {'channel': 'ks', 'ks_order_id': ks['id']})
        global_list = 'global-shipping/orders'
        row = self.request(global_list + '?status=partial', project=False)['rows'][0]
        self.assertEqual((row['order_key'], row['package_count'], row['shipped_count']), ('order:order-88', 2, 1))
        self.assertEqual(self.request(global_list, project=False)['total'], 1)
        self.assertEqual(self.request(global_list + '?q=TRACK-88&project=' + other, project=False)['rows'][0]['package_count'], 2)
        self.request('shipping/records/' + original['id'], 'PUT', {
            'channel': 'other', 'reference': '#ORDER-88', 'tracking': 'TRACK-88', 'details': original['details'],
            'version': original['updated_at'], 'shipment_items': [line(self.project_id, first, 3)],
        })
        record = self.request('shipping/records/' + original['id'])
        self.assertEqual({p['name']: p['quantity'] for p in record['shipment_items']}, {'新主机': 3})
        complete = self.request('shipping/records/' + original['id'] + '?scope=global')
        self.assertEqual({p['name']: p['quantity'] for p in complete['shipment_items']}, {'新主机': 3, '新配件': 2})
        self.request('shipping/records', 'POST', {'channel': 'other', 'reference': '#OTHER',
                                                 'shipment_items': [line(other, second, 1)]}, 403)
        self.request('shipping/records', 'POST', {'channel': 'other', 'reference': '#BAD',
                                                 'shipment_items': [line(self.project_id, 'unknown', 1)]}, 404)
        account = {'name': '配件成员', 'email': 'shipping-member@example.test', 'password': 'member'}
        member = self.request('users', 'POST', account)['id']
        self.request('projects/' + other, 'PUT', {'members': [member]})
        self.request('auth/login', 'POST', account)
        self.request('account/password', 'POST', {'current_password': 'member', 'password': 'member'})
        packages = self.request(global_list, project=False)['rows'][0]['packages']
        visible = next(pack for pack in packages if pack['id'] == original['id'])
        self.assertFalse(visible['can_open'])
        self.assertEqual([p['name'] for p in visible['shipment_items']], ['新配件'])
        self.assertNotIn('details', visible)
        mirror = self.request('shipping/records?channel=other&record=' + original['id'], project=other)['rows'][0]
        self.assertTrue(mirror['shared'])
        self.assertNotIn('address', mirror['details'])
        self.assertEqual(mirror['shipment_items'][0]['product_id'], second)
        self.assertEqual(self.request('shipping/records/' + original['id'], project=other), mirror)
        path = 'shipping/records/' + original['id'] + '/shared-items'
        self.request(path, 'PUT', {'version': mirror['updated_at'],
                                   'shipment_items': [line(self.project_id, first, 99)]}, 403, project=other)
        self.request(path, 'PUT', {'version': mirror['updated_at'],
                                   'shipment_items': [line(other, second, 5)]}, project=other)
        self.request(path, 'PUT', {'version': mirror['updated_at'], 'shipment_items': []}, 409, project=other)
        packages = self.request(global_list, project=False)['rows'][0]['packages']
        updated = next(pack for pack in packages if pack['id'] == original['id'])
        self.assertEqual(updated['shipment_items'][0]['quantity'], 5)
        self.assertTrue(updated['shipped'])
        self.request('shipping/records/' + original['id'], status=404)

    def test_global_orders_keep_unknown_goods_and_locate_child_without_filtering(self):
        path = 'global-shipping/orders'
        payload = {'project_id': self.project_id, 'reference': '#LOCATE-1',
                   'details': {'name': '测试收件人', 'shipment_status': 'shipped'},
                   'shipment_items': [{'project_id': self.project_id, 'product_id': None,
                                       'name': '待确认配件', 'quantity': 2}]}
        root = self.request(path, 'POST', payload, project=False)
        line = root['shipment_items'][0]
        self.assertIsNone(line['product_id'])
        self.assertEqual(line['name'], '待确认配件')
        self.request(path, 'POST', {**payload, 'reference': 'locate-1'}, 409, project=False)
        child = self.request(path, 'POST', {**payload, 'reference': '#SUPPLEMENT-1', 'parent_id': root['id'],
                                           'shipment_items': []}, project=False)
        with app.transaction() as db:
            for i in range(53):
                app.shipping.save_shipment(db, self.project_id, app.uid(),
                    {'channel': 'other', 'reference': 'FILLER-' + str(i)}, app.now(), None)
        located = self.request(path + '?locate=' + child['id'], project=False)
        self.assertEqual((located['page'], located['total']), (2, 54))
        self.assertGreater(len(located['rows']), 1)
        group = next(r for r in located['rows'] if r['order_key'] == located['location']['order_key'])
        self.assertEqual({r['id'] for r in group['packages']}, {root['id'], child['id']})
        local = self.request('shipping/records?channel=other&roots=1&locate=' + child['id'])
        self.assertEqual((local['page'], local['total']), (2, 54))
        self.assertEqual(local['location']['ancestors'], [root['id']])
        self.assertIn(root['id'], [r['id'] for r in local['rows']])
        edit_path = path + '/' + self.project_id + '/' + root['id']
        edited = self.request(edit_path, 'PUT', {**payload, 'tracking': 'YT-TEST', 'version': root['updated_at'],
                                                'shipment_items': [line]}, project=False)
        self.assertEqual(edited['shipment_items'][0]['legacy_key'], line['legacy_key'])
        self.assertEqual(edited['tracking'], 'YT-TEST')
        self.request(edit_path, 'DELETE', {'version': edited['updated_at']}, 409, project=False)
        child_path = path + '/' + self.project_id + '/' + child['id']
        self.request(child_path, 'DELETE', {'version': child['updated_at']}, project=False)
        self.assertEqual(self.request('shipping/records?channel=other&deleted=1')['rows'][0]['id'], child['id'])

    def test_global_order_handling_projects_are_shared_without_product_lines(self):
        other = self.request('projects', 'POST', {'name': '协办项目'})['id']
        unrelated = self.request('projects', 'POST', {'name': '无关项目'})['id']
        path = 'global-shipping/orders'
        payload = {'project_id': self.project_id, 'reference': '#HANDLING', 'tracking': 'YT-HANDLING',
                   'details': {'name': '仅主项目可见'}, 'handling_project_ids': [self.project_id, other]}
        record = self.request(path, 'POST', payload, project=False)
        self.assertEqual(record['handling_project_ids'], [other])
        self.assertEqual(record['shipment_items'], [])
        for project in (self.project_id, other):
            result = self.request('shipping/records?channel=other', project=project)['rows']
            self.assertEqual([row['id'] for row in result], [record['id']])
        self.assertEqual(self.request('shipping/records?channel=other', project=unrelated)['total'], 0)
        archive = self.request('backup', raw=True)
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            backup = directory / 'backup.zip'
            backup.write_bytes(archive)
            staged, _ = app.stage_restore(backup, directory)
            with app.connect(staged) as db:
                self.assertEqual(app.shipping.handling_projects(db, self.project_id, record['id']), [other])
        admin = self.cookie
        account = {'name': '协办成员', 'email': 'handling@example.test', 'password': 'member'}
        member = self.request('users', 'POST', account)['id']
        self.request('projects/' + other, 'PUT', {'members': [member]})
        self.request('auth/login', 'POST', account)
        self.request('account/password', 'POST', {'current_password': 'member', 'password': 'member'})
        shared = self.request(path + '?project=' + other, project=False)['rows'][0]['packages'][0]
        self.assertEqual(shared['handling_project_ids'], [other])
        self.assertNotIn('details', shared)
        self.assertEqual(self.request('shipping/records/' + record['id'], project=other)['tracking'], 'YT-HANDLING')
        self.cookie = admin
        edit_path = path + '/' + self.project_id + '/' + record['id']
        updated = self.request(edit_path, 'PUT', {**payload, 'version': record['updated_at'],
                                                 'handling_project_ids': []}, project=False)
        self.assertEqual(updated['handling_project_ids'], [])
        self.assertEqual(self.request('shipping/records?channel=other', project=other)['total'], 0)

    def test_shipping_clipboard_paste_and_creation_order(self):
        paste = 'shipping/orders/paste'
        result = self.request(paste, 'POST', {
            'clipboard': 'Backer Number\tPostal Code\tNotes\n90\t00123\t"Line 1\nLine 2"\n80\t00000\tSecond',
        })
        self.assertEqual(result['added'], 2)
        self.assertEqual(self.request(paste, 'POST', {'clipboard': '90\t99999', 'columns': ['backer', 'postcode']})['added'], 0)
        self.request(paste, 'POST', {'clipboard': '70\tThird', 'columns': ['backer', 'name']})
        orders = self.request('shipping/orders')['rows']
        self.assertEqual([order['backer'] for order in orders], ['70', '90', '80'])
        first, second = orders[1:]
        self.assertEqual(first['details'], {'postcode': '00123', 'notes': 'Line 1\nLine 2'})
        target = lambda order: {'id': order['id'], 'backer': order['backer'], 'version': order['updated_at']}
        self.request(paste, 'POST', {'clipboard': '09100\n99999', 'columns': ['postcode'],
                                     'targets': [target(first), {**target(second), 'version': 'stale'}]}, 409)
        self.assertEqual(self.request('shipping/orders/' + first['id'])['details']['postcode'], '00123')
        self.request(paste, 'POST', {'clipboard': '09100\tChanged', 'columns': ['postcode', 'notes'],
                                     'targets': [target(first)]})
        updated = self.request('shipping/orders/' + first['id'])
        self.assertEqual(updated['created_at'], first['created_at'])
        self.assertEqual(updated['details'], {'postcode': '09100', 'notes': 'Changed'})
        cleared = self.request('shipping/orders/' + first['id'], 'PUT', {'version': updated['updated_at'],
                                                                       'details': {'notes': ''}})
        self.assertNotIn('notes', cleared['details'])
        for reference, shipped_on in (('older', '2030-12-31'), ('newer', '')):
            self.request('shipping/records', 'POST', {'channel': 'other', 'reference': reference, 'shipped_on': shipped_on})
        rows = self.request('shipping/records?channel=other')['rows']
        self.assertEqual([row['reference'] for row in rows], ['newer', 'older'])
        newest = rows[0]
        changed = self.request('shipping/records/' + newest['id'], 'PUT', {
            'channel': 'other', 'reference': newest['reference'], 'version': newest['updated_at'],
            'details': {'carrier': 'DHL、顺丰'},
        })
        self.assertEqual(changed['details']['carrier'], 'DHL、顺丰')
        self.request('shipping/records/' + newest['id'], 'PUT', {
            'channel': 'other', 'reference': newest['reference'], 'version': changed['updated_at'],
            'details': {'carrier': '顺丰'},
        })
        self.assertEqual(self.request('shipping/carriers'), ['DHL', '顺丰'])

    def test_inspection_templates_rules_and_project_permissions(self):
        config = {'name': '压力测试', 'serial_mode': 'dated', 'fields': [
            {'key': 'pressure', 'label': '压力', 'group': '性能', 'type': 'number', 'unit': 'kPa',
             'required': True, 'minimum': 2, 'maximum': 4},
            {'key': 'surface', 'label': '外观', 'type': 'choice', 'required': True,
             'options': ['正常', '划痕'], 'fail': ['划痕']},
        ]}
        created = self.request('inspection/templates', 'POST', config)
        template_id = created['id']
        serial1, serial2 = '0000012611100001', '0000012611100002'
        def entry(serial, values, version=None, revision=1):
            return {'serial': serial, 'template_id': template_id, 'values': values,
                    'version': version, 'revision': revision}
        partial = self.request('inspection/records', 'POST', entry(serial1, {'pressure': 2}))
        self.assertEqual(partial['result'], '未完成')
        self.assertEqual(partial['production_date'], '2026-11-10')
        self.request('inspection/records', 'POST', entry(serial1, {'pressure': 5}), 409)
        failed = self.request('inspection/records', 'POST', entry(serial1, {'pressure': 5}, partial['updated_at']))
        self.assertEqual(failed['result'], '不良')
        self.assertEqual(self.request('inspection/lookup?template='+template_id+'&serial='+serial2), {'record': None, 'device': None})
        passed = self.request('inspection/records', 'POST', entry(serial2, {'pressure': 4, 'surface': '正常'}))
        self.assertEqual(passed['result'], '合格')
        history = self.request('inspection/records?template='+template_id+'&prefix=000001')
        self.assertEqual({r['serial'] for r in history['records']}, {serial1, serial2})

        updated = self.request('inspection/templates/'+template_id, 'PUT', {
            **config, 'revision': 1, 'fields': [{**config['fields'][0], 'maximum': 3}],
        })
        self.assertEqual(updated['revision'], 2)
        original = self.request('inspection/lookup?template='+template_id+'&serial='+serial2)['record']
        self.assertEqual(original['form']['revision'], 1)
        self.assertIn('surface', original['values'])
        self.request('inspection/records', 'POST', entry('0000012611100003', {'pressure': 3}), 409)

        other = self.request('projects', 'POST', {'name': '另一项目'})['id']
        self.assertEqual(self.request('inspection/templates', project=other), [])
        self.request('inspection/records?template='+template_id, status=404, project=other)
        admin_cookie = self.cookie
        account = {'name':'检测员', 'email':'inspection@example.test','password':'inspector'}
        member = self.request('users', 'POST', account)['id']
        self.request('projects/'+self.project_id, 'PUT', {'members': [member]})
        self.request('auth/login', 'POST', account)
        self.request('account/password', 'POST', {'current_password':'inspector','password':'inspector'})
        self.request('inspection/templates', 'POST', config, 403)
        self.request('inspection/import-preview', 'POST', {}, 403)
        saved = self.request('inspection/records', 'POST', entry('0000012611100003', {'pressure': 3}, revision=2))
        self.assertEqual(saved['operator_name'], '检测员')
        self.cookie = admin_cookie
        self.request('projects/'+self.project_id, 'PUT', {'archived': True})
        self.request('inspection/records', 'POST', entry('0000012611100004', {'pressure': 3}, revision=2), 409)

    def test_inspection_linked_automatic_verdict_and_manual_measurement(self):
        fields = [
            {'key': 'voltage', 'label': '电压', 'group': '测量', 'block': '电源',
             'type': 'number', 'minimum': 3, 'maximum': 4},
            {'key': 'verdict', 'label': '电压判定', 'group': '测量', 'block': '电源',
             'type': 'choice', 'options': ['OK', 'NG'], 'fail': ['NG'],
             'auto_from': 'voltage', 'required': True},
            {'key': 'manual', 'label': '功能测试', 'group': '功能', 'type': 'multi',
             'display': 'dropdown', 'custom': True, 'required': True},
        ]
        config = {'name': '通用组合检测', 'serial_mode': 'text', 'fields': fields}
        self.request('inspection/templates', 'POST', {
            **config, 'fields': [fields[0], {**fields[1], 'block': '另一组'}, fields[2]],
        }, 400)
        template = self.request('inspection/templates', 'POST', config)
        self.assertEqual(template['fields'][2]['display'], 'dropdown')
        def save(serial, values, version=None):
            return self.request('inspection/records', 'POST', {
                'serial': serial, 'template_id': template['id'], 'revision': 1,
                'version': version, 'values': values,
            })
        pending = save('TEST-01', {'manual': ['通过'], 'verdict': 'OK'})
        self.assertEqual((pending['result'], pending['values']), ('未完成', {'manual': ['通过']}))
        passed = save('TEST-01', {'voltage': 3, 'manual': ['通过'], 'verdict': 'NG'}, pending['updated_at'])
        self.assertEqual((passed['result'], passed['values']['verdict']), ('合格', 'OK'))
        failed = save('TEST-02', {'voltage': 4.01, 'verdict': 'OK'})
        self.assertEqual((failed['result'], failed['values']['verdict']), ('不良', 'NG'))
        cleared = save('TEST-01', {'manual': ['通过'], 'verdict': 'OK'}, passed['updated_at'])
        self.assertEqual((cleared['result'], cleared['values']), ('未完成', {'manual': ['通过']}))

    def test_inspection_excel_and_csv_round_trip(self):
        from urllib.parse import urlencode
        from electronic_import import read_xlsx
        config = {'name':'通用出厂检测', 'serial_mode':'dated', 'fields': [
            {'key':'appearance', 'label':'外观检测', 'type':'multi', 'options':['正常','有划痕'],
             'fail':['有划痕'], 'required':True},
            {'key':'notes', 'label':'说明', 'type':'text'},
        ]}
        source = self.request('inspection/templates', 'POST', config)['id']
        target = self.request('inspection/templates', 'POST', {**config, 'name':'第二套检测表'})['id']
        code = '0000012611100001'
        self.request('inspection/records', 'POST', {
            'template_id':source, 'serial':code, 'revision':1, 'version':None,
            'values':{'appearance':['有划痕'],'notes':'=2+2'},
        })
        exported = self.request('inspection/export?template='+source, raw=True)
        _, _, worksheet = read_xlsx(exported)
        self.assertEqual(worksheet[1][1][0], code)
        self.assertIn('=2+2', worksheet[1][1])
        csv_bytes = self.request('inspection/export?'+urlencode({'template':source,'format':'csv'}), raw=True)
        self.assertIn("'=2+2", csv_bytes.decode('utf-8-sig'))

        def upload(resource, payload, filename, form_id, revision=None):
            fields = {'template': form_id}
            if revision is not None: fields['revision'] = str(revision)
            body = b''.join(
                f'--inspection-boundary\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
                for name, value in fields.items()
            )
            body += (f'--inspection-boundary\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                     'Content-Type: application/octet-stream\r\n\r\n').encode() + payload + b'\r\n--inspection-boundary--\r\n'
            return self.request('inspection/'+resource, 'POST', body,
                                headers={'Content-Type':'multipart/form-data; boundary=inspection-boundary'})
        preview = upload('import-preview', exported, 'inspection.xlsx', target)
        self.assertEqual((preview['ready'], preview['duplicates']), (1, 0))
        self.assertEqual(self.request('inspection/records?template='+target)['total'], 0)
        imported = upload('import', exported, 'inspection.xlsx', target, preview['revision'])
        self.assertEqual(imported['ready'], 1)
        again = upload('import-preview', csv_bytes, 'inspection.csv', target)
        self.assertEqual((again['ready'], again['duplicates']), (0, 1))
        row = self.request('inspection/lookup?template='+target+'&serial='+code)['record']
        self.assertEqual((row['result'], row['values']), ('不良', {'appearance':['有划痕'],'notes':'=2+2'}))

    def test_inspection_device_registration_and_record_lifecycle(self):
        from urllib.parse import urlencode
        code = 'ABC123-0001'
        self.assertEqual(self.request('inspection/templates'), [])
        first = self.request('inspection/devices', 'POST', {'serial': code})
        self.assertTrue(first['created'])
        self.assertFalse(self.request('inspection/devices', 'POST', {'serial': code})['created'])
        self.assertEqual(self.request('inspection/devices?prefix=ABC123')['devices'][0]['records'], 0)
        second_project = self.request('projects', 'POST', {'name': '隔离项目'})['id']
        self.assertEqual(self.request('inspection/devices', project=second_project)['total'], 0)
        template = self.request('inspection/templates', 'POST', {
            'name': '通用检查', 'serial_mode': 'text',
            'fields': [{'key': 'issues', 'label': '发现问题', 'type': 'multi', 'custom': True}],
        })['id']
        entry = {'template_id': template, 'serial': code, 'revision': 1, 'version': None,
                 'values': {'issues': ['边角毛刺']}}
        record = self.request('inspection/records', 'POST', entry)
        latest = self.request('inspection/latest?template='+template+'&prefix=ABC123')['record']
        self.assertEqual(latest['id'], record['id'])
        self.assertEqual(self.request('inspection/devices')['devices'][0]['records'], 1)
        option_path = 'inspection/options?template='+template
        self.assertEqual(self.request(option_path)[0]['value'], '边角毛刺')
        self.request('inspection/options', 'PUT', {
            'template_id': template, 'field_key': 'issues', 'value': '边角毛刺', 'hidden': True,
        })
        self.assertTrue(self.request(option_path)[0]['hidden_at'])
        route = 'inspection/records/' + record['id']
        self.request(route, 'DELETE', status=404, project=second_project)
        self.request(route, 'DELETE')
        self.assertEqual(self.request('inspection/devices')['devices'][0]['records'], 0)
        self.assertEqual(self.request('inspection/records?template='+template)['total'], 0)
        self.assertEqual(self.request('inspection/records?template='+template+'&deleted=1')['total'], 1)
        self.request('inspection/records', 'POST', entry, 409)
        self.request(route+'/recover', 'POST')
        self.assertEqual(self.request('inspection/devices')['devices'][0]['records'], 1)
        query = urlencode({'template': template, 'keyword': '毛刺'})
        self.assertEqual(self.request('inspection/records?'+query)['total'], 1)
    def test_insufficient_stock_and_invalid_qty(self):
        for qty in (-1,0,'NaN','Infinity',1e12): self.request('movements','POST',{'type':'入库','part_id':self.part,'qty':qty},400)
        self.request('movements','POST',{'type':'出库','part_id':self.part,'qty':1},400)
        self.assertEqual(self.stock(),0);self.assertEqual(len(self.state()['movements']),0)
    def test_return_limits_and_scrap_reason(self):
        self.move('入库',5);out=self.move('出库',3)['id'];self.move('退库',2,original_id=out)
        self.request('movements','POST',{'type':'退库','part_id':self.part,'qty':2,'original_id':out},400)
        self.request('movements','POST',{'type':'退库','part_id':self.part,'qty':1},400)
        self.request('movements','POST',{'type':'报废','part_id':self.part,'qty':1},400)
        self.assertEqual(self.stock(),4)
    def test_partial_purchase_receipts(self):
        po=self.request('purchases','POST',{'supplier_id':self.supplier_for(self.part),'date':'2026-11-06','lines':[{'part_id':self.part,'qty':10,'price':2}]})['id']
        line=self.state()['purchase_lines'][0]['id'];self.move('入库',4,purchase_line_id=line)
        self.assertEqual(self.state()['purchase_lines'][0]['received'],4)
        self.request('movements','POST',{'type':'入库','part_id':self.part,'qty':7,'purchase_line_id':line},400)
        self.assertEqual(self.stock(),4);self.move('入库',6,purchase_line_id=line)
        self.assertEqual(self.state()['purchase_lines'][0]['received'],10)
        self.assertEqual(self.stock(),10)
    def test_supplier_links_allow_multiple_records_without_prices(self):
        first, second = self.supplier(), self.supplier()
        other_part = self.request('parts', 'POST', {'name': '另一个物料'})['id']
        priced = {'part_id': self.part, 'supplier_id': first, 'price': 0, 'url': 'https://example.com/item'}
        existing = self.request('quotes', 'POST', priced)['id']
        self.assertEqual(self.state()['quotes'], [{'id': existing, 'project_id': self.project_id, **priced}])
        unpriced = self.request('quotes', 'POST', {'part_id': self.part, 'supplier_id': second})['id']
        self.request('quotes', 'POST', {'part_id': other_part, 'supplier_id': first})
        links = self.state()['quotes']
        self.assertEqual({q['supplier_id'] for q in links if q['part_id'] == self.part}, {first, second})
        self.assertEqual({q['part_id'] for q in links if q['supplier_id'] == first}, {self.part, other_part})
        self.assertIsNone(next(q for q in links if q['id'] == unpriced)['price'])
        edit = self.request('quotes', 'POST', {**priced, 'price': ''})
        self.assertEqual(edit['id'], existing)
        self.assertIsNone(next(q for q in self.state()['quotes'] if q['id'] == existing)['price'])
        self.request('quotes/' + unpriced, 'DELETE', {})
        self.assertEqual(len(self.state()['quotes']), 2)

    def test_material_form_supplier_changes_are_atomic_and_keep_existing_quotes(self):
        supplier = self.supplier()
        material = self.request('parts', 'POST', {
            'name': '物料表单供应商测试',
            'supplier_changes': {'add': [supplier], 'create': ['表单新供应商']},
        })['id']
        state = self.state()
        new_supplier = next(s['id'] for s in state['suppliers'] if s['name'] == '表单新供应商')
        self.assertEqual({q['supplier_id'] for q in state['quotes'] if q['part_id'] == material}, {supplier, new_supplier})
        quote = self.request('quotes', 'POST', {'part_id': material, 'supplier_id': supplier,
                                               'price': 3, 'url': 'https://example.test/item'})['id']
        self.request('parts/' + material, 'PUT', {'supplier_changes': {
            'add': [supplier, supplier], 'create': ['表单新供应商'],
        }})
        self.request('parts/' + material, 'PUT', {'notes': '保留关联'})
        state = self.state()
        self.assertEqual([s['id'] for s in state['suppliers'] if s['name'] == '表单新供应商'], [new_supplier])
        row = next(q for q in state['quotes'] if q['id'] == quote)
        self.assertEqual((row['price'], row['url']), (3, 'https://example.test/item'))
        other_project = self.request('projects', 'POST', {'name': '隔离供应商'})['id']
        foreign = self.request('suppliers', 'POST', {'name': '异项目供应商'}, project=other_project)['id']
        self.request('parts/' + material, 'PUT', {'notes': '应当回滚', 'supplier_changes': {
            'add': [foreign], 'remove': [supplier], 'create': ['应当回滚的供应商'],
        }}, 404)
        state = self.state()
        self.assertEqual(next(p['notes'] for p in state['parts'] if p['id'] == material), '保留关联')
        self.assertNotIn('应当回滚的供应商', [s['name'] for s in state['suppliers']])
        self.request('parts/' + material, 'PUT', {'supplier_changes': {'remove': [new_supplier]}})
        state = self.state()
        self.assertEqual([q['id'] for q in state['quotes'] if q['part_id'] == material], [quote])
        self.assertIn(new_supplier, [s['id'] for s in state['suppliers']])

    def test_accounts_record_responsibility_and_reject_privilege_escalation(self):
        admin_cookie = self.cookie
        account = {'name': '经办测试', 'email': 'operator@example.test', 'password': 'temporary-1234'}
        member = self.request('users', 'POST', account)['id']
        self.request('projects/' + self.project_id, 'PUT', {'members': [member]})
        self.request('users', 'POST', {**account, 'email': 'OPERATOR@example.test'}, 409)
        self.request('auth/login', 'POST', account)
        self.request('state', status=403)
        self.request('account/password', 'POST', {'current_password': account['password'], 'password': 'replacement-1234'})
        member_cookie = self.cookie
        self.request('users', 'POST', {**account, 'email': 'other@example.test'}, 403)
        self.request('account/profile', 'PUT', {'email': 'modified@example.test'}, 403)
        self.request('account/profile', 'PUT', {'phone': '13500000000'})
        user = self.request('auth/status')['user']
        self.assertEqual(user['email'], account['email'])
        self.assertEqual(user['phone'], '13500000000')
        self.assertNotIn('password', user)
        product = self.request('products', 'POST', {'name': '责任人测试', 'manager_id': member})['id']
        self.request('parts/' + self.part, 'PUT', {'custodian_id': member})
        admin = next(row['id'] for row in self.state()['users'] if row['id'] != member)
        self.move('入库', 2, handler_id=admin)
        stock = self.state()
        self.assertEqual(stock['products'][0]['manager_id'], member)
        self.assertEqual(stock['parts'][0]['custodian_id'], member)
        self.assertEqual(stock['movements'][0]['handler_id'], admin)
        activity = self.request('activity?part=' + self.part)['items']
        self.assertEqual(activity[0]['action'], '入库')
        self.assertEqual(activity[0]['actor_name'], account['name'])
        self.assertIn('经办人 管理员', activity[0]['detail'])
        self.request('backup', status=403)
        self.cookie = admin_cookie
        self.request('reset-password/' + member, 'POST', {'password': 'another-temporary-1234'})
        self.cookie = member_cookie
        self.request('state', status=401)

    def test_short_and_long_passwords_and_reusing_current_password(self):
        admin_cookie = self.cookie
        account = {'name': '口令测试', 'email': 'password@example.test', 'password': '甲'}
        member = self.request('users', 'POST', account)['id']
        self.request('projects/' + self.project_id, 'PUT', {'members': [member]})
        self.request('auth/login', 'POST', account)
        self.request('account/password', 'POST', {'current_password': '甲', 'password': '甲'})
        self.assertFalse(self.request('auth/status')['user']['must_change'])
        self.request('account/password', 'POST', {'current_password': '错', 'password': '甲'}, 400)
        self.request('account/password', 'POST', {'current_password': '甲', 'password': ''}, 400)
        self.cookie = admin_cookie
        long_password = '乙' * 300
        self.request('reset-password/' + member, 'POST', {'password': long_password})
        self.request('auth/login', 'POST', {**account, 'password': long_password})
        self.request('account/password', 'POST', {'current_password': long_password, 'password': long_password})
        self.assertEqual(self.request('auth/status')['user']['id'], member)
        self.request('state')

    def test_zip_restore_validates_and_restores_attachments_and_revokes_sessions(self):
        fid = self.upload('test.txt', b'backup contents')['ids'][0]
        archive = self.request('backup', raw=True)
        self.request('parts', 'POST', {'name': '恢复后消失'})
        headers = {'Content-Type': 'application/zip', 'X-PLM-Restore': 'replace'}
        self.request('restore', 'POST', b'invalid zip', 400, headers)
        self.assertEqual(len(self.state()['parts']), 2)
        self.request('restore', 'POST', archive, 200, headers)
        self.request('state', status=401)
        self.request('auth/login', 'POST', {'email': 'admin@localhost', 'password': 'test-password-1234'})
        self.assertEqual(len(self.state()['parts']), 1)
        restored = self.state()['files'][0]['id']
        self.assertEqual((app.DATA / 'uploads' / restored).read_bytes(), b'backup contents')
        self.assertFalse((app.DATA / 'uploads' / fid).exists())
        self.assertTrue((app.DATA / 'before-restore.zip').is_file())
        self.assertEqual(self.request('activity', project=False)['items'][0]['action'], '恢复备份')

    def test_purchase_creation_rolls_back(self):
        self.request('purchases','POST',{'supplier_id':self.supplier_for(self.part),'date':'2026-11-06','lines':[{'part_id':self.part,'qty':2,'price':1},{'part_id':self.part,'qty':2,'price':1}]},409)
        self.assertEqual(self.state()['purchases'],[]);self.assertEqual(self.state()['purchase_lines'],[])
    def test_purchase_supplier_must_supply_all_selected_parts(self):
        supplier_id = self.supplier_for(self.part)
        other_part = self.request('parts', 'POST', {'name': '采购物料二'})['id']
        order = {'supplier_id': supplier_id, 'date': '2026-11-09',
                 'lines': [{'part_id': part, 'qty': 2, 'price': 1} for part in (self.part, other_part)]}
        self.request('purchases', 'POST', order, 409)
        self.assertEqual(self.state()['purchases'], [])
        self.assertEqual(self.state()['purchase_lines'], [])
        self.request('quotes', 'POST', {'part_id': other_part, 'supplier_id': supplier_id})
        self.request('purchases', 'POST', order)
        self.assertEqual(len(self.state()['purchase_lines']), 2)
    def test_delete_product_with_bom_keeps_shared_material_code_and_stock(self):
        product = self.request('products', 'POST', {'name': '产品A', 'english_code': 'AQUAMIX'})['id']
        other = self.request('products', 'POST', {'name': '产品B'})['id']
        versions = {v['product_id']: v['id'] for v in self.state()['bom_versions']}
        part = self.request('bom-materials', 'POST', {'name': '共享物料', 'version_id': versions[product]})['id']
        code = next(p['code'] for p in self.state()['parts'] if p['id'] == part)
        self.request('bom-versions', 'POST', {'product_id': product, 'copy_from': versions[product]})
        line = self.request('bom-lines', 'POST', {'version_id': versions[other], 'part_id': part, 'qty': 2})['id']
        self.request('movements', 'POST', {'type': '入库', 'part_id': part, 'qty': 3})
        self.request('products/' + product, 'DELETE', {'password': 'test-password-1234'}, 409)
        self.assertEqual(len(self.state()['bom_lines']), 3)
        self.request('products/' + product, 'DELETE', {'delete_bom': True, 'password': 'test-password-1234'})
        state = self.state()
        self.assertEqual([p['id'] for p in state['products']], [other])
        self.assertEqual([v['id'] for v in state['bom_versions']], [versions[other]])
        self.assertEqual([l['id'] for l in state['bom_lines']], [line])
        material = next(p for p in state['parts'] if p['id'] == part)
        self.assertEqual((material['code'], material['stock'], material['numbering_product_id']), (code, 3, None))

    def test_product_deletion_requires_the_signed_in_administrators_password(self):
        product = self.product()
        self.request('products/' + product, 'DELETE', {}, 400)
        self.request('products/' + product, 'DELETE', {'password': 'wrong'}, 403)
        admin_cookie = self.cookie
        member = {'name': '成员', 'email': 'member@example.test', 'password': 'member-pass'}
        member_id = self.request('users', 'POST', member)['id']
        self.request('projects/' + self.project_id, 'PUT', {'members': [member_id]})
        self.request('auth/login', 'POST', member)
        self.request('account/password', 'POST', {'current_password': member['password'], 'password': member['password']})
        self.request('products/' + product, 'DELETE', {'password': 'test-password-1234'}, 403)
        self.assertEqual([p['id'] for p in self.state()['products']], [product])
        own_logins = self.request('activity?kind=login')['items']
        self.assertEqual([(row['actor_name'], row['action']) for row in own_logins], [('成员', '登录')])
        self.assertFalse(any(row['action'] == '登录' for row in self.request('activity')['items']))
        self.request('auth/logout', 'POST', {})
        self.cookie = admin_cookie
        self.assertEqual([row['action'] for row in self.request('activity?kind=login')['items']],
                         ['退出登录', '登录', '登录'])
        self.request('products/' + product, 'DELETE', {'password': 'test-password-1234'})

    def test_product_with_stock_history_must_be_archived(self):
        product = self.product()
        self.move('入库', 2)
        movement = self.move('出库', 1, product_id=product)['id']
        self.request('products/' + product, 'DELETE', {'delete_bom': True, 'password': 'test-password-1234'}, 409)
        self.assertEqual(self.state()['products'][0]['id'], product)
        self.assertEqual(self.state()['movements'][-1]['id'], movement)

    def test_bom_version_and_atomic_import(self):
        p=self.product();v=self.state()['bom_versions'][0]['id']
        self.request('bom-lines','POST',{'version_id':v,'part_id':self.part,'qty':2})
        v2=self.request('bom-versions','POST',{'product_id':p,'name':'V1.1','copy_from':v})['id']
        self.request('bom-import','POST',{'version_id':v2,'rows':[{'code':self.code,'qty':5},{'code':'NO-PART','qty':1}]},400)
        self.assertEqual([l['qty'] for l in self.state()['bom_lines']],[2,2])
        self.request('bom-import','POST',{'version_id':v2,'rows':[{'code':self.code,'qty':5}]})
        self.assertEqual([l['qty'] for l in self.state()['bom_lines']],[2,5])
    def test_sub_bom_relationship_is_not_supported(self):
        p=self.product()
        self.request('parts','POST',{'name':'组件','sub_product_id':p},400)
        self.request('parts/'+self.part,'PUT',{'sub_product_id':p},400)
        self.assertEqual(len(self.state()['parts']),1)
    def test_name_only_creation_and_automatic_codes(self):
        product=self.request('products','POST',{'name':'新产品'})['id']
        a=self.request('parts','POST',{'name':'螺钉'})['id']
        b=self.request('parts','POST',{'name':'电容','material_level':2})['id']
        state=self.state();m=next(x for x in state['parts'] if x['id']==a)
        self.assertEqual(m['unit'],'PCS');self.assertEqual(m['spec'],'');self.assertEqual(m['material_level'],1)
        self.assertEqual(next(x for x in state['parts'] if x['id']==b)['material_level'],2)
        self.assertEqual(len({x['code'] for x in state['parts']}),3)
        self.assertRegex(m['code'],r'^CM11[0-9]{4}$')
        self.assertEqual(len([v for v in state['bom_versions'] if v['product_id']==product]),1)
    def test_inline_updates_preserve_other_fields_and_codes(self):
        self.move('入库',7)
        self.request('parts/'+self.part,'PUT',{'spec':'0603'})
        self.request('parts/'+self.part,'PUT',{'unit':''})
        self.request('parts/'+self.part,'PUT',{'code':'MANUAL-CODE','material_level':2})
        p=self.state()['parts'][0]
        self.assertEqual(p['name'],'测试物料');self.assertEqual(p['stock'],7)
        self.assertEqual(p['price'],1.5);self.assertEqual(p['min_stock'],2)
        self.assertEqual(p['spec'],'0603');self.assertEqual(p['unit'],'PCS');self.assertEqual(p['material_level'],2);self.assertRegex(p['code'],r'^CM22[0-9]{4}$');self.assertNotEqual(p['code'],self.code)
        self.request('parts/'+self.part,'PUT',{'material_level':3},400)
        self.assertEqual(self.state()['parts'][0]['material_level'],2)
    def test_create_material_inside_bom_is_atomic(self):
        p=self.product();v=self.state()['bom_versions'][0]['id']
        created=self.request('bom-materials','POST',{'name':'电容','material_level':2,'version_id':v})
        state=self.state();material=next(p for p in state['parts'] if p['id']==created['id'])
        line=next(l for l in state['bom_lines'] if l['id']==created['line_id'])
        self.assertEqual(material['material_level'],2);self.assertEqual(material['unit'],'PCS');self.assertEqual(line['qty'],1)
        self.assertEqual(line['part_id'],material['id'])
        self.request('bom-lines/'+line['id'],'PUT',{'qty':12})
        self.assertEqual(self.state()['bom_lines'][0]['qty'],12)
        self.request('bom-materials','POST',{'name':'不会留下半成品','material_level':1,'version_id':v,'qty':0},400)
        self.assertEqual(len(self.state()['parts']),2)
        self.assertEqual(len(self.state()['bom_lines']),1)
    def test_versions_are_numbered_automatically(self):
        p=self.product();v=self.state()['bom_versions'][0]['id']
        self.request('bom-versions','POST',{'product_id':p,'copy_from':v})
        self.request('bom-versions','POST',{'product_id':p,'copy_from':v})
        self.assertEqual([v['name'] for v in self.state()['bom_versions']],['V1.0','V2.0','V3.0'])
    def test_fractional_quantity(self):
        self.move('入库',0.3);self.move('出库',0.1);self.move('出库',0.2);self.assertEqual(self.stock(),0)
    def test_concurrent_outbound_is_atomic(self):
        self.move('入库',10)
        def take(_):
            req=urllib.request.Request(self.base+'/api/projects/'+self.project_id+'/movements',data=json.dumps({'type':'出库','part_id':self.part,'qty':1}).encode(),headers={'Cookie':self.cookie,'Content-Type':'application/json'})
            try:
                with urllib.request.urlopen(req) as response:return response.status
            except urllib.error.HTTPError as e:
                code=e.code;e.close();return code
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool: codes=list(pool.map(take,range(16)))
        self.assertEqual(codes.count(200),10);self.assertEqual(codes.count(400),6);self.assertEqual(self.stock(),0)
    def upload(self,name,blob,replace=None,status=200):
        boundary='plm-test-boundary';fields={'owner_type':'parts','owner_id':self.part}
        if replace:fields['replace_id']=replace
        b=b''
        for k,v in fields.items():b+=f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        b+=f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+blob+f'\r\n--{boundary}--\r\n'.encode()
        return self.request('files','POST',b,status,{'Content-Type':'multipart/form-data; boundary='+boundary})
    def test_files_replace_and_backup(self):
        fid=self.upload('spec.txt',b'hello')['ids'][0]
        fid2=self.upload('spec-v2.txt',b'updated',fid)['ids'][0]
        self.assertEqual(len(self.state()['files']),1)
        b=self.request('backup',raw=True)
        with zipfile.ZipFile(io.BytesIO(b)) as z:self.assertEqual(z.read('uploads/'+fid2),b'updated');self.assertIn('plm.sqlite3',z.namelist())
        self.request('files/'+fid2,'DELETE',{})
        self.assertEqual(len(self.state()['files']),0)
    def test_valid_image_upload_and_private_download(self):
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0i8AAAAASUVORK5CYII=')
        fid=self.upload('image.png',png)['ids'][0]
        request=urllib.request.Request(self.base+'/files/'+fid,headers={'Cookie':self.cookie})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.headers['Content-Type'],'image/png');self.assertEqual(response.read(),png)
        try:urllib.request.urlopen(self.base+'/files/'+fid)
        except urllib.error.HTTPError as e:self.assertEqual(e.code,401);e.close()
        else:self.fail('Private image exposed without authentication')
        self.request('files/'+fid,'DELETE',{})
        self.assertFalse((app.DATA/'uploads'/fid).exists())
    def test_file_names_follow_material_and_keep_replacement_order(self):
        from urllib.parse import unquote
        png = b'\x89PNG\r\n\x1a\n' + b'picture'
        image = self.upload('screenshot.PNG', png)['ids'][0]
        attachment = self.upload('manufacturer-v2.pdf', b'%PDF-1.4')['ids'][0]
        name = self.state()['parts'][0]['name']
        files = {f['id']: f for f in self.state()['files']}
        self.assertEqual(files[image]['name'], f'{self.code} {name}（01）.png')
        self.assertEqual(files[attachment]['name'], f'{self.code} {name}（02）.pdf')
        self.assertEqual(files[attachment]['original_name'], 'manufacturer-v2.pdf')
        replacement = self.upload('new.png', png, image)['ids'][0]
        self.assertFalse((app.DATA / 'uploads' / image).exists())
        self.request('parts/' + self.part, 'PUT', {'name': '控制板 / V2', 'category': '结构物料'})
        code = self.state()['parts'][0]['code']
        self.assertNotEqual(code, self.code)
        files = {f['id']: f for f in self.state()['files']}
        self.assertEqual(files[replacement]['name'], f'{code} 控制板 V2（01）.png')
        self.assertEqual(files[attachment]['name'], f'{code} 控制板 V2（02）.pdf')
        request = urllib.request.Request(self.base + '/files/' + attachment, headers={'Cookie': self.cookie})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(unquote(response.headers['Content-Disposition'].split("''", 1)[1]), files[attachment]['name'])
            self.assertEqual(response.read(), b'%PDF-1.4')

    def test_automatic_cleanup_limits_removal_to_old_unreferenced_images(self):
        png = b'\x89PNG\r\n\x1a\n' + b'picture'
        upload_dir = app.DATA / 'uploads'
        referenced = upload_dir / self.upload('linked.png', png)['ids'][0]
        orphan, recent, document, unmanaged, symlink = [
            upload_dir / name for name in (app.uid(), app.uid(), app.uid(), 'manual.png', app.uid())
        ]
        for file in (orphan, recent, unmanaged):
            file.write_bytes(png)
        document.write_bytes(b'%PDF-1.4')
        symlink.symlink_to(unmanaged)
        stale_time = 1
        for file in (referenced, orphan, document, unmanaged):
            os.utime(file, (stale_time, stale_time))
        self.assertEqual(app.cleanup_orphan_images(), 1)
        self.assertFalse(orphan.exists())
        for file in (referenced, recent, document, unmanaged, symlink):
            self.assertTrue(file.exists(), file.name)
        self.assertEqual(app.cleanup_orphan_images(), 0)

    def test_invalid_image_is_rejected(self):
        self.upload('bad.png',b'<script>bad</script>',status=400)
        self.assertEqual(self.state()['files'],[])
    def test_auth_logout_and_csrf(self):
        self.request('parts','POST',{'name':'hack'},403,{'Origin':'https://evil.test'})
        self.request('auth/setup','POST',{'password':'another-password'},409)
        self.request('auth/logout','POST',{})
        self.request('state',status=401)
        self.request('auth/login','POST',{'email':'admin@localhost','password':'wrong'},401)
        self.request('auth/login','POST',{'email':'admin@localhost','password':'test-password-1234'})
        self.request('state')
    def test_material_with_stock_and_references_can_be_deleted_and_restored(self):
        self.product()
        version = self.state()['bom_versions'][0]['id']
        self.request('bom-lines', 'POST', {'part_id': self.part, 'version_id': version, 'qty': 2})
        self.request('purchases', 'POST', {'supplier_id': self.supplier_for(self.part), 'date': '2026-11-06',
                     'lines': [{'part_id': self.part, 'qty': 2, 'price': 1}]})
        self.move('入库', 1)
        self.request('parts/' + self.part, 'DELETE', {})
        state = self.state()
        self.assertEqual(state['parts'], [])
        self.assertEqual(state['deleted_parts'][0]['stock'], 1)
        for table in ('movements', 'bom_lines', 'purchase_lines'):
            self.assertEqual(state[table][0]['part_id'], self.part)
        self.request('movements', 'POST', {'type': '出库', 'part_id': self.part, 'qty': 1}, 409)
        self.request('deleted-parts/' + self.part, 'PUT', {})
        self.assertEqual(self.state()['deleted_parts'], [])
        self.assertEqual(self.stock(), 1)
    def test_demo_is_explicit_and_only_empty_db(self):
        self.request('demo','POST',{},400)
        with app.transaction() as db:db.execute('DELETE FROM parts')
        self.request('demo','POST',{})
        s=self.state();self.assertEqual(len(s['products']),4);self.assertEqual(len(s['parts']),8);self.assertEqual(len(s['movements']),10)
        self.request('demo','POST',{},400)

    def test_project_isolation_references_and_archive(self):
        other = self.request('projects', 'POST', {'name': '项目乙'})['id']
        first_product = self.request('products', 'POST', {'name': '甲产品', 'english_code': 'SAME'})['id']
        self.request('products', 'POST', {'name': '乙产品', 'english_code': 'SAME'}, project=other)
        other_part = self.request('parts', 'POST', {'name': '测试物料', 'material_level': 2}, project=other)['id']
        self.request('parts', 'POST', {'name': '串账物料', 'numbering_product_id': first_product},
                     status=404, project=other)
        self.move('入库', 10)
        self.request('movements', 'POST', {'type': '入库', 'part_id': self.part, 'qty': 1},
                     status=404, project=other)
        self.request('movements', 'POST', {'type': '入库', 'part_id': other_part, 'qty': 3}, project=other)
        self.assertEqual(self.stock(), 10)
        self.assertEqual(self.request('state', project=other)['parts'][0]['stock'], 3)
        self.assertNotEqual(self.code[-4:], self.request('state', project=other)['parts'][0]['code'][-4:])
        version = self.state()['bom_versions'][0]['id']
        with self.assertRaises(app.sqlite3.IntegrityError), app.transaction() as db:
            db.project_id = self.project_id
            app.insert_bom_line(db, version, other_part, 1)
        self.request('bom-lines', 'POST', {'version_id': version, 'part_id': other_part, 'qty': 1}, 404)
        supplier = self.supplier()
        self.request('quotes', 'POST', {'part_id': other_part, 'supplier_id': supplier}, 404, project=other)
        self.request('state', status=404, project=False)
        self.request('parts', 'POST', {'name': '绕过项目'}, 404, project=False)

        # Matching and retry keys are independent even when files have identical rows.
        payload = {'request_id': 'repeat-in-projects-001', 'rows': [{'name': '复用测试', 'qty': 1}]}
        for project in (self.project_id, other):
            result = self.request('electronic-import/commit', 'POST', payload, project=project)
            self.assertEqual(result['created'], 1)
        self.request('projects/' + other, 'PUT', {'archived': True})
        self.assertTrue(self.request('state', project=other)['project']['archived_at'])
        self.request('parts/' + other_part, 'PUT', {'name': '禁止修改'}, 409, project=other)
        self.request('projects/' + other, 'PUT', {'archived': False})
        self.request('parts/' + other_part, 'PUT', {'name': '恢复后可改'}, project=other)

    def test_project_membership_protects_files_logs_and_old_links(self):
        other = self.request('projects', 'POST', {'name': '独立项目'})['id']
        self.request('parts', 'POST', {'name': '独立项目物料'}, project=other)
        file_id = self.upload('project.txt', b'project private')['ids'][0]
        admin_cookie = self.cookie
        account = {'name': '独立项目成员', 'email': 'isolated@example.test', 'password': 'member'}
        member = self.request('users', 'POST', account)['id']
        self.request('projects/' + other, 'PUT', {'members': [member]})
        self.request('auth/login', 'POST', account)
        self.request('account/password', 'POST', {'current_password': 'member', 'password': 'member'})
        member_cookie = self.cookie
        self.assertEqual([project['id'] for project in self.request('projects')], [other])
        self.request('state', status=404)
        self.request('activity', status=404)
        self.request('resolve/parts/' + self.part, status=404)
        self.request('projects/' + other, 'PUT', {'members': [member]}, 403)
        def fetch_file(status):
            request = urllib.request.Request(self.base + '/files/' + file_id, headers={'Cookie': self.cookie})
            if status == 200:
                with urllib.request.urlopen(request) as response:
                    self.assertEqual(response.read(), b'project private')
            else:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(request)
                self.assertEqual(caught.exception.code, status)
                caught.exception.close()
        fetch_file(404)
        self.cookie = admin_cookie
        self.request('projects/' + self.project_id, 'PUT', {'members': [member]})
        self.cookie = member_cookie
        self.assertEqual(self.request('resolve/parts/' + self.part)['project_id'], self.project_id)
        fetch_file(200)
        self.move('入库', 2)
        self.cookie = admin_cookie
        self.request('projects/' + self.project_id, 'PUT', {'members': []})
        self.assertIn({'id': member, 'name': account['name']}, self.state()['former_users'])
        self.cookie = member_cookie
        fetch_file(404)

    def test_project_cover_permissions_and_backup(self):
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0i8AAAAASUVORK5CYII=')
        headers = {'Content-Type': 'multipart/form-data; boundary=cover-test'}
        body = (b'--cover-test\r\nContent-Disposition: form-data; name="file"; filename="cover.png"\r\n'
                b'Content-Type: image/png\r\n\r\n' + png + b'\r\n--cover-test--\r\n')
        self.request('cover', 'POST', body, headers=headers)
        self.assertEqual(self.request('cover', raw=True), png)
        self.assertTrue(self.request('projects')[0]['cover_version'])
        backup = self.request('backup', raw=True)
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            archive = folder / 'backup.zip'
            archive.write_bytes(backup)
            staged, version = app.stage_restore(archive, folder)
            self.assertEqual(version, app.VERSION)
            with app.connect(staged) as db:
                self.assertEqual(db.execute('SELECT image FROM project_covers').fetchone()[0], png)
        admin_cookie = self.cookie
        account = {'name': '封面测试成员', 'email': 'cover@example.test', 'password': 'cover'}
        member = self.request('users', 'POST', account)['id']
        self.request('auth/login', 'POST', account)
        self.request('account/password', 'POST', {'current_password': 'cover', 'password': 'cover'})
        member_cookie = self.cookie
        self.request('cover', status=404)
        self.cookie = admin_cookie
        self.request('projects/' + self.project_id, 'PUT', {'members': [member]})
        self.cookie = member_cookie
        self.assertEqual(self.request('cover', raw=True), png)
        self.request('cover', 'POST', body, 403, headers)
        self.cookie = admin_cookie
        self.request('projects/' + self.project_id, 'PUT', {'archived': True})
        self.request('cover', 'DELETE', status=409)

    def test_only_admin_with_current_password_can_delete_archived_project(self):
        project_path = 'projects/' + self.project_id
        credentials = {'password': 'test-password-1234'}
        self.move('入库', 8)
        fid = self.upload('project.txt', b'deleted project file')['ids'][0]
        self.request(project_path, 'DELETE', credentials, 409)
        self.request(project_path, 'PUT', {'archived': True})
        self.request(project_path, 'DELETE', {}, 400)
        self.request(project_path, 'DELETE', {'password': 'wrong'}, 403)
        self.assertEqual(len(self.request('projects')), 1)

        admin_cookie = self.cookie
        account = {'name': '普通成员', 'email': 'project-delete@example.test', 'password': 'member'}
        member = self.request('users', 'POST', account)['id']
        self.request(project_path, 'PUT', {'archived': False, 'members': [member]})
        self.request(project_path, 'PUT', {'archived': True})
        self.request('auth/login', 'POST', account)
        self.request('account/password', 'POST', {'current_password': 'member', 'password': 'member'})
        member_cookie = self.cookie
        self.request(project_path, 'DELETE', credentials, 403)
        self.request('projects?deleted=1', status=403)
        self.cookie = admin_cookie

        self.request(project_path, 'DELETE', credentials)
        self.assertEqual(self.request('projects'), [])
        self.assertEqual(self.request('projects?deleted=1')[0]['id'], self.project_id)
        self.request('state', status=404)
        self.request('resolve/parts/' + self.part, status=404)
        self.request(project_path, 'PUT', {'archived': False}, 404)
        self.assertEqual((app.DATA / 'uploads' / fid).read_bytes(), b'deleted project file')
        self.assertEqual(self.request('activity', project=False)['items'][0]['action'], '删除项目')
        self.cookie = member_cookie
        self.request('recover', 'POST', status=403)
        self.request('state', status=404)
        self.cookie = admin_cookie

        self.request('recover', 'POST')
        self.assertEqual(self.request('projects?deleted=1'), [])
        self.assertTrue(self.state()['project']['archived_at'])
        self.assertEqual(self.stock(), 8)
        self.assertEqual(self.state()['files'][0]['id'], fid)

    def test_v8_backup_restores_as_legacy_project_with_original_business_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            legacy = folder / 'legacy'
            app.init_legacy_db(legacy, {'name': '旧管理员', 'email': 'legacy@example.test', 'password': 'legacy'})
            with app.connect(legacy) as db:
                stamp = app.now()
                user = db.execute("SELECT id FROM users WHERE role='admin'").fetchone()[0]
                db.execute("INSERT INTO products(id,code,name,created_at,updated_at) VALUES('p','P-1','旧产品',?,?)", (stamp,stamp))
                db.execute("""INSERT INTO parts(id,code,name,category,stock,material_serial,numbering_product_id,created_at,updated_at)
                              VALUES('m','CM110001','旧物料','结构物料',8,1,'p',?,?)""", (stamp,stamp))
                db.execute("INSERT INTO bom_versions VALUES('v','p','V1.0','',?)", (stamp,))
                db.execute("INSERT INTO bom_lines VALUES('l','v','m',3,'','')")
                db.execute("INSERT INTO material_code_aliases VALUES('旧料号','m')")
                db.execute("INSERT INTO files VALUES(?, 'parts','m','旧图纸.txt','text/plain',4,'attachment',?)", ('a'*24,stamp))
                db.execute("INSERT INTO activity(actor_id,actor_name,action,subject_id,subject,detail,created_at) VALUES(?,'旧管理员','入库','m','旧物料','',?)", (user,stamp))
                db.execute("INSERT INTO activity(actor_id,actor_name,action,subject_id,subject,detail,created_at) VALUES(?,'旧管理员','登录',?,'旧管理员','',?)", (user,user,stamp))
            archive = folder / 'v8.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                output.write(legacy / 'plm.sqlite3', 'plm.sqlite3')
                output.writestr('uploads/' + 'a'*24, b'file')
            restored, version = app.stage_restore(archive, folder)
            self.assertEqual(version, 8)
            with app.connect(restored) as db:
                db.project_id = app.LEGACY_PROJECT_ID
                state = app.get_state(db)
                self.assertEqual((state['parts'][0]['id'], state['parts'][0]['stock']), ('m', 8))
                self.assertEqual(state['bom_lines'][0]['id'], 'l')
                self.assertEqual(state['material_code_aliases'][0]['code'], '旧料号')
                self.assertEqual(db.execute('SELECT user_id FROM project_members').fetchone()[0], user)
                self.assertEqual([r[0] for r in db.execute('SELECT project_id FROM activity ORDER BY id')],
                                 [app.LEGACY_PROJECT_ID, None])
            self.assertEqual((restored / 'uploads' / ('a'*24)).read_bytes(), b'file')
    def test_auto_codes_are_not_reused_after_deletion(self):
        m=self.request('parts','POST',{'name':'可以删除'})['id']
        previous=self.state()['parts'][-1]['code']
        self.request('parts/'+m,'DELETE',{})
        self.request('parts','POST',{'name':'下一个'})
        self.assertNotEqual(self.state()['parts'][-1]['code'],previous)
    def test_v1_database_migrates_without_losing_business_data(self):
        previous=app.DATA
        with tempfile.TemporaryDirectory() as tmp:
            app.DATA=Path(tmp)
            try:
                with app.connect() as db:
                    db.executescript(app.SCHEMA)
                    db.execute("INSERT INTO products VALUES('legacy-product','OLD-001','旧产品','','研发中',?,?)",(app.now(),app.now()))
                    for id,category,child in [('screw','结构物料',None),('capacitor','电子物料',None),('assembly','电子物料','legacy-product')]:
                        db.execute('INSERT INTO parts(id,code,name,category,unit,stock,sub_product_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',(id,id,id,category,'个',5,child,app.now(),app.now()))
                    db.execute("INSERT INTO bom_versions VALUES('legacy-version','legacy-product','V1.0','',?)",(app.now(),))
                    db.execute("INSERT INTO bom_lines VALUES('legacy-line','legacy-version','screw',4,'','')")
                app.init_db();app.init_db()
                with app.connect() as db:
                    materials={r['id']:dict(r) for r in db.execute('SELECT * FROM parts')}
                    self.assertEqual(materials['screw']['material_level'],1)
                    self.assertEqual(materials['capacitor']['material_level'],2)
                    self.assertEqual(materials['assembly']['material_level'],1)
                    self.assertTrue(all(p['sub_product_id'] is None for p in materials.values()))
                    self.assertEqual(materials['screw']['stock'],5)
                    self.assertEqual(db.execute("SELECT qty FROM bom_lines WHERE id='legacy-line'").fetchone()[0],4)
                    self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],app.VERSION)
                    self.assertTrue(all(len(p['code'])==8 and p['code'][:2].isalpha() and p['code'][2:].isdigit() for p in materials.values()))
                    self.assertEqual(db.execute("SELECT part_id FROM material_code_aliases WHERE code='screw'").fetchone()[0],'screw')
            finally: app.DATA=previous

    def test_numeric_code_schema_and_aliases(self):
        for category,prefix in [('结构物料','1'),('电子物料','2')]:
            for level in (1,2):
                id=self.request('parts','POST',{'name':category+str(level),'category':category,'material_level':level})['id']
                material=next(p for p in self.state()['parts'] if p['id']==id)
                self.assertRegex(material['code'],'^CM'+prefix+str(level)+r'[0-9]{4}$')
        old=self.code
        self.request('material-cells/'+self.part,'PUT',{'category':'结构物料'})
        p=self.state()['parts'][0];self.assertRegex(p['code'],r'^CM11[0-9]{4}$')
        self.assertTrue(any(a['code']==old and a['part_id']==self.part for a in self.state()['material_code_aliases']))
        product=self.product();version=self.state()['bom_versions'][0]['id']
        self.request('bom-import','POST',{'version_id':version,'rows':[{'code':old,'qty':2}]})
        self.assertEqual(self.state()['bom_lines'][0]['part_id'],self.part)
    def test_table_fields_reject_names_pictures_codes_and_stock(self):
        for key,value in [('name','禁止名称修改'),('images',[]),('stock',99),('code','1111111111')]:
            self.request('material-cells/'+self.part,'PUT',{key:value},400)
        self.request('parts/'+self.part,'PUT',{'stock':999},400)
        self.request('material-cells/'+self.part,'PUT',{'spec':'0603','unit':''})
        material=self.state()['parts'][0]
        self.assertEqual(material['name'],'测试物料');self.assertEqual(material['stock'],0)
        self.assertEqual(material['unit'],'PCS');self.assertEqual(material['spec'],'0603')
        self.request('parts/'+self.part,'PUT',{'name':'详情页可改名'})
        self.assertEqual(self.state()['parts'][0]['name'],'详情页可改名')
    def test_secondary_material_can_link_multiple_primary_materials(self):
        parent=self.request('parts','POST',{'name':'电路板A','category':'电子物料'})['id']
        other=self.request('parts','POST',{'name':'电路板B','category':'电子物料'})['id']
        child=self.request('parts','POST',{'name':'电容','material_level':2,'parent_ids':[parent,other]})['id']
        links=self.state()['material_links'];self.assertEqual(len(links),2)
        self.assertEqual({l['parent_id'] for l in links},{parent,other})
        self.assertEqual({l['child_id'] for l in links},{child})
        link=next(l for l in links if l['parent_id']==parent)
        self.request('material-links/'+link['id'],'PUT',{'qty':12})
        self.request('material-parents/'+child,'PUT',{'parent_ids':[parent,other,parent]})
        self.assertEqual(len(self.state()['material_links']),2)
        self.assertEqual(next(l for l in self.state()['material_links'] if l['id']==link['id'])['qty'],12)
        self.request('material-parents/'+child,'PUT',{'parent_ids':[parent]})
        self.assertEqual(len(self.state()['material_links']),1)
        self.assertEqual(self.state()['material_links'][0]['qty'],12)
    def test_relation_selection_is_validated_and_atomic(self):
        parent=self.request('parts','POST',{'name':'电路板'})['id']
        child=self.request('parts','POST',{'name':'电阻','material_level':2,'parent_ids':[parent]})['id']
        self.request('material-parents/'+child,'PUT',{'parent_ids':['missing-record']},404)
        self.assertEqual(len(self.state()['material_links']),1)
        self.request('material-parents/'+child,'PUT',{'parent_ids':[child]},400)
        self.request('material-links','POST',{'parent_id':child,'child_id':parent},400)
        self.request('material-cells/'+parent,'PUT',{'material_level':2},400)
        self.request('material-cells/'+child,'PUT',{'material_level':1},400)
        self.assertEqual(len(self.state()['material_links']),1)
        count=len(self.state()['parts'])
        self.request('parts','POST',{'name':'错误关联的物料','material_level':2,'parent_ids':['missing-record']},404)
        self.assertEqual(len(self.state()['parts']),count)
    def test_primary_children_picker_and_unlink_keep_materials(self):
        parent=self.request('parts','POST',{'name':'一级板'})['id']
        a=self.request('parts','POST',{'name':'电阻','material_level':2})['id']
        b=self.request('parts','POST',{'name':'电容','material_level':2})['id']
        self.request('material-children/'+parent,'PUT',{'child_ids':[a,b]})
        self.assertEqual(len(self.state()['material_links']),2)
        self.request('material-children/'+parent,'PUT',{'child_ids':[a,'missing']},404)
        self.assertEqual(len(self.state()['material_links']),2)
        link=next(l for l in self.state()['material_links'] if l['child_id']==a)
        self.request('material-links/'+link['id'],'DELETE',{})
        self.assertEqual(len(self.state()['material_links']),1)
        self.assertEqual(len(self.state()['parts']),4)
        self.request('parts/'+parent,'DELETE',{})
        self.assertEqual(len(self.state()['material_links']),1)
        self.assertTrue(any(p['id']==b for p in self.state()['parts']))
    def test_optional_fields_survive_creation_inside_bom(self):
        parent=self.request('parts','POST',{'name':'电路板'})['id']
        product=self.product();version=self.state()['bom_versions'][0]['id']
        child=self.request('bom-materials','POST',{'name':'电容','material_level':2,'version_id':version,'spec':'10uF','unit':'PCS','price':'0.12','location':'A-01','notes':'可选信息','parent_ids':[parent]})['id']
        material=next(p for p in self.state()['parts'] if p['id']==child)
        self.assertEqual(material['spec'],'10uF');self.assertEqual(material['price'],0.12)
        self.assertEqual(material['location'],'A-01');self.assertEqual(material['notes'],'可选信息')
        self.assertEqual(self.state()['material_links'][0]['child_id'],child)
        self.assertEqual(self.state()['bom_lines'][0]['part_id'],child)

    def test_product_english_code_and_bom_numbering(self):
        product=self.request('products','POST',{'name':'混配设备','english_code':'aquamix'})['id']
        state=self.state();p=next(p for p in state['products'] if p['id']==product)
        self.assertEqual(p['english_code'],'AQUAMIX')
        version=next(v['id'] for v in state['bom_versions'] if v['product_id']==product)
        a=self.request('bom-materials','POST',{'name':'主控板','version_id':version,'category':'电子物料'})['id']
        b=self.request('parts','POST',{'name':'电容','material_level':2,'parent_ids':[a]})['id']
        parts={p['id']:p for p in self.state()['parts']}
        self.assertRegex(parts[a]['code'],r'^AQ21[0-9]{4}$');self.assertRegex(parts[b]['code'],r'^AQ22[0-9]{4}$')
        self.assertEqual(parts[b]['numbering_product_id'],product)
    def test_shared_material_keeps_original_product_prefix(self):
        first=self.request('products','POST',{'name':'产品A','english_code':'AQUAMIX'})['id']
        second=self.request('products','POST',{'name':'产品B','english_code':'FUME'})['id']
        state=self.state();v1=next(v['id'] for v in state['bom_versions'] if v['product_id']==first);v2=next(v['id'] for v in state['bom_versions'] if v['product_id']==second)
        material=self.request('bom-materials','POST',{'name':'共享螺钉','version_id':v1})['id']
        original=next(p['code'] for p in self.state()['parts'] if p['id']==material)
        self.request('bom-lines','POST',{'version_id':v2,'part_id':material,'qty':2})
        saved=next(p for p in self.state()['parts'] if p['id']==material)
        self.assertEqual(saved['code'],original);self.assertTrue(saved['code'].startswith('AQ11'))
        self.assertEqual(saved['numbering_product_id'],first)
    def test_updating_product_english_code_preserves_ids_history_and_aliases(self):
        product=self.request('products','POST',{'name':'产品'})['id'];version=self.state()['bom_versions'][0]['id']
        material=self.request('bom-materials','POST',{'name':'主控板','version_id':version,'category':'电子物料'})['id']
        original=next(p['code'] for p in self.state()['parts'] if p['id']==material)
        self.request('movements','POST',{'type':'入库','part_id':material,'qty':5})
        line=self.state()['bom_lines'][0]['id']
        self.request('products/'+product,'PUT',{'english_code':'AQUAMIX'})
        saved=next(p for p in self.state()['parts'] if p['id']==material)
        self.assertEqual(saved['stock'],5);self.assertEqual(self.state()['bom_lines'][0]['id'],line)
        self.assertTrue(saved['code'].startswith('AQ21'))
        self.assertTrue(any(a['code']==original and a['part_id']==material for a in self.state()['material_code_aliases']))
        # Changing the full code without changing its first two letters does not renumber materials.
        current=saved['code'];self.request('products/'+product,'PUT',{'english_code':'AQUA-02'})
        self.assertEqual(next(p['code'] for p in self.state()['parts'] if p['id']==material),current)
    def test_product_code_validation_and_same_prefix_uniqueness(self):
        for code in ('A','123','中文','AB XX'):
            self.request('products','POST',{'name':'不合法代号','english_code':code},400)
        first=self.request('products','POST',{'name':'产品一','english_code':'AQUAMIX'})['id']
        self.request('products','POST',{'name':'重复代号','english_code':'aquamix'},409)
        second=self.request('products','POST',{'name':'产品二','english_code':'AQUA-PRO'})['id']
        a=self.request('parts','POST',{'name':'一','numbering_product_id':first})['id']
        b=self.request('parts','POST',{'name':'二','numbering_product_id':second})['id']
        parts={p['id']:p for p in self.state()['parts']}
        self.assertNotEqual(parts[a]['code'],parts[b]['code'])
        self.assertTrue(parts[a]['code'].startswith('AQ11') and parts[b]['code'].startswith('AQ11'))

    def test_v3_numbering_upgrade_preserves_relations_and_history(self):
        previous=app.DATA
        with tempfile.TemporaryDirectory() as tmp:
            app.DATA=Path(tmp)
            try:
                with app.connect() as db:
                    db.executescript(app.SCHEMA)
                    db.execute('ALTER TABLE parts ADD COLUMN material_level INTEGER NOT NULL DEFAULT 1')
                    db.execute("INSERT INTO products VALUES('p','PRD-001','旧产品','','研发中',?,?)",(app.now(),app.now()))
                    for id,code,level in [('parent','2100000001',1),('child','2200000001',2)]:
                        db.execute('INSERT INTO parts(id,code,name,category,unit,stock,material_level,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',(id,code,id,'电子物料','PCS',5,level,app.now(),app.now()))
                    db.execute("INSERT INTO bom_versions VALUES('v','p','V1.0','',?)",(app.now(),))
                    db.execute("INSERT INTO bom_lines VALUES('l','v','parent',1,'','')")
                    db.execute("INSERT INTO material_links VALUES('link','parent','child',12,?)",(app.now(),))
                    db.execute('PRAGMA user_version=3')
                app.init_db()
                with app.connect() as db:
                    parts={r['id']:dict(r) for r in db.execute('SELECT * FROM parts')}
                    self.assertEqual(parts['parent']['code'],'CM210001');self.assertEqual(parts['child']['code'],'CM220002')
                    self.assertEqual(parts['child']['numbering_product_id'],'p')
                    self.assertEqual(db.execute("SELECT qty FROM material_links WHERE id='link'").fetchone()[0],12)
                    self.assertEqual(parts['child']['stock'],5)
                    self.assertEqual(db.execute("SELECT part_id FROM material_code_aliases WHERE code='2200000001'").fetchone()[0],'child')
            finally: app.DATA=previous
    def test_four_digit_sequence_never_overflows_into_five_digits(self):
        with app.transaction() as db:
            db.execute("INSERT INTO settings VALUES('sequence_material_global','9998') ON CONFLICT(key) DO UPDATE SET value='9998'")
        self.request('parts','POST',{'name':'最后一个编号'})
        self.assertEqual(self.state()['parts'][-1]['code'],'CM119999')
        before=len(self.state()['parts'])
        self.request('parts','POST',{'name':'不应生成五位流水'},409)
        self.assertEqual(len(self.state()['parts']),before)

    def test_serial_is_unique_globally_across_all_prefixes(self):
        product=self.request('products','POST',{'name':'AQ产品','english_code':'AQUAMIX'})['id']
        other=self.request('products','POST',{'name':'FU产品','english_code':'FUME'})['id']
        for owner in (None,product,other):
            for category in ('结构物料','电子物料'):
                for level in (1,2):self.request('parts','POST',{'name':'物料','category':category,'material_level':level,'numbering_product_id':owner})
        records=self.state()['parts'];serials=[p['material_serial'] for p in records]
        self.assertEqual(len(serials),len(set(serials)))
        self.assertEqual([p['code'][-4:] for p in records],[f'{n:04d}' for n in serials])
        self.assertEqual(serials,list(range(1,len(records)+1)))
        self.assertEqual(len({p['code'][-4:] for p in records}),len(records))
    def test_changing_prefix_does_not_change_serial_and_deletion_does_not_reuse_it(self):
        product=self.request('products','POST',{'name':'产品','english_code':'AQUAMIX'})['id']
        id=self.request('parts','POST',{'name':'螺钉','numbering_product_id':product})['id']
        before=next(p for p in self.state()['parts'] if p['id']==id)
        self.request('material-cells/'+id,'PUT',{'category':'电子物料','material_level':2})
        self.request('products/'+product,'PUT',{'english_code':'FUME'})
        changed=next(p for p in self.state()['parts'] if p['id']==id)
        self.assertTrue(changed['code'].startswith('FU22'))
        self.assertEqual(changed['code'][-4:],before['code'][-4:])
        self.assertEqual(changed['material_serial'],before['material_serial'])
        self.request('parts/'+id,'DELETE',{})
        new=self.request('parts','POST',{'name':'新的结构件'})['id']
        saved=next(p for p in self.state()['parts'] if p['id']==new)
        self.assertGreater(saved['material_serial'],before['material_serial'])
        self.assertNotEqual(saved['code'][-4:],before['code'][-4:])

    def preview_import_file(self,filename,blob):
        boundary='electronic-bom-test'
        body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+blob+f'\r\n--{boundary}--\r\n'.encode())
        return self.request('electronic-import/preview','POST',body,headers={'Content-Type':'multipart/form-data; boundary='+boundary})
    def test_electronic_preview_is_read_only_and_maps_supplier_codes(self):
        preview=self.preview_import_file('sample.csv','物料编号,名称,单机用量,封装,品牌,备注,单价,总价\nC15849,1uF,5,C0603,SAMSUNG,,0.085,0.425\n194,NC,1,R0603,FOJAN,不贴,194,0\n,,,,,,单台物料总价,0.425\n'.encode())
        self.assertEqual(len(preview['rows']),2);self.assertEqual(preview['skipped_rows'],1)
        self.assertEqual(preview['rows'][0]['external_code'],'C15849')
        self.assertEqual(preview['rows'][0]['spec'],'C0603');self.assertEqual(preview['rows'][0]['brand'],'SAMSUNG')
        self.assertTrue(preview['rows'][0]['selected']);self.assertFalse(preview['rows'][1]['selected'])
        self.assertIn('原表总价与用量 × 单价不一致',preview['rows'][1]['warnings'])
        self.assertEqual(len(self.state()['parts']),1);self.assertEqual(self.state()['material_links'],[])
    def test_electronic_import_creates_materials_links_and_bom_without_stock(self):
        product=self.request('products','POST',{'name':'产品','english_code':'AQUAMIX'})['id']
        parent=self.request('parts','POST',{'name':'电路板','category':'电子物料','numbering_product_id':product})['id']
        version=self.state()['bom_versions'][0]['id']
        result=self.request('electronic-import/commit','POST',{'request_id':'electronic-test-0001','parent_id':parent,'version_id':version,'rows':[{'name':'1uF','external_code':'C15849','qty':5,'spec':'C0603','brand':'SAMSUNG','price':0.085,'notes':'备注原样','reference':'C1,C2'}]})
        self.assertEqual(result['created'],1);self.assertEqual(result['materials'],1);self.assertEqual(result['reference_total'],0.425)
        state=self.state();child=next(p for p in state['parts'] if p['external_code']=='C15849')
        self.assertTrue(child['code'].startswith('AQ22'));self.assertNotEqual(child['code'],child['external_code'])
        self.assertEqual(child['stock'],0);self.assertEqual(child['unit'],'PCS');self.assertEqual(child['brand'],'SAMSUNG')
        self.assertEqual(state['material_links'][0]['qty'],5);self.assertEqual(state['material_links'][0]['notes'],'备注原样')
        self.assertEqual(state['material_links'][0]['reference'],'C1,C2')
        self.assertEqual(state['bom_lines'][0]['part_id'],child['id']);self.assertEqual(state['bom_lines'][0]['qty'],5)
        self.assertEqual(state['movements'],[])
    def test_electronic_import_is_idempotent_and_reimport_reuses_materials(self):
        parent=self.request('parts','POST',{'name':'电路板'})['id']
        body={'request_id':'electronic-test-0002','parent_id':parent,'rows':[{'name':'电容','external_code':'C100','spec':'0603','brand':'品牌','qty':2,'price':0.2}]}
        first=self.request('electronic-import/commit','POST',body)
        second=self.request('electronic-import/commit','POST',body)
        self.assertEqual(first,second);self.assertEqual(len(self.state()['parts']),3)
        self.request('electronic-import/commit','POST',{**body,'rows':[{**body['rows'][0],'qty':3}]},409)
        third=self.request('electronic-import/commit','POST',{**body,'request_id':'electronic-test-0003','rows':[{**body['rows'][0],'qty':3}]})
        self.assertEqual(third['created'],0);self.assertEqual(third['reused'],1)
        self.assertEqual(len(self.state()['parts']),3);self.assertEqual(self.state()['material_links'][0]['qty'],3)
        self.assertEqual(max(p['material_serial'] for p in self.state()['parts']),3)
    def test_electronic_import_rolls_back_all_rows_and_serials_on_error(self):
        parent=self.request('parts','POST',{'name':'电路板'})['id']
        with app.connect() as db:before=db.execute("SELECT value FROM settings WHERE key='sequence_material_global'").fetchone()[0]
        self.request('electronic-import/commit','POST',{'request_id':'electronic-test-0004','parent_id':parent,'rows':[{'name':'有效行','qty':1},{'name':'错误行','qty':-1}]},400)
        self.assertEqual(len(self.state()['parts']),2);self.assertEqual(self.state()['material_links'],[])
        with app.connect() as db:
            self.assertEqual(db.execute("SELECT value FROM settings WHERE key='sequence_material_global'").fetchone()[0],before)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM import_runs').fetchone()[0],0)
    def test_electronic_duplicate_rows_sum_usage_without_repeated_materials(self):
        parent=self.request('parts','POST',{'name':'电路板'})['id']
        row={'name':'电阻','external_code':'C100','spec':'R0603','brand':'品牌','qty':2,'price':0.01}
        result=self.request('electronic-import/commit','POST',{'request_id':'electronic-test-0005','parent_id':parent,'rows':[row,{**row,'qty':3}]})
        self.assertEqual(result['created'],1);self.assertEqual(result['reused'],0)
        self.assertEqual(self.state()['material_links'][0]['qty'],5)
        # Same supplier placeholder with different names/footprints must not merge.
        result=self.request('electronic-import/commit','POST',{'request_id':'electronic-test-0006','parent_id':parent,'rows':[{'name':'NC','external_code':'194','spec':'R0603','qty':1},{'name':'Test-Point','external_code':'194','spec':'TestPoint','qty':1}]})
        self.assertEqual(result['created'],2)
    def test_electronic_import_existing_prices_are_opt_in(self):
        id=self.request('parts','POST',{'name':'电容','material_level':2,'external_code':'C100','spec':'0603','brand':'品牌','price':1.5})['id']
        body={'request_id':'electronic-test-0007','rows':[{'name':'电容','external_code':'C100','spec':'0603','brand':'品牌','qty':1,'price':0.1}]}
        self.request('electronic-import/commit','POST',body)
        self.assertEqual(next(p for p in self.state()['parts'] if p['id']==id)['price'],1.5)
        self.request('electronic-import/commit','POST',{**body,'request_id':'electronic-test-0008','update_existing_prices':True})
        self.assertEqual(next(p for p in self.state()['parts'] if p['id']==id)['price'],0.1)

if __name__=='__main__':unittest.main()

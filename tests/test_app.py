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
            for t in reversed(app.TABLES): db.execute('DELETE FROM '+t)
            db.execute('DELETE FROM sessions');db.execute('DELETE FROM settings');db.execute('DELETE FROM import_runs')
        app.Handler.attempts.clear();self.cookie=''
        self.request('auth/setup','POST',{'password':'test-password-1234'})
        self.part=self.request('parts','POST',{'name':'测试物料','category':'电子物料','price':1.5,'unit':'个','min_stock':2})['id']
        self.code=self.state()['parts'][0]['code']
    def request(self,path,method='GET',data=None,status=200,headers=None,raw=False):
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
    def product(self,code='P-1'):return self.request('products','POST',{'name':'测试产品','code':code,'status':'研发中'})['id']
    def test_stock_lifecycle_and_history(self):
        self.move('入库',10);out=self.move('出库',4)['id'];self.move('退库',2,original_id=out);self.move('报废',1,reason='损坏')
        self.assertEqual(self.stock(),7);self.assertEqual([m['balance'] for m in self.state()['movements']],[10,6,8,7])
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
        po=self.request('purchases','POST',{'supplier_id':self.supplier(),'date':'2026-11-06','lines':[{'part_id':self.part,'qty':10,'price':2}]})['id']
        line=self.state()['purchase_lines'][0]['id'];self.move('入库',4,purchase_line_id=line)
        self.assertEqual(self.state()['purchase_lines'][0]['received'],4)
        self.request('movements','POST',{'type':'入库','part_id':self.part,'qty':7,'purchase_line_id':line},400)
        self.assertEqual(self.stock(),4);self.move('入库',6,purchase_line_id=line)
        self.assertEqual(self.state()['purchase_lines'][0]['received'],10)
        self.assertEqual(self.stock(),10)
    def test_purchase_creation_rolls_back(self):
        self.request('purchases','POST',{'supplier_id':self.supplier(),'date':'2026-11-06','lines':[{'part_id':self.part,'qty':2,'price':1},{'part_id':self.part,'qty':2,'price':1}]},409)
        self.assertEqual(self.state()['purchases'],[]);self.assertEqual(self.state()['purchase_lines'],[])
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
            req=urllib.request.Request(self.base+'/api/movements',data=json.dumps({'type':'出库','part_id':self.part,'qty':1}).encode(),headers={'Cookie':self.cookie,'Content-Type':'application/json'})
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
    def test_invalid_image_is_rejected(self):
        self.upload('bad.png',b'<script>bad</script>',status=400)
        self.assertEqual(self.state()['files'],[])
    def test_auth_logout_and_csrf(self):
        self.request('parts','POST',{'name':'hack'},403,{'Origin':'https://evil.test'})
        self.request('auth/setup','POST',{'password':'another-password'},409)
        self.request('auth/logout','POST',{})
        self.request('state',status=401)
        self.request('auth/login','POST',{'password':'wrong'},401)
        self.request('auth/login','POST',{'password':'test-password-1234'})
        self.request('state')
    def test_existing_records_cannot_be_deleted(self):
        self.move('入库',1);self.request('parts/'+self.part,'DELETE',{},400)
        self.assertEqual(self.stock(),1)
    def test_demo_is_explicit_and_only_empty_db(self):
        self.request('demo','POST',{},400)
        with app.transaction() as db:db.execute('DELETE FROM parts')
        self.request('demo','POST',{})
        s=self.state();self.assertEqual(len(s['products']),4);self.assertEqual(len(s['parts']),8);self.assertEqual(len(s['movements']),10)
        self.request('demo','POST',{},400)
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
                    self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],5)
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
        self.assertEqual(len(self.state()['material_links']),0)
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

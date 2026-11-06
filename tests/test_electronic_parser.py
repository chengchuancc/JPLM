"""Tiny in-memory OOXML fixtures exercise decoding, never author user workbooks."""
import io
import sys
import unittest
import zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from electronic_import import parse_electronic_file,ElectronicBomError


def xlsx_fixture():
    out=io.BytesIO()
    namespace='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    workbook=f'<workbook xmlns="{namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="第一张" sheetId="1" r:id="rId1"/><sheet name="第二张" sheetId="2" r:id="rId2"/></sheets></workbook>'
    rels='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>'
    strings=f'<sst xmlns="{namespace}"><si><t>名称</t></si><si><t>单机用量</t></si><si><t>单价</t></si><si><t>电容</t></si><si><t>电阻</t></si></sst>'
    first=f'<worksheet xmlns="{namespace}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>5</v></c><c r="C2"><f>0+0</f><v>0</v></c></row></sheetData></worksheet>'
    second=f'<worksheet xmlns="{namespace}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>名称</t></is></c><c r="B1" t="inlineStr"><is><t>数量</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>电阻</t></is></c><c r="B2"><v>12</v></c></row></sheetData></worksheet>'
    with zipfile.ZipFile(out,'w') as z:
        for name,value in [('xl/workbook.xml',workbook),('xl/_rels/workbook.xml.rels',rels),('xl/sharedStrings.xml',strings),('xl/worksheets/sheet1.xml',first),('xl/worksheets/sheet2.xml',second)]:z.writestr(name,value)
    return out.getvalue()


class ElectronicParserTests(unittest.TestCase):
    def test_shared_strings_inline_strings_cached_zero_and_sheets(self):
        data=xlsx_fixture();first=parse_electronic_file(data,'test.xlsx')
        self.assertEqual(first['sheets'],['第一张','第二张']);self.assertEqual(first['rows'][0]['name'],'电容')
        self.assertEqual(first['rows'][0]['price'],0);self.assertEqual(first['rows'][0]['qty'],5)
        second=parse_electronic_file(data,'test.xlsx','第二张')
        self.assertEqual(second['rows'][0]['name'],'电阻');self.assertEqual(second['rows'][0]['qty'],12)
        with self.assertRaises(ElectronicBomError):parse_electronic_file(data,'test.xlsx','不存在')
    def test_bom_csv_header_blank_codes_quoted_text_and_summary(self):
        text='BOM资料,,,,,,\n物料编号,名称,单机用量,封装,品牌,备注,单价\n,电池,1,,,"换成15K，仅保留备注",25\n,,,,,,主板小计\n'
        parsed=parse_electronic_file(text.encode('utf-8-sig'),'bom.csv')
        self.assertEqual(parsed['header_row'],2);self.assertEqual(len(parsed['rows']),1)
        row=parsed['rows'][0];self.assertEqual(row['external_code'],'');self.assertEqual(row['notes'],'换成15K，仅保留备注');self.assertEqual(row['name'],'电池')
    def test_excluded_rows_and_invalid_numbers_are_visible(self):
        data='名称,用量,备注,单价,总价\nNC,1,不贴,194,0\nTest-Point,1,测试点,194,0\n电容,-1,,0.1,0.1\n电阻,2,,0,0\n'.encode()
        rows=parse_electronic_file(data,'bom.csv')['rows']
        self.assertTrue(rows[0]['excluded']);self.assertFalse(rows[0]['selected']);self.assertTrue(rows[1]['excluded'])
        self.assertTrue(rows[2]['errors']);self.assertFalse(rows[2]['selected']);self.assertTrue(rows[3]['selected']);self.assertEqual(rows[3]['price'],0)
    def test_missing_header_corrupt_xlsx_and_xml_entities_are_rejected(self):
        for name,data in [('test.csv',b'a,b\n1,2'),('test.xlsx',b'not a zip')]:
            with self.assertRaises(ElectronicBomError):parse_electronic_file(data,name)
        data=io.BytesIO()
        with zipfile.ZipFile(data,'w') as z:
            z.writestr('xl/workbook.xml','<!DOCTYPE a [<!ENTITY x "x">]><workbook/>')
            z.writestr('xl/_rels/workbook.xml.rels','<Relationships/>')
        with self.assertRaises(ElectronicBomError):parse_electronic_file(data.getvalue(),'test.xlsx')

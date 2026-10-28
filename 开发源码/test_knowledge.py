"""Real local fixtures plus a mock MinerU process; no model or network calls."""
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

from knowledge_service import KnowledgeStore, KnowledgeError, MAX_UPLOAD, mineru_chunks, bbox_ratio


def archive(parts):
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as target:
        for name,value in parts.items():target.writestr(name,value)
    return stream.getvalue()


def docx_fixture(text='基础浇筑前应复核钢筋和预埋件。'):
    return archive({
        '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
        'word/document.xml':f'''<?xml version="1.0" encoding="UTF-8"?>
          <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
          <w:p><w:r><w:t>{text}</w:t></w:r></w:p>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>质量检查</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>模板加固</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
          </w:body></w:document>'''})


def xlsx_fixture():
    return archive({
        'xl/workbook.xml':'''<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="基础施工" sheetId="1" r:id="rId1"/></sheets></workbook>''',
        'xl/_rels/workbook.xml.rels':'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>''',
        'xl/sharedStrings.xml':'''<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>混凝土养护</t></si></sst>''',
        'xl/worksheets/sheet1.xml':'''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>专人记录温度</t></is></c><c r="C1"><v>7</v></c></row></sheetData></worksheet>'''})


def pdf_fixture(blank=False):
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    writer=PdfWriter()
    for value in ['Wind turbine foundation quality inspection.','Concrete curing requires daily temperature records.']:
        page=writer.add_blank_page(width=612,height=792)
        if not blank:
            font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
            page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
            stream=DecodedStreamObject();stream.set_data(('BT /F1 12 Tf 72 720 Td ('+value+') Tj ET').encode('ascii'))
            page[NameObject('/Contents')]=writer._add_object(stream)
    raw=io.BytesIO();writer.write(raw);return raw.getvalue()


class KnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='fuyu-kb-test-')
        self.root=Path(self.temp.name)
        self.stores=[]
        self.store=self.open()

    def tearDown(self):
        for store in reversed(self.stores):store.close()
        self.temp.cleanup()

    def open(self,**kwargs):
        store=KnowledgeStore(self.root,**kwargs)
        store.update_settings({'engine':'native','mineruExecutable':''})
        self.stores.append(store)
        return store

    def wait(self,document_id,store=None,timeout=5):
        store=store or self.store
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            document=store.document(document_id)
            if document['status'] not in ('queued','parsing'):return document
            time.sleep(.01)
        self.fail('Background parser did not settle: '+str(store.document(document_id)))

    def put(self,value='承台钢筋安装与质量检查。',filename='施工要求.txt',meta=None):
        result=self.store.upload(value.encode('utf-8') if isinstance(value,str) else value,filename,'application/octet-stream',meta or {'unit':'WT','objectId':'F08','process':'WT-07'})
        return self.wait(result['document']['id'])

    def test_real_text_background_parse_source_and_stable_chinese_search(self):
        group=self.store.create_group({'name':'风机资料'})['group']
        doc=self.put('承台钢筋安装前核查材料。\n模板加固后开展质量检查。',meta={'unit':'WT','groupId':group['id'],'objectId':'F08','process':'WT-07'})
        self.assertEqual(doc['status'],'ready');self.assertEqual(doc['engine'],'native-text')
        self.assertIsNone(doc['pages']);self.assertGreater(doc['chunks'],0)
        content=self.store.content(doc['id'])
        self.assertIn('第 1–2 行',content['chunks'][0]['locator'])
        self.assertIsNone(content['chunks'][0]['page']);self.assertIsNone(content['chunks'][0]['bboxNormalized'])
        path,mime,name=self.store.source(doc['id'])
        self.assertEqual(mime,'text/plain');self.assertEqual(name,'施工要求.txt');self.assertTrue(path.is_file())
        request={'query':'承台钢筋安装','unit':'WT','objectId':'F08','process':'WT-07','groupId':group['id']}
        hits=self.store.search(request)['hits'];self.assertTrue(hits);self.assertEqual(hits[0]['documentId'],doc['id'])
        self.assertEqual(hits,self.store.search(request)['hits'])
        self.assertEqual(self.store.status()['ready'],1)

    def test_scopes_empty_group_empty_doc_list_never_fall_back(self):
        first=self.put('风机基础混凝土质量检查。')
        second=self.put('升压站混凝土质量检查。',filename='升压站.txt',meta={'unit':'SS','objectId':'SS-B01','process':'SS-05'})
        empty=self.store.create_group({'name':'空分组'})['group']['id']
        self.assertEqual(self.store.search({'query':'混凝土','groupId':empty})['hits'],[])
        self.assertEqual(self.store.search({'query':'混凝土','documentIds':[]})['hits'],[])
        self.assertEqual(self.store.search({'query':'混凝土','docIds':[]})['hits'],[])
        self.assertEqual(self.store.search({'query':'混凝土','unit':'RD'})['hits'],[])
        self.assertEqual(self.store.search({'query':'混凝土','unit':'WT','objectId':'F09'})['hits'],[])
        self.assertEqual(self.store.search({'query':'混凝土','unit':'WT','process':'WT-08'})['hits'],[])
        hit=self.store.search({'query':'混凝土','documentIds':[second['id']]})['hits'][0]
        self.assertEqual(hit['documentId'],second['id']);self.assertNotEqual(hit['documentId'],first['id'])

    def test_document_metadata_and_reversible_archive(self):
        doc=self.put()
        group=self.store.create_group({'name':'待核查'})['group']['id']
        updated=self.store.update_document(doc['id'],{'label':'承台参考要求','groupId':group,'archived':True})
        self.assertEqual(updated['label'],'承台参考要求');self.assertEqual(updated['status'],'archived')
        self.assertEqual(updated['parseStatus'],'ready');self.assertEqual(updated['archiveStatus'],'archived')
        self.assertFalse(self.store.list_documents({})['documents'])
        self.assertEqual(len(self.store.list_documents({'includeArchived':'true'})['documents']),1)
        self.assertFalse(self.store.search({'query':'承台'})['hits'])
        restored=self.store.update_document(doc['id'],{'archiveStatus':'active'})
        self.assertEqual(restored['status'],'ready');self.assertTrue(self.store.search({'query':'承台'})['hits'])
        self.assertTrue(self.store.source(doc['id'])[0].exists())

    def test_duplicate_import_is_scoped_and_does_not_overwrite_source(self):
        doc=self.put()
        duplicate=self.store.upload('承台钢筋安装与质量检查。'.encode(),'其他名称.txt','text/plain',{'unit':'WT','objectId':'F08','process':'WT-07'})
        self.assertTrue(duplicate['duplicate']);self.assertEqual(duplicate['document']['id'],doc['id'])
        other=self.store.upload('承台钢筋安装与质量检查。'.encode(),'其他名称.txt','text/plain',{'unit':'SS'})
        self.assertFalse(other['duplicate']);self.assertNotEqual(other['document']['id'],doc['id'])
        self.wait(other['document']['id'])

    def test_real_docx_paragraph_and_table_anchors_without_fake_pages(self):
        doc=self.put(docx_fixture(),'技术交底.docx')
        self.assertEqual(doc['status'],'ready');self.assertEqual(doc['engine'],'native-docx')
        rows=self.store.content(doc['id'])['chunks']
        self.assertEqual([r['locator'] for r in rows],['段落 1','表格 1'])
        self.assertIn('预埋件',rows[0]['text']);self.assertIn('模板加固',rows[1]['text'])
        self.assertTrue(all(r['page'] is None and r['bbox'] is None for r in rows))

    def test_real_xlsx_sheet_cell_anchors_and_values(self):
        doc=self.put(xlsx_fixture(),'施工检查.xlsx')
        self.assertEqual(doc['status'],'ready');self.assertEqual(doc['engine'],'native-xlsx')
        row=self.store.content(doc['id'])['chunks'][0]
        self.assertEqual(row['locator'],'基础施工!A1:C1')
        self.assertIn('混凝土养护',row['text']);self.assertIn('B1: 专人记录温度',row['text']);self.assertIn('C1: 7',row['text'])
        self.assertIsNone(row['page'])

    def test_real_pdf_extracts_physical_pages_without_claiming_bboxes(self):
        doc=self.put(pdf_fixture(),'quality.pdf')
        self.assertEqual(doc['status'],'ready');self.assertEqual(doc['pages'],2)
        rows=self.store.content(doc['id'],2)['chunks']
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['page'],2)
        self.assertIn('Concrete curing',rows[0]['text']);self.assertTrue(rows[0]['sourceUrl'].endswith('#page=2'))
        self.assertIsNone(rows[0]['bboxNormalized'])
        self.assertEqual(self.store.search({'query':'Concrete curing'})['hits'][0]['page'],2)

    def test_scan_needs_engine_and_successful_retry_with_mock_mineru(self):
        doc=self.put(pdf_fixture(blank=True),'scan.pdf')
        self.assertEqual(doc['status'],'needs_engine');self.assertIn('扫描页',doc['error'])
        exe=self.root/'mineru.exe';exe.write_bytes(b'fixture-do-not-execute')
        calls=[]
        def runner(args,**kwargs):
            calls.append((args,kwargs))
            target=Path(args[args.index('-o')+1]);(target/'scan_content_list.json').write_text(json.dumps([
                {'type':'text','text':'混凝土浇筑与振捣质量检查。','page_idx':1,'bbox':[100,150,900,300]},
                {'type':'footer','text':'不应进入检索','page_idx':1,'bbox':[0,950,1000,1000]}],ensure_ascii=False),'utf-8')
            return subprocess.CompletedProcess(args,0)
        self.store.runner=runner
        self.store.update_settings({'engine':'mineru','mineruExecutable':str(exe),'timeoutSeconds':30})
        self.store.reparse(doc['id']);ready=self.wait(doc['id'])
        self.assertEqual(ready['status'],'ready');self.assertEqual(ready['engine'],'mineru');self.assertEqual(ready['pages'],2)
        hit=self.store.search({'query':'振捣质量'})['hits'][0]
        self.assertEqual(hit['page'],2);self.assertEqual(hit['bboxNormalized'],[.1,.15,.9,.3])
        self.assertEqual(len(calls),1);args,kwargs=calls[0]
        self.assertFalse(kwargs['shell']);self.assertEqual(kwargs['timeout'],30)
        self.assertEqual(args[-4:],['-f','false','-l','ch'])
        self.assertEqual(kwargs['env']['MINERU_MODEL_SOURCE'],'modelscope')
        self.assertEqual(self.store.search({'query':'不应进入检索'})['hits'],[])

    def test_mineru_legacy_v2_boxes_tables_and_invalid_results(self):
        legacy=mineru_chunks({'items':[{'type':'table','table_caption':['检测表'],'table_body':'<table><tr><td>混凝土</td><td>强度</td></tr></table>','page_idx':0,'bbox':[0,50,1000,300]}]})
        self.assertEqual(legacy[0]['page'],1);self.assertIn('混凝土',legacy[0]['text']);self.assertIn('检测表',legacy[0]['text'])
        v2=mineru_chunks([[{'type':'paragraph','content':{'text':'风机基础质量检查'},'bbox':[.2,.3,.8,.5]}],[],[{'content':{'markdown':'第三页内容'}}]])
        self.assertEqual([r['page'] for r in v2],[1,3]);self.assertEqual(v2[0]['bboxNormalized'],[.2,.3,.8,.5])
        wrapped=mineru_chunks({'pages':[{'blocks':[{'text':'第一张扫描页'}]}]})
        self.assertEqual(wrapped[0]['page'],1)
        bullet=mineru_chunks([[{'type':'list','content':{'items':[{'text':'复核预埋件位置'},'清理浇筑面'],'caption':['施工前检查']}}]])
        self.assertIn('复核预埋件位置',bullet[0]['text']);self.assertIn('清理浇筑面',bullet[0]['text']);self.assertIn('施工前检查',bullet[0]['text'])
        legacy_list=mineru_chunks([{'type':'list','list_items':[{'markdown':'检查钢筋保护层'},'固定模板'],'page_idx':0}])
        self.assertIn('检查钢筋保护层',legacy_list[0]['text'])
        nested_table=mineru_chunks([[{'type':'table','content':{'content':'<table><td>实测质量数据</td></table>','caption':['检测表']}}]])
        self.assertIn('实测质量数据',nested_table[0]['text']);self.assertIn('检测表',nested_table[0]['text'])
        self.assertIsNone(bbox_ratio([.5,.5,.1,.1]));self.assertIsNone(bbox_ratio([0,0,float('inf'),1]))
        self.assertIsNone(bbox_ratio(None))
        for value in ({},[],[{'type':'page_number','text':'1'}]):
            with self.assertRaises(KnowledgeError):mineru_chunks(value)

    def test_restart_recovers_queued_and_interrupted_work(self):
        self.store.close();self.stores.remove(self.store)
        pending=self.open(autostart=False)
        doc=pending.upload('停机前已上传钢筋施工资料'.encode(),'重启.txt','text/plain',{'unit':'WT'})['document']
        with pending.lock,pending.db:
            pending.db.execute("UPDATE documents SET status='parsing' WHERE id=?",(doc['id'],))
        pending.close();self.stores.remove(pending)
        recovered=self.open();ready=self.wait(doc['id'],recovered)
        self.assertEqual(ready['status'],'ready');self.assertTrue(recovered.search({'query':'钢筋施工'})['hits'])

    def test_archiving_a_running_job_invalidates_late_result_and_restore_requeues(self):
        started=threading.Event();release=threading.Event()
        original=self.store._parse
        count=[0]
        def slow(*args):
            count[0]+=1
            if count[0]==1:started.set();release.wait(3)
            return original(*args)
        self.store._parse=slow
        doc=self.store.upload('承台钢筋质量检查'.encode(),'归档测试.txt','text/plain',{'unit':'WT'})['document']
        self.assertTrue(started.wait(2))
        archived=self.store.update_document(doc['id'],{'archived':True})
        self.assertEqual(archived['status'],'archived');release.set()
        restored=self.store.update_document(doc['id'],{'archived':False})
        self.assertEqual(restored['status'],'queued')
        ready=self.wait(doc['id']);self.assertEqual(ready['status'],'ready')
        self.assertTrue(self.store.search({'query':'钢筋'})['hits']);self.assertEqual(count[0],2)

    def test_failed_parse_stays_out_of_search_and_retry_is_explicit(self):
        doc=self.put(b'PK\x03\x04invalid','broken.docx')
        self.assertEqual(doc['status'],'failed');self.assertFalse(self.store.search({'query':'broken'})['hits'])
        self.assertIn('Office',doc['error'])
        self.store.reparse(doc['id']);again=self.wait(doc['id'])
        self.assertEqual(again['status'],'failed')

    def test_upload_validation_metadata_and_source_path_isolation(self):
        bad=[(b'','empty.txt'),(b'binary','bad.exe'),(b'notpdf','bad.pdf'),(b'notzip','bad.xlsx'),(b'\x00x','binary.txt'),(b'wrong','bad.png')]
        for raw,name in bad:
            with self.assertRaises(KnowledgeError):self.store.upload(raw,name,'',{})
        with self.assertRaises(KnowledgeError):self.store.upload(b'a'*(MAX_UPLOAD+1),'big.txt','',{})
        for meta in ({'unit':'BAD'},{'unit':'WT','process':'SS-01'},{'unit':'WT','process':'WT-99'},{'groupId':'missing'},{'objectId':'../x'},{'secret':'x'}):
            with self.assertRaises(KnowledgeError):self.store.upload(b'abc','a.txt','',meta)
        doc=self.put('路径隔离测试',filename='../../a.txt')
        path,_,name=self.store.source(doc['id']);self.assertEqual(name,'a.txt');self.assertTrue(path.is_relative_to(self.store.originals))
        with self.assertRaises(KnowledgeError):self.store.source('../a')
        with self.assertRaises(KnowledgeError):self.store.content(doc['id'],0)

    def test_office_unsafe_paths_entities_and_expand_limits_fail_without_extracting(self):
        payloads=[archive({'../outside.txt':'owned','word/document.xml':'<x/>'}),
                  archive({'word/document.xml':'<!DOCTYPE x [<!ENTITY boom "unsafe">]><x>&boom;</x>'}),
                  archive({'word/document.xml':'x'*(17*1024*1024)})]
        for i,payload in enumerate(payloads):
            doc=self.put(payload,f'unsafe{i}.docx')
            self.assertEqual(doc['status'],'failed')
        self.assertFalse((self.root/'outside.txt').exists())

    def test_parser_settings_validate_and_never_launch_a_shell(self):
        for body in ({'engine':'network'},{'apiKey':'secret'},{'timeoutSeconds':1},{'timeoutSeconds':True},{'mineruExecutable':'relative.exe'},{'mineruExecutable':'https://x/engine.exe'}):
            with self.assertRaises(KnowledgeError):self.store.update_settings(body)
        exe=self.root/'mineru.exe';exe.write_bytes(b'fixture')
        seen=[]
        def timeout(*args,**kwargs):seen.append(kwargs);raise subprocess.TimeoutExpired(args[0],30)
        self.store.runner=timeout
        self.store.update_settings({'engine':'mineru','mineruExecutable':str(exe),'timeoutSeconds':30})
        doc=self.put(b'%PDF-1.7\nfixture','timeout.pdf')
        self.assertEqual(doc['status'],'failed');self.assertIn('超时',doc['error'])
        self.assertEqual(seen[0]['shell'],False)


if __name__=='__main__':unittest.main()

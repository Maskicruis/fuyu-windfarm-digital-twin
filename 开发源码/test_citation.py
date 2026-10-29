"""Exact SpecFlow-style document/page/item/box anchors, never nearest-item fallback."""
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from urllib.parse import urlencode
import time

from knowledge_service import KnowledgeStore, KnowledgeError
from test_knowledge import pdf_fixture, docx_fixture
import test_v10_integration as integration


class CitationStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='fuyu-citation-')
        self.root=Path(self.temp.name)
        self.payload=[
            {'type':'text','page_idx':0,'bbox':[100,200,400,350],'text':'第一页检查材料。'},
            {'type':'text','page_idx':1,'bbox':[200,300,800,600],'text':'第二页混凝土养护检查。'},
            {'type':'text','page_idx':1,'bbox':[200,650,800,900],'text':'第二页长段落 '+('钢筋质量检查。'*450)}]
        exe=self.root/'mineru.exe';exe.write_bytes(b'fixture executable is never launched')
        def runner(args,**kwargs):
            directory=Path(args[args.index('-o')+1]);directory.mkdir(parents=True,exist_ok=True)
            (directory/'source_content_list.json').write_text(json.dumps(self.payload,ensure_ascii=False),'utf-8')
            return SimpleNamespace(returncode=0)
        self.store=KnowledgeStore(self.root,runner=runner,autostart=False)
        self.store.update_settings({'engine':'mineru','mineruExecutable':str(exe)})
        doc=self.store.upload(pdf_fixture(blank=True),'扫描原件.pdf','application/pdf',{'unit':'WT'})['document']
        self.ident=doc['id'];self.store._process(self.ident,1)
        self.doc=self.store.document(self.ident)
        self.assertEqual(self.doc['status'],'ready')

    def tearDown(self):self.store.close();self.temp.cleanup()
    def chunks(self):return self.store.content(self.ident)['chunks']

    def test_document_page_item_and_ratio_box_are_canonical_and_search_agrees(self):
        chunks=self.chunks();item=chunks[1]
        result=self.store.resolve_citation(self.ident,item['itemId'],2,item['citationVersion'])
        self.assertEqual(result['document']['id'],self.ident)
        self.assertEqual(result['page'],2)
        self.assertEqual(result['item']['text'],'第二页混凝土养护检查。')
        self.assertEqual(result['locate'],{'docId':self.ident,'page':2,'itemId':item['id'],'bboxNormalized':[.2,.3,.8,.6]})
        self.assertEqual(result['item']['bboxNormalized'],[.2,.3,.8,.6])
        self.assertEqual(item['id'],self.ident+'-v1-1')
        hit=self.store.search({'query':'混凝土养护','unit':'WT'})['hits'][0]
        self.assertEqual(hit['id'],item['id']);self.assertEqual(hit['itemId'],item['id'])
        self.assertEqual(hit['docId'],self.ident);self.assertEqual(hit['citationVersion'],1)
        self.assertEqual(hit['locate'],result['locate'])

    def test_split_long_blocks_keep_distinct_canonical_items_despite_shared_parser_id(self):
        rows=[c for c in self.chunks() if c['parserItemId']==self.chunks()[2]['parserItemId']]
        self.assertGreater(len(rows),1)
        self.assertEqual(len({c['id'] for c in rows}),len(rows))
        self.assertEqual(len({c['parserItemId'] for c in rows}),1)
        selected=rows[-1]
        result=self.store.resolve_citation(self.ident,selected['itemId'],2,1)
        self.assertEqual(result['item']['id'],selected['id'])
        self.assertEqual(result['item']['text'],selected['text'])
        self.assertNotEqual(result['item']['text'],rows[0]['text'])

    def test_wrong_page_unknown_item_or_other_document_never_falls_back(self):
        selected=self.chunks()[1]
        other=self.store.upload(pdf_fixture(blank=True),'另一个.pdf','application/pdf',{'unit':'SS'})['document']
        self.store._process(other['id'],1)
        for ident,item,page,version in [
            (self.ident,selected['id'],1,1),
            (self.ident,self.ident+'-v1-9999',2,1),
            (other['id'],selected['id'],2,1)]:
            with self.assertRaises(KnowledgeError) as failure:self.store.resolve_citation(ident,item,page,version)
            self.assertEqual(failure.exception.status,409)

    def test_reparse_invalidates_old_anchors_even_if_page_and_text_still_match(self):
        old=self.chunks()[1]
        self.store.reparse(self.ident)
        with self.assertRaises(KnowledgeError) as failure:self.store.resolve_citation(self.ident,old['id'],2,1)
        self.assertEqual(failure.exception.status,409)
        self.store._process(self.ident,2)
        for version in [1,2]:
            with self.assertRaises(KnowledgeError) as failure:self.store.resolve_citation(self.ident,old['id'],2,version)
            self.assertEqual(failure.exception.status,409)
        current=self.chunks()[1]
        self.assertNotEqual(current['id'],old['id'])
        self.assertEqual(current['citationVersion'],2)
        result=self.store.resolve_citation(self.ident,current['id'],2,2)
        self.assertEqual(result['item']['text'],old['text'])

    def test_missing_version_and_bad_page_shapes_fail_explicitly(self):
        selected=self.chunks()[1]
        with self.assertRaises(KnowledgeError) as failure:self.store.resolve_citation(self.ident,selected['id'],2)
        self.assertEqual(failure.exception.status,409)
        for page in [True,[],{},0,-1,'1.0','01',10001]:
            with self.assertRaises(KnowledgeError):self.store.resolve_citation(self.ident,page=page)
        with self.assertRaises(KnowledgeError) as failure:self.store.resolve_citation(self.ident,page=3)
        self.assertEqual(failure.exception.status,409)

    def test_page_browsing_has_no_fabricated_first_selected_item(self):
        result=self.store.resolve_citation(self.ident,page=2)
        self.assertIsNone(result['item'])
        self.assertIsNone(result['locate']['itemId'])
        self.assertIsNone(result['locate']['bboxNormalized'])
        self.assertTrue(result['chunks'])
        self.assertTrue(all(c['page']==2 for c in result['chunks']))

    def test_office_anchors_use_real_content_block_without_fake_pdf_page(self):
        doc=self.store.upload(docx_fixture(),'交底.docx','application/octet-stream',{'unit':'WT'})['document']
        self.store._process(doc['id'],1)
        item=self.store.content(doc['id'])['chunks'][1]
        result=self.store.resolve_citation(doc['id'],item['id'],version=1)
        self.assertIsNone(result['page']);self.assertIsNone(result['item']['bboxNormalized'])
        self.assertEqual(result['item']['locator'],'表格 1')
        self.assertIn('模板加固',result['item']['text'])
        with self.assertRaises(KnowledgeError) as failure:self.store.resolve_citation(doc['id'],item['id'],page=1,version=1)
        self.assertEqual(failure.exception.status,409)

    def test_restart_preserves_current_canonical_ids_and_source_identity(self):
        item=self.chunks()[1];original=self.store.source(self.ident)[0].read_bytes()
        self.store.close();self.store=KnowledgeStore(self.root,autostart=False)
        result=self.store.resolve_citation(self.ident,item['id'],2,1)
        self.assertEqual(result['item']['id'],item['id'])
        self.assertEqual(self.store.source(self.ident)[0].read_bytes(),original)


class CitationHTTPTests(unittest.TestCase):
    setUp=integration.V10IntegrationTests.setUp
    tearDown=integration.V10IntegrationTests.tearDown
    request=integration.V10IntegrationTests.request
    json=integration.V10IntegrationTests.json
    upload=integration.V10IntegrationTests.upload

    def test_answer_citation_roundtrips_exact_http_anchor_and_rejects_conflicts(self):
        doc=self.upload()
        answer=self.json('POST','/api/chat',{'messages':[{'role':'user','content':'混凝土养护'}],
            'knowledge':{'mode':'knowledge','unit':'WT'}})
        cite=answer['citations'][0]
        self.assertEqual(cite['documentId'],doc['id']);self.assertEqual(cite['docId'],doc['id'])
        self.assertEqual(cite['n'],cite['number'])
        q=urlencode({'itemId':cite['itemId'],'version':cite['citationVersion']})
        located=self.json(path='/api/knowledge/documents/'+doc['id']+'/locate?'+q)
        self.assertEqual(located['item']['id'],cite['id'])
        self.assertEqual(located['item']['text'],cite['text'])
        self.assertEqual(located['locate']['itemId'],cite['itemId'])
        self.assertEqual(self.request(path='/api/knowledge/documents/'+doc['id']+'/locate?'+q+'&page=1')[0],409)
        self.assertEqual(self.request(path='/api/knowledge/documents/'+doc['id']+'/locate?'+q+'&bbox=0,0,1,1')[0],400)

    def test_historical_http_anchor_returns_conflict_after_reparse_not_wrong_content(self):
        doc=self.upload();hit=self.json(path='/api/knowledge/search?'+urlencode({'q':'养护'}))['hits'][0]
        q=urlencode({'itemId':hit['itemId'],'version':hit['citationVersion']})
        route='/api/knowledge/documents/'+doc['id']+'/locate?'+q
        self.assertEqual(self.request(path=route)[0],200)
        self.json('POST','/api/knowledge/documents/'+doc['id']+'/reparse',{})
        for _ in range(200):
            current=self.json(path='/api/knowledge/documents/'+doc['id'])['document']
            if current['status']=='ready':break
            time.sleep(.01)
        self.assertEqual(self.request(path=route)[0],409)
        new=self.json(path='/api/knowledge/search?'+urlencode({'q':'养护'}))['hits'][0]
        self.assertEqual(new['citationVersion'],2)
        self.assertNotEqual(new['itemId'],hit['itemId'])


if __name__=='__main__':unittest.main()

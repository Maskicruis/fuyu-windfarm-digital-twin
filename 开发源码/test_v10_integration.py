"""HTTP integration using disposable local stores and mocked external providers."""
import copy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

import server
from test_agent import MemoryVault


class QuietHandler(server.Handler):
    def log_message(self,*args):pass


class V10IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='fuyu-v10-http-test-')
        self.root=Path(self.temp.name)
        (self.root/'frontend.html').write_text('<!doctype html><script id="fuyu-display-config" type="application/json">{"version":2,"profiles":{}}</script>','utf-8')
        (self.root/'admin.html').write_text('<!doctype html><title>Admin</title>','utf-8')
        self.httpd=server.FuyuServer(('127.0.0.1',0),self.root)
        self.httpd.RequestHandlerClass=QuietHandler
        self.httpd.deepseek.vault=MemoryVault()
        self.httpd.knowledge.update_settings({'engine':'native','mineruExecutable':''})
        self.port=self.httpd.server_port
        self.thread=threading.Thread(target=self.httpd.serve_forever,daemon=True);self.thread.start()

    def tearDown(self):
        self.httpd.shutdown();self.httpd.server_close();self.thread.join(3);self.temp.cleanup()

    def request(self,method='GET',path='/api/system/status',body=None,*,raw=None,headers=None):
        value=json.dumps(body,ensure_ascii=False).encode() if body is not None and raw is None else raw
        final={'Content-Type':'application/json',**(headers or {})}
        connection=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5)
        connection.request(method,path,body=value,headers=final)
        response=connection.getresponse();payload=response.read();result=(response.status,payload,dict(response.getheaders()));connection.close()
        return result

    def json(self,method='GET',path='/api/system/status',body=None,expected=200,**kwargs):
        status,raw,headers=self.request(method,path,body,**kwargs)
        self.assertEqual(status,expected,raw.decode('utf-8',errors='replace'))
        return json.loads(raw)

    def upload(self,text='承台混凝土养护应记录温度与湿度。',**meta):
        metadata={'filename':'工程参考.txt','unit':'WT','objectId':'F08','process':'WT-07',**meta}
        result=self.json('POST','/api/knowledge/documents?'+urlencode(metadata),expected=201,raw=text.encode(),headers={'Content-Type':'text/plain'})
        ident=result['document']['id']
        for _ in range(200):
            doc=self.json(path='/api/knowledge/documents/'+ident)['document']
            if doc['status'] not in ('queued','parsing'):break
            time.sleep(.01)
        self.assertEqual(doc['status'],'ready')
        return doc

    def test_upload_parse_groups_search_content_and_original_range(self):
        group=self.json('POST','/api/knowledge/groups',{'name':'风机参考'})['group']['id']
        doc=self.upload(groupId=group)
        listing=self.json(path='/api/knowledge/documents?'+urlencode({'unit':'WT','groupId':group}))
        self.assertEqual([d['id'] for d in listing['documents']],[doc['id']])
        hit=self.json(path='/api/knowledge/search?'+urlencode({'q':'混凝土养护','unit':'WT','groupId':group}))['hits'][0]
        self.assertEqual(hit['documentId'],doc['id']);self.assertTrue(hit['sourceUrl'].startswith('/api/knowledge/'))
        content=self.json(path='/api/knowledge/documents/'+doc['id']+'/content')
        self.assertIn('温度与湿度',content['chunks'][0]['text']);self.assertIsNone(content['pages'])
        source=doc['sourceUrl'];status,raw,headers=self.request(path=source)
        self.assertEqual(status,200);self.assertEqual(raw,'承台混凝土养护应记录温度与湿度。'.encode())
        status,part,range_headers=self.request(path=source,headers={'Range':'bytes=0-11'})
        self.assertEqual(status,206);self.assertEqual(part,raw[:12]);self.assertIn('bytes 0-11/',range_headers['Content-Range'])
        status,empty,head_headers=self.request('HEAD',source)
        self.assertEqual(status,200);self.assertEqual(empty,b'');self.assertEqual(int(head_headers['Content-Length']),len(raw))
        self.assertEqual(self.request(path=source,headers={'Range':'bytes=999999-'})[0],416)
        self.assertTrue(self.json(path='/api/system/status')['knowledge']['ready'])

    def test_knowledge_chat_without_key_followup_and_persistent_source_links(self):
        doc=self.upload()
        context={'scope':'WT','unit':'WT','object':{'id':'F08'},'process':{'code':'WT-07'}}
        with patch.object(self.httpd.deepseek,'chat',side_effect=AssertionError('Provider must not be called')):
            result=self.json('POST','/api/chat',{'messages':[{'role':'user','content':'混凝土养护'}],'context':context,'knowledge':{'mode':'knowledge','unit':'WT'}})
            self.assertEqual(result['model'],'本地资料检索');self.assertEqual(result['citations'][0]['documentId'],doc['id'])
            session=result['conversationId']
            follow=self.json('POST','/api/chat',{'messages':[{'role':'user','content':'还有哪些记录要点？'}],'context':context,'knowledge':{'mode':'knowledge','unit':'WT'},'conversationId':session})
            self.assertTrue(follow['citations']);self.assertEqual(follow['conversationId'],session)
        rows=self.json(path='/api/agent/conversations')['conversations']
        self.assertEqual(rows[0]['id'],session)
        stored=self.json(path='/api/agent/conversations/'+session)['conversation']
        self.assertEqual(len(stored['messages']),4);self.assertTrue(stored['messages'][1]['citations'])
        persisted=json.loads((self.root/'data/agent/conversations.json').read_text('utf-8'))
        self.assertEqual(persisted[0]['id'],session)

    def test_auto_context_off_retains_user_selected_evidence_and_no_key_leak(self):
        self.upload()
        self.httpd.deepseek.vault.value='dummy-api-secret'
        self.httpd.deepseek.update({'contextEnabled':False})
        sent=[]
        def model(settings,key,messages,**kwargs):
            sent.extend(copy.deepcopy(messages))
            return {'reply':'记录温度与湿度。[1]','model':'mock-model','usage':{},'finishReason':'stop'}
        with patch.object(self.httpd.deepseek,'_call',side_effect=model):
            result=self.json('POST','/api/chat',{'messages':[{'role':'user','content':'混凝土养护'}],
                'context':{'scope':'WT','object':{'id':'F08','location':'context-private-location'}},'knowledge':{'mode':'auto','unit':'WT'}})
        self.assertTrue(result['citations']);self.assertIn('温度与湿度',sent[0]['content'])
        self.assertNotIn('context-private-location',sent[0]['content'])
        self.assertNotIn('dummy-api-secret',json.dumps(result))
        self.assertNotIn('dummy-api-secret',self.request(path='/api/state')[1].decode())
        self.assertNotIn('dummy-api-secret',(self.root/'data/settings.json').read_text('utf-8'))

    def test_invalid_context_shapes_are_http400_and_service_remains_healthy(self):
        for context,knowledge in [([],{}),({'scope':{}},{}),({}, {'mode':[]}),({}, {'unit':[]}),({'object':[],'process':'x'},{'mode':'knowledge'})]:
            body={'messages':[{'role':'user','content':'检查'}],'context':context,'knowledge':knowledge}
            expected=200 if knowledge.get('mode')=='knowledge' else 400
            self.json('POST','/api/chat',body,expected=expected)
        self.assertEqual(self.json(path='/api/system/status')['revision'],'10.0')

    def test_archive_restore_and_empty_scope_are_honest(self):
        doc=self.upload()
        empty=self.json('POST','/api/knowledge/groups',{'name':'空分组'})['group']['id']
        self.assertFalse(self.json(path='/api/knowledge/search?'+urlencode({'q':'养护','groupId':empty}))['hits'])
        self.json('PUT','/api/knowledge/documents/'+doc['id'],{'archived':True})
        self.assertFalse(self.json(path='/api/knowledge/search?'+urlencode({'q':'养护'}))['hits'])
        self.json('PUT','/api/knowledge/documents/'+doc['id'],{'archiveStatus':'active'})
        self.assertTrue(self.json(path='/api/knowledge/search?'+urlencode({'q':'养护'}))['hits'])
        self.assertEqual(self.request(path='/data/knowledge/knowledge.sqlite3')[0],403)
        self.assertEqual(self.request('DELETE','/api/knowledge/documents/'+doc['id'])[0],405)

    def test_interface_test_is_readonly_and_apply_changes_draft_not_published(self):
        row=self.json('POST','/api/interfaces',{'name':'测试进度','url':'https://example.com/progress','unit':'WT',
             'arrayPath':'items','idField':'id','fields':{'percent':'actual','planned':'plan'}})['interface']
        before=self.json(path='/api/state')
        with patch.object(self.httpd.interfaces,'_fetch',return_value={'items':[{'id':'F08','actual':62,'plan':70}]}):
            preview=self.json('POST','/api/interfaces/'+row['id']+'/test',{})
            self.assertEqual(preview['validRows'],1);self.assertEqual(self.json(path='/api/state')['draft'],before['draft'])
            applied=self.json('POST','/api/interfaces/'+row['id']+'/apply',{})
        state=self.json(path='/api/state')
        self.assertEqual(state['published'],before['published'])
        self.assertEqual(state['draft']['data']['objects']['WT:F08'],{'percent':62,'planned':70})
        self.assertEqual(applied['draft'],state['draft'])

    def test_upload_and_settings_reject_cross_origin_and_invalid_formats(self):
        self.json('POST','/api/knowledge/documents?filename=bad.exe',expected=400,raw=b'bad',headers={'Content-Type':'application/octet-stream'})
        self.json('POST','/api/knowledge/groups',{'name':'x'},expected=403,headers={'Origin':'https://attacker.invalid'})
        self.json('PUT','/api/knowledge/settings',{'engine':'remote-secret-upload'},expected=400)
        created=self.json('POST','/api/agent/conversations',{'title':'现场检查'},expected=201)['conversation']
        self.assertEqual(created['title'],'现场检查')
        self.assertEqual(self.json(path='/api/agent/conversations/'+created['id'])['conversation']['messages'],[])


if __name__=='__main__':unittest.main()

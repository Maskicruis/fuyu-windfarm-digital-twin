from pathlib import Path
import http.client
import json
import tempfile
import threading
import unittest
from unittest.mock import patch
import desktop_app
from server import FuyuServer

class DesktopAndPluginHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.assets=self.root/'assets';self.assets.mkdir()
        self.workspace=self.root/'workspace'
        (self.assets/'config').mkdir()
        (self.assets/'config/default-ui.json').write_text('{"version":2,"profiles":{}}','utf-8')
        (self.assets/'frontend.html').write_text('display','utf-8')
        (self.assets/'plugin').mkdir()
        (self.assets/'plugin/widget.html').write_text('widget','utf-8')
        self.server=FuyuServer(('127.0.0.1',0),self.assets,data_root=self.workspace,persistent_credentials=False,
                              plugin_only=True,allowed_origins=['https://host.example'],plugin_token='t'*40)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()
    def request(self,path,method='GET',body=None,headers=None):
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        headers=headers or {}
        if body is not None:body=json.dumps(body);headers={**headers,'Content-Type':'application/json'}
        c.request(method,path,body,headers);r=c.getresponse();raw=r.read();result=(r.status,dict(r.getheaders()),raw);c.close();return result
    def test_plugin_mode_isolated_assets_and_mutable_state(self):
        self.assertIsNone(self.server.store)
        self.assertTrue((self.workspace/'data/knowledge').is_dir())
        self.assertFalse((self.assets/'data').exists())
        status,_,raw=self.request('/api/health')
        self.assertEqual(status,200)
        self.assertEqual(json.loads(raw)['service']['mode'],'plugin')
        self.assertTrue(desktop_app.compatible(self.server.server_port,self.workspace,True))
        self.assertFalse(desktop_app.compatible(self.server.server_port,self.workspace,False))
        self.assertEqual(self.request('/frontend.html')[0],404)
        self.assertEqual(self.request('/plugin/widget.html')[0],200)
        self.assertEqual(self.request('/api/draft','PUT',{})[0],404)
    def test_plugin_auth_cors_and_context_aliases(self):
        prefix='/api/plugin/v1'
        self.assertEqual(self.request(prefix+'/settings')[0],401)
        status,_,raw=self.request(prefix+'/settings',headers={'Sec-Fetch-Site':'same-origin'})
        self.assertEqual(status,200);self.assertNotIn('apiKey',json.loads(raw))
        headers={'Origin':'https://host.example','Authorization':'Bearer '+'t'*40}
        status,cors,raw=self.request(prefix+'/context/validate','POST',{'object':{'id':'other-object'}},headers)
        self.assertEqual(status,200);self.assertEqual(json.loads(raw)['context']['unit'],'ALL')
        self.assertEqual(cors['Access-Control-Allow-Origin'],'https://host.example')
        self.assertEqual(self.request(prefix+'/settings','PUT',{'model':'custom'},headers)[0],403)
        self.assertEqual(self.request(prefix+'/knowledge/status',headers={'Origin':'https://evil.example','Authorization':'Bearer '+'t'*40})[0],403)
        self.assertEqual(self.request(prefix+'/knowledge/documents',headers=headers)[0],200)
    def test_versioned_upload_search_and_exact_source(self):
        prefix='/api/plugin/v1';c=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        c.request('POST',prefix+'/knowledge/documents?filename=test.txt&unit=ALL',b'Unique source content for adapter testing.',{'Authorization':'Bearer '+'t'*40,'Content-Type':'text/plain'})
        r=c.getresponse();self.assertEqual(r.status,201);data=json.loads(r.read());c.close()
        ident=data['document']['id']
        import time
        for _ in range(40):
            if self.server.knowledge.document(ident)['status']=='ready':break
            time.sleep(.05)
        status,_,raw=self.request(prefix+'/knowledge/search?q=Unique',headers={'Authorization':'Bearer '+'t'*40})
        self.assertEqual(status,200);result=json.loads(raw)
        self.assertTrue(result.get('hits') or result.get('results'))
        hit=result['hits'][0]
        self.assertTrue(hit['sourceUrl'].startswith(prefix+'/knowledge/'))
        query='?itemId='+hit['id']+'&version='+str(hit['citationVersion'])
        status,_,raw=self.request(prefix+'/knowledge/documents/'+ident+'/locate'+query,headers={'Authorization':'Bearer '+'t'*40})
        self.assertEqual(status,200)
        self.assertEqual(json.loads(raw)['item']['text'],hit['text'])
        self.assertEqual(self.request(prefix+'/knowledge/documents/'+ident+'/locate'+query.replace('version='+str(hit['citationVersion']),'version=999'),headers={'Authorization':'Bearer '+'t'*40})[0],409)


if __name__=='__main__':unittest.main()

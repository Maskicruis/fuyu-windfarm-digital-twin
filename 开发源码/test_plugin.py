"""Integration boundary regressions; no provider requests or real credentials."""
import json
import tempfile
import unittest
from pathlib import Path
from twin_plugin import PluginAdapter, PluginError, PREFIX, canonical_origin, validate_context


class PluginContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.local = 'http://127.0.0.1:8779'
        self.token = 'test-integration-token-' + 'x' * 32
        self.adapter = PluginAdapter(self.root, token='')

    def tearDown(self):
        self.temp.cleanup()

    def test_default_is_closed_to_external_and_native_requests(self):
        for origin in ('https://other.example', None):
            with self.assertRaises(PluginError):
                self.adapter.authorize(origin, '', self.local)
        self.assertTrue(self.adapter.authorize(self.local, '', self.local))
        self.assertTrue(self.adapter.authorize(None, '', self.local, same_origin_browser=True))
        self.assertEqual(self.adapter.cors_headers('https://other.example'), {})

    def test_allowlist_and_token_both_required_configuration_is_separate(self):
        adapter=PluginAdapter(self.root,allowed_origins=['https://twin.example'],token=self.token)
        with self.assertRaises(PluginError):adapter.authorize('https://twin.example','',self.local)
        with self.assertRaises(PluginError):adapter.authorize('https://evil.example','Bearer '+self.token,self.local)
        with self.assertRaises(PluginError):adapter.authorize('https://twin.example','Bearer incorrect',self.local)
        self.assertTrue(adapter.authorize('https://twin.example','Bearer '+self.token,self.local))
        self.assertTrue(adapter.authorize(None,'Bearer '+self.token,self.local))
        with self.assertRaises(PluginError):adapter.authorize('https://twin.example','Bearer '+self.token,self.local,configure=True)
        admin=PluginAdapter(self.root,allowed_origins=['https://twin.example'],token=self.token,allow_configuration=True)
        self.assertTrue(admin.authorize('https://twin.example','Bearer '+self.token,self.local,configure=True))
        self.assertEqual(adapter.cors_headers('https://twin.example')['Access-Control-Allow-Origin'],'https://twin.example')
        self.assertNotIn('Access-Control-Allow-Credentials',adapter.cors_headers('https://twin.example'))

    def test_manifest_exposes_contract_but_no_credentials_or_filesystem_path(self):
        a=PluginAdapter(self.root,allowed_origins=['https://twin.example'],token=self.token)
        raw=json.dumps(a.manifest())
        self.assertNotIn(self.token,raw);self.assertNotIn(str(self.root),raw)
        self.assertIn('citations.exact',a.manifest()['capabilities'])
        self.assertNotIn('apiKey',raw)

    def test_versioned_aliases_keep_source_identity_and_query_exactly(self):
        doc='a'*32
        query='?itemId='+doc+'-v7-4&page=3&version=7'
        self.assertEqual(self.adapter.rewrite_path(PREFIX+'/knowledge/documents/'+doc+'/locate'+query),'/api/knowledge/documents/'+doc+'/locate'+query)
        self.assertEqual(self.adapter.rewrite_path(PREFIX+'/chat/stream'),'/api/chat/stream')
        self.assertEqual(self.adapter.rewrite_path(PREFIX+'/conversations/'+doc),'/api/agent/conversations/'+doc)
        self.assertEqual(self.adapter.rewrite_path(PREFIX+'/knowledge/documents/'+doc+'/source'),'/api/knowledge/documents/'+doc+'/source')
        for bad in (PREFIX+'/interfaces',PREFIX+'/../settings',PREFIX+'/knowledge/documents/../../data',PREFIX+'/conversations/not-a-document','/api/settings'):
            self.assertIsNone(self.adapter.rewrite_path(bad))

    def test_only_source_url_fields_are_rewritten(self):
        value={'sourceUrl':'/api/knowledge/documents/abc/source','text':'/api/knowledge/raw text','nested':[{'answer':'/api/knowledge/keep','sourceUrl':'/api/knowledge/documents/def/source'}]}
        result=self.adapter.public_response(value)
        self.assertEqual(result['text'], value['text'])
        self.assertEqual(result['nested'][0]['answer'], '/api/knowledge/keep')
        self.assertTrue(result['sourceUrl'].startswith(PREFIX+'/knowledge/'))

    def test_neutral_host_context_is_not_assumed_to_be_wind_farm_unit(self):
        value={'systemId':'other-twin','projectId':'test-project','object':{'id':'generic-object','label':'Generic asset'},'location':{'zone':'A'},'host':{'discipline':'building'}}
        clean=validate_context(value)
        self.assertEqual(clean['unit'],'ALL');self.assertEqual(clean['scope'],'ALL')
        self.assertEqual(clean['object']['id'],'generic-object')
        self.assertEqual(value.get('scope'),None)
        body=self.adapter.normalize_body(PREFIX+'/chat/stream',{'messages':[{'role':'user','content':'test'}],'context':value})
        self.assertEqual(body['context'],clean)
        self.assertEqual(body['messages'][0]['content'],'test')

    def test_context_rejects_commands_credentials_and_excessive_input(self):
        for value in ({'execute':'focusEverything()'},{'host':{'apiKey':'secret'}},{'scope':'BIM'},{'object':'untrusted'}, {'summary':'x'*3000},[],{'host':{'invalid':float('nan')}}):
            with self.assertRaises((PluginError,ValueError)):validate_context(value)

    def test_origins_are_strict_and_canonical(self):
        self.assertEqual(canonical_origin('HTTPS://TWIN.EXAMPLE:443/'),'https://twin.example')
        self.assertEqual(canonical_origin('http://[::1]:8779'),'http://[::1]:8779')
        for bad in ('*','null','file:///test','https://user:pass@twin.example','https://twin.example/path','https://twin.example?token=a','https://twin.example:999999'):
            with self.assertRaises(PluginError):canonical_origin(bad)

    def test_disk_config_is_explicit_and_does_not_store_runtime_token(self):
        (self.root/'data').mkdir()
        path=self.root/'data/plugin-settings.json'
        path.write_text(json.dumps({'allowedOrigins':['https://twin.example'],'allowConfiguration':False}),'utf-8')
        a=PluginAdapter(self.root,token=self.token)
        self.assertIn('https://twin.example',a.allowed_origins)
        self.assertNotIn(self.token,path.read_text('utf-8'))
        with self.assertRaises(PluginError):PluginAdapter(self.root,token='short')
        with self.assertRaises(PluginError):PluginAdapter(self.root,allowed_origins=['*'],token=self.token)


if __name__=='__main__':unittest.main()

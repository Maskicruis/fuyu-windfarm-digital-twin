import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.request
from online_update import UpdateService, UpdateError, SafeRedirect, version, github_url


class Vault:
    def __init__(self,root):self.path=Path(root)/'fake-token';self.value=''
    def read(self):return self.value
    def write(self,value):self.value=value


class OnlineUpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.service=UpdateService(self.root,self.root,vault=Vault(self.root),current='0.9.1')
        self.exe=b'MZ'+b'a'*2046
        self.manifest={'schema':'fuyu-desktop-update/v1','product':'fuyu-windfarm-digital-twin','version':'0.9.2',
            'windows-x64':{'file':'fuyu-0.9.2.exe','sha256':hashlib.sha256(self.exe).hexdigest(),'size':len(self.exe)}}
        self.release={'tag_name':'v0.9.2','draft':False,'prerelease':False,'assets':[
            {'id':1,'name':'fuyu-update.json','state':'uploaded','size':300},
            {'id':2,'name':'fuyu-0.9.2.exe','state':'uploaded','size':len(self.exe)}]}
    def tearDown(self):self.tmp.cleanup()
    def test_semver_reset_and_downgrade_order(self):
        self.assertGreater(version('0.10.0'),version('0.9.9'))
        for v in ['V12','1.0','v0.9.2','0.9.2-preview','../x']:
            with self.assertRaises(UpdateError):version(v)
    def test_manifest_rejects_wrong_product_version_path_hash_size_and_missing_asset(self):
        import copy
        for edit in [lambda m:m.update(product='other'),lambda m:m.update(version='0.9.3'),
            lambda m:m['windows-x64'].update(file='../evil.exe'),lambda m:m['windows-x64'].update(sha256='123'),
            lambda m:m['windows-x64'].update(size=999999999)]:
            candidate=copy.deepcopy(self.manifest);edit(candidate)
            with self.assertRaises(UpdateError):self.service.validate_manifest(candidate,self.release)
        with self.assertRaises(UpdateError):self.service.validate_manifest(self.manifest,{'tag_name':'v0.9.2','assets':[]})
    def test_old_v12_release_without_manifest_is_ignored_and_new_release_selected(self):
        def data(url,**kw):return [dict(self.release,tag_name='v12.0.0',assets=[]),self.release] if '/releases?' in url else self.manifest
        with patch.object(self.service,'token',return_value=''),patch.object(self.service,'json',side_effect=data):self.service.check()
        self.assertEqual(self.service.available['version'],'0.9.2')
        self.assertEqual(self.service.state['phase'],'available')
    def test_current_release_does_not_offer_reinstall(self):
        with patch.object(self.service,'token',return_value=''),patch.object(self.service,'json',return_value=[dict(self.release,tag_name='v0.9.1')]):self.service.check()
        self.assertEqual(self.service.state['phase'],'current');self.assertIsNone(self.service.available)
    def test_verified_download_is_atomic_and_does_not_touch_workspace_data(self):
        self.service.available=self.service.validate_manifest(self.manifest,self.release)
        data=self.root/'data/user-document.pdf';data.write_bytes(b'original data')
        with patch.object(self.service,'token',return_value=''),patch.object(self.service,'request',return_value=io.BytesIO(self.exe)):self.service.download()
        self.assertEqual(self.service.state['phase'],'ready');self.assertEqual(self.service.package.read_bytes(),self.exe)
        self.assertEqual(data.read_bytes(),b'original data');self.assertFalse(list(self.service.folder.glob('*.part')))
    def test_bad_hash_truncated_and_excessive_download_are_never_installed(self):
        for payload in [b'MZ'+b'x'*2046,self.exe[:100],self.exe+b'x']:
            self.service.available=self.service.validate_manifest(self.manifest,self.release)
            with patch.object(self.service,'token',return_value=''),patch.object(self.service,'request',return_value=io.BytesIO(payload)):
                with self.assertRaises(UpdateError):self.service.download()
            self.assertFalse(list(self.service.folder.glob('*.part')))
    def test_source_service_cannot_trigger_native_install(self):
        with self.assertRaises(UpdateError):self.service.install()
    def test_native_install_uses_bom_worker_and_argument_array_without_shell(self):
        (self.root/'updater-worker.ps1').write_text('param($Target) # 中文', 'utf-8')
        self.service.available=self.service.validate_manifest(self.manifest,self.release)
        self.service.package=self.service.folder/'candidate.exe';self.service.package.write_bytes(self.exe)
        self.service.target=self.root/'target application.exe';self.service.exit_callback=lambda:None
        self.service.state['phase']='ready'
        with patch('online_update.subprocess.Popen') as launch,patch('online_update.threading.Timer'):
            self.service.install()
        command=launch.call_args.args[0]
        self.assertIsInstance(command,list);self.assertIn(str(self.service.target),command)
        self.assertNotIn('shell',launch.call_args.kwargs)
        self.assertEqual(launch.call_args.kwargs['env']['PYINSTALLER_RESET_ENVIRONMENT'],'1')
        self.assertTrue((self.service.folder/'install-update.ps1').read_bytes().startswith(b'\xef\xbb\xbf'))
    def test_settings_never_return_token_and_busy_settings_are_rejected(self):
        public=self.service.configure({'token':'fixture-read-only-token','repository':'owner/repo'})
        self.assertNotIn('fixture-read-only-token',json.dumps(public));self.assertNotIn('fixture-read-only-token',self.service.config_file.read_text())
        self.assertEqual(self.service.vault.value,'fixture-read-only-token')
        self.service.busy=True
        with self.assertRaises(UpdateError):self.service.configure({'repository':'other/repo'})
    def test_network_rejects_arbitrary_hosts_and_redirect_strips_authorization(self):
        for bad in ['http://api.github.com/x','https://evil.example/x','https://api.github.com:444/x','https://user:pass@github.com/a']:
            with self.assertRaises(UpdateError):github_url(bad)
        req=urllib.request.Request('https://api.github.com/repos/a/b/releases/assets/1',headers={'Authorization':'Bearer fixture'})
        redirect=SafeRedirect().redirect_request(req,None,302,'Found',{},'https://release-assets.githubusercontent.com/a')
        self.assertIsNone(redirect.get_header('Authorization'))
        with self.assertRaises(UpdateError):SafeRedirect().redirect_request(req,None,302,'Found',{},'https://evil.example/a')

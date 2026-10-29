"""Never touches real user credentials: LOCALAPPDATA is isolated per test."""
import json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from deepseek_service import AccountKeyVault,WindowsKeyVault,DeepSeekService

@unittest.skipUnless(os.name=='nt','Windows DPAPI')
class AccountSettingsTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  self.env=patch.dict(os.environ,{'LOCALAPPDATA':str(self.root/'profile')});self.env.start()
 def tearDown(self):self.env.stop();self.tmp.cleanup()
 def test_stable_key_and_settings_after_restart_move_and_new_copy(self):
  a=DeepSeekService(self.root/'copy-a',account_store=True)
  a.update({'apiKey':'dummy-account-fixture-12345','model':'deepseek-v4-pro','thinking':True})
  b=DeepSeekService(self.root/'copy-b',account_store=True)
  self.assertTrue(b.get()['hasApiKey']);self.assertTrue(b.get()['thinking'])
  self.assertEqual(b.get()['model'],'deepseek-v4-pro')
  self.assertNotIn('dummy-account-fixture',json.dumps(b.get()))
  b.update({'maxTokens':512,'apiKey':''})
  self.assertTrue(DeepSeekService(self.root/'copy-c',account_store=True).get()['hasApiKey'])
  self.assertNotIn(b'dummy-account-fixture',a.vault.path.read_bytes())
 def test_legacy_ciphertext_migrates_and_global_clear_does_not_resurrect_old_copies(self):
  a=self.root/'old-a';b=self.root/'old-b'
  WindowsKeyVault(a).write('dummy-legacy-key-fixture')
  WindowsKeyVault(b).write('dummy-legacy-key-fixture')
  account=AccountKeyVault(a);self.assertEqual(account.read(),'dummy-legacy-key-fixture')
  account.write('');self.assertEqual(AccountKeyVault(b).read(),'')
 def test_interface_workspace_keys_remain_separate(self):
  account=AccountKeyVault(self.root/'app');account.write('dummy-model-fixture')
  x=WindowsKeyVault(self.root/'app/interface-secrets/a');y=WindowsKeyVault(self.root/'app/interface-secrets/b')
  x.write('dummy-interface-one')
  self.assertEqual(x.read(),'dummy-interface-one');self.assertEqual(y.read(),'')
  self.assertEqual(account.read(),'dummy-model-fixture')
 def test_explicit_test_service_does_not_use_account_credentials(self):
  AccountKeyVault(self.root/'app').write('dummy-production-fixture')
  self.assertFalse(DeepSeekService(self.root/'isolated',account_store=False).get()['hasApiKey'])

if __name__=='__main__':unittest.main()

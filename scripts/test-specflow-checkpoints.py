"""Small checkpoint consistency tests; requires only the Python standard library."""
from pathlib import Path
from types import SimpleNamespace
import importlib.util, tempfile, os, unittest, json

spec=importlib.util.spec_from_file_location('checkpoint',Path(__file__).resolve().parent.parent/'specflow-component/engines/checkpoint.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class CheckpointTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='检查点测试-');self.root=Path(self.temp.name);self.old=os.environ.get('KB_PARSER_CHECKPOINT_DIR');self.old_hash=os.environ.pop('KB_PARSER_SOURCE_SHA256',None);os.environ['KB_PARSER_CHECKPOINT_DIR']=str(self.root/'cache')
 def tearDown(self):
  if self.old is None:os.environ.pop('KB_PARSER_CHECKPOINT_DIR',None)
  else:os.environ['KB_PARSER_CHECKPOINT_DIR']=self.old
  if self.old_hash is None:os.environ.pop('KB_PARSER_SOURCE_SHA256',None)
  else:os.environ['KB_PARSER_SOURCE_SHA256']=self.old_hash
  self.temp.cleanup()
 def context(self,name='images',pdf=b'fixture PDF'):
  folder=self.root/name;folder.mkdir(exist_ok=True)
  return {'pdf_bytes':pdf,'page_count':16,'next_page_idx':0,'middle_json':{'pdf_info':[]},'model_list':[],'image_writer':SimpleNamespace(_parent_dir=str(folder)),'lang':'ch'}
 def snapshot(self):
  c=self.context();module.restore(c,'ocr',False,True);c['next_page_idx']=8;c['middle_json']['pdf_info']=[{'page_idx':i} for i in range(8)];c['model_list']=[{'page_info':{'page_no':i}} for i in range(8)];(Path(c['image_writer']._parent_dir)/'figure.png').write_bytes(b'fixture image');module.save(c);return c
 def test_restore_keeps_page_indexes_and_copies_images(self):
  self.snapshot();c=self.context('new-images');module.restore(c,'ocr',False,True);self.assertEqual(c['next_page_idx'],8);self.assertEqual([p['page_idx'] for p in c['middle_json']['pdf_info']],list(range(8)));self.assertEqual((self.root/'new-images/figure.png').read_bytes(),b'fixture image')
 def test_different_pdf_or_parser_flags_do_not_reuse_cache(self):
  self.snapshot();c=self.context('changed',b'updated PDF');module.restore(c,'ocr',False,True);self.assertEqual(c['next_page_idx'],0);c=self.context('different-flags');module.restore(c,'ocr',False,False);self.assertEqual(c['next_page_idx'],0)
 def test_missing_image_or_inconsistent_state_is_not_resumed(self):
  c=self.snapshot();(c['_specflow_cache']/'images/figure.png').unlink();fresh=self.context('incomplete');module.restore(fresh,'ocr',False,True);self.assertEqual(fresh['next_page_idx'],0)
 def test_corrupt_json_is_ignored_safely(self):
  c=self.snapshot();(c['_specflow_cache']/'state.json').write_text('{broken',encoding='utf8');fresh=self.context('corrupt');module.restore(fresh,'ocr',False,True);self.assertEqual(fresh['next_page_idx'],0)
 def test_original_identity_survives_nondeterministic_preprocessed_pdf_bytes(self):
  os.environ['KB_PARSER_SOURCE_SHA256']='a'*64
  self.snapshot();fresh=self.context('rebuilt-pdf',b'preprocessed object IDs and timestamps changed');module.restore(fresh,'ocr',False,True);self.assertEqual(fresh['next_page_idx'],8)

if __name__=='__main__':unittest.main()

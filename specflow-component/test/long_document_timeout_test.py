import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('timeout_hotfix', ROOT / 'hotfixes/long-document-timeout/install.py')
hotfix = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hotfix)

class LongDocumentHotfixTests(unittest.TestCase):
    def test_install_preserves_source_identity_and_user_data_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'engines/python').mkdir(parents=True)
            (root / 'engines/python/python.exe').touch()
            entry = root / 'engines/run_mineru.py'
            original = "# MINERU_PROCESSING_WINDOW_SIZE\nfrom mineru.cli.client import main\n"
            entry.write_text(original, 'utf8')
            marker = root / 'engines/component-patches.json'
            marker.write_text(json.dumps({'source': {'run_mineru.py': 'original-exe-source'}, 'files': {'run_mineru.py': hotfix.sha(entry)}}), 'utf8')
            settings = root / 'workspace/data/settings.json'
            settings.parent.mkdir(parents=True)
            settings.write_text('private sentinel', 'utf8')
            replacement = ROOT / 'engines/run_mineru.py'
            result = hotfix.install(root, replacement)
            self.assertTrue(result['installed'])
            data = json.loads(marker.read_text('utf8'))
            self.assertEqual(data['source']['run_mineru.py'], 'original-exe-source')
            self.assertEqual(data['files']['run_mineru.py'], hotfix.sha(replacement))
            self.assertTrue(data['hotfix']['stall_watchdog_unchanged'])
            self.assertEqual(settings.read_text('utf8'), 'private sentinel')
            self.assertEqual(len(list((root / '数据备份').glob('*/run_mineru.py'))), 1)
            self.assertTrue(hotfix.install(root, replacement)['already_current'])
            self.assertEqual(len(list((root / '数据备份').glob('*/run_mineru.py'))), 1)
            entry.write_text(original + '# custom edit', 'utf8')
            with self.assertRaisesRegex(RuntimeError, '校验记录不一致'):
                hotfix.install(root, replacement)
            self.assertTrue(entry.read_text('utf8').endswith('# custom edit'))

if __name__ == '__main__':
    unittest.main()

import json
from pathlib import Path
import tempfile
import unittest
from preferences import Preferences, DEFAULTS


class PreferencesTests(unittest.TestCase):
    def test_saved_preferences_survive_service_restart(self):
        with tempfile.TemporaryDirectory() as root:
            store = Preferences(root)
            self.assertEqual(store.get(), DEFAULTS)
            store.update({'projectName': '测试工程', 'defaultUnit': 'SS'})
            self.assertEqual(Preferences(root).get()['projectName'], '测试工程')
            self.assertEqual(Preferences(root).get()['defaultUnit'], 'SS')
            self.assertNotIn('apiKey', store.path.read_text('utf-8'))

    def test_invalid_preferences_cannot_overwrite_saved_values(self):
        with tempfile.TemporaryDirectory() as root:
            store = Preferences(root)
            saved = store.update({'defaultUnit': 'RD'})
            for bad in [{'apiKey':'no'}, {'dataDate':'2026-02-30'}, {'defaultUnit':'unknown'}, {'projectName':''}, []]:
                with self.assertRaises((ValueError, TypeError)):
                    store.update(bad)
                self.assertEqual(store.get(), saved)

    def test_corrupt_file_falls_back_without_destroying_file(self):
        with tempfile.TemporaryDirectory() as root:
            store = Preferences(root)
            store.path.parent.mkdir()
            store.path.write_text('{broken', 'utf-8')
            self.assertEqual(store.get(), DEFAULTS)
            self.assertEqual(store.path.read_text('utf-8'), '{broken')

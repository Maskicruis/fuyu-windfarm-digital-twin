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

    def test_overview_values_survive_restart_and_reject_invalid_progress(self):
        with tempfile.TemporaryDirectory() as root:
            store=Preferences(root)
            overview={'demo':False,'summary':'项目简介','actual':0,'planned':71,'turbines':None,'units':{'WT':0,'SS':61}}
            store.update({'overview':overview})
            self.assertEqual(Preferences(root).get()['overview'],overview)
            for bad in [{'actual':101},{'units':{'WT':-1}},{'demo':'false'},{'token':'secret'}]:
                with self.assertRaises(ValueError):store.update({'overview':bad})
                self.assertEqual(store.get()['overview'],overview)

    def test_progress_history_is_persistent_ordered_and_bounded(self):
        with tempfile.TemporaryDirectory() as root:
            store=Preferences(root)
            history=[{'date':'2026-10-01','actual':0},{'date':'2026-10-30','actual':64}]
            store.update({'overview':{'demo':False,'history':history}})
            self.assertEqual(Preferences(root).get()['overview']['history'],history)
            for invalid in [history[::-1],history+[history[-1]], [{'date':'2026-02-30','actual':10}], [{'date':'2026-10-30','actual':101}], 'untrusted']:
                with self.assertRaises((ValueError,TypeError)):store.update({'overview':{'history':invalid}})
                self.assertEqual(store.get()['overview']['history'],history)

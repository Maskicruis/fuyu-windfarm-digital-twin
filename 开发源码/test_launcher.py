import io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,MagicMock
import launcher

class LauncherTests(unittest.TestCase):
    def test_identity_requires_current_revision_and_workspace(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            def check(service):
                response=MagicMock();response.__enter__.return_value=io.StringIO(json.dumps({'service':service}))
                with patch.object(launcher.urllib.request,'urlopen',return_value=response):return launcher.compatible(8779,root)
            good={'name':'fuyu-ui-studio','revision':'10.0','workspace':str(root)}
            self.assertTrue(check(good))
            self.assertFalse(check({**good,'revision':'9'}))
            self.assertFalse(check({**good,'workspace':str(root/'other')}))
            self.assertFalse(check({}))

    def test_reuses_recorded_matching_service(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'data').mkdir();(root/'data/service.json').write_text('{"port":8785}')
            with patch.object(launcher,'compatible',side_effect=lambda port,root:port==8785),patch.object(launcher.subprocess,'Popen') as popen:
                self.assertEqual(launcher.start(root),8785);popen.assert_not_called()

    def test_occupied_older_port_uses_free_port_and_records_it(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);calls={}
            def healthy(port,root):
                calls[port]=calls.get(port,0)+1
                return port==8782 and calls[port]>1
            child=MagicMock();child.pid=12345;child.poll.return_value=None
            with patch.object(launcher,'compatible',side_effect=healthy),patch.object(launcher,'available',side_effect=lambda port:port!=8779),patch.object(launcher.subprocess,'Popen',return_value=child) as popen:
                self.assertEqual(launcher.start(root),8782)
                self.assertEqual(json.loads((root/'data/service.json').read_text())['port'],8782)
                self.assertIn('8782',popen.call_args.args[0])
                self.assertEqual(popen.call_args.kwargs['creationflags'],getattr(launcher.subprocess,'CREATE_NO_WINDOW',0))

if __name__=='__main__':unittest.main()

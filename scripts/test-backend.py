from pathlib import Path
import json,sys,unittest
root=Path(__file__).resolve().parent.parent
source=root/'开发源码'
sys.path.insert(0,str(source))
suite=unittest.defaultTestLoader.discover(str(source),pattern='test_*.py')
result=unittest.TextTestRunner(verbosity=1,buffer=True).run(suite)
(source/'backend-test-report.json').write_text(json.dumps({'passed':result.wasSuccessful(),'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors)},indent=2),'utf-8')
raise SystemExit(0 if result.wasSuccessful() else 1)

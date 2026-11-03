"""Run in the actual portable Python at a Unicode Windows installation path."""
from pathlib import Path
import argparse, subprocess, json

parser=argparse.ArgumentParser()
parser.add_argument('engine',type=Path)
parser.add_argument('--report',type=Path)
args=parser.parse_args()
code=r'''
import os,json,importlib.metadata
from unittest.mock import patch
from fast_langdetect.ft_detect import infer
before=os.getcwd()
model=infer.load_model(low_memory=True,use_strict_mode=True)
sample='混凝土结构施工质量验收和建筑工程基础检测技术规范要求应当结合设计文件和现场条件进行核查。'*5
assert model.predict(sample)[0][0]=='__label__zh'
assert os.getcwd()==before
try:
 with patch.object(infer.fasttext,'load_model',side_effect=RuntimeError('fixture-failure')):
  infer.load_fasttext_model(infer.LOCAL_SMALL_MODEL_PATH)
except infer.DetectError:pass
else:raise AssertionError('model loading failure must propagate')
assert os.getcwd()==before
from mineru.utils.language import detect_lang
assert detect_lang(sample)=='zh'
print(json.dumps({'passed':True,'fast_langdetect':importlib.metadata.version('fast-langdetect'),'model_path':str(infer.LOCAL_SMALL_MODEL_PATH),'cwd_restored_after_success_and_failure':True,'long_paragraph_language':'zh'},ensure_ascii=False))
'''
result=subprocess.run([str(args.engine/'python/python.exe'),'-c',code],capture_output=True,text=True,encoding='utf8')
if result.returncode:raise RuntimeError(result.stdout+'\n'+result.stderr)
report=json.loads(result.stdout.strip().splitlines()[-1])
if args.report:args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(report,ensure_ascii=False))

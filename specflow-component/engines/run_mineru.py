"""Portable MinerU entry point; ships with CPython, packages and local weights."""
from pathlib import Path
import json,os,sys
root=Path(__file__).resolve().parent
config_dir=Path(os.environ.get('KB_DATA_DIR',root/'config'))
config_dir.mkdir(parents=True,exist_ok=True)
config=config_dir/'bundled-mineru.json'
config.write_text(json.dumps({'models-dir':{'pipeline':str(root/'models'),'vlm':''},'config_version':'1.3.2'}),encoding='utf8')
os.environ['MINERU_TOOLS_CONFIG_JSON']=str(config)
os.environ['MINERU_MODEL_SOURCE']='local'
os.environ.setdefault('MINERU_DEVICE_MODE','cpu')
os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'
os.environ.setdefault('PYTHONIOENCODING','utf-8')
os.environ.setdefault('OMP_NUM_THREADS','4')
os.environ.setdefault('MKL_NUM_THREADS','4')
os.environ.setdefault('MINERU_PROCESSING_WINDOW_SIZE','8')
# Multiprocessing re-enters this file; only the original process invokes Click.
if __name__=='__main__':
 from multiprocessing import freeze_support
 freeze_support()
 # Fail before expensive OCR if the bundled language model cannot be loaded.
 # The patched vendor loader also runs inside MinerU's separate API process.
 from fast_langdetect.ft_detect.infer import load_model
 load_model(low_memory=True, use_strict_mode=True)
 print('SpecFlow offline language-model preflight: OK', flush=True)
 from mineru.cli.client import main
 main()

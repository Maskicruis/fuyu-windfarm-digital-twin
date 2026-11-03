"""Windows integration: kill the real OCR process after one saved window, resume.

Uses only the supplied portable runtime/models. Outputs are isolated synthetic
PDFs; no user document, API credential or conversation is touched.
"""
from pathlib import Path
import argparse, os, subprocess, json, time, re, hashlib

parser=argparse.ArgumentParser()
parser.add_argument('--engine',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args();area=args.output.resolve();area.mkdir(parents=True,exist_ok=True)
python=args.engine/'python/python.exe';checkpoint=area/'检查点缓存'
fixture=area/'resume-16-pages.pdf'
code=r'''
from PIL import Image,ImageDraw,ImageFont
from pathlib import Path
import sys
pages=[];font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',32)
for n in range(1,17):
 image=Image.new('RGB',(900,1200),'white');draw=ImageDraw.Draw(image)
 for y,text in [(250,'工程现场检测记录 第 %s 页'%n),(400,'施工前应检查设备和材料质量。'),(520,'钢筋连接接头试件编号：%s。'% (100+n)),(640,'混凝土试件编号：%s，养护温度 20℃。'%(200+n))]:draw.text((60,y),text,font=font,fill='black')
 pages.append(image)
pages[0].save(sys.argv[1],save_all=True,append_images=pages[1:],resolution=150)
'''
subprocess.run([str(python),'-c',code,str(fixture)],check=True)
env={**os.environ,'KB_PARSER_SOURCE_SHA256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'KB_DATA_DIR':str(area/'config'),'KB_PARSER_CHECKPOINT_DIR':str(checkpoint),'MINERU_API_OUTPUT_ROOT':str(area/'api-output'),'MINERU_PROCESSING_WINDOW_SIZE':'8','NO_PROXY':'127.0.0.1,localhost,::1','no_proxy':'127.0.0.1,localhost,::1','PYTHONIOENCODING':'utf-8'}
def command(output):return [str(python),str(args.engine/'run_mineru.py'),'-p',str(fixture),'-o',str(area/output),'-b','pipeline','-m','ocr','-t','true','-f','false','-l','ch']
def stop(process):
 if process.poll() is None:subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
 process.wait(timeout=20)
first=None
try:
 with (area/'interrupted.log').open('wb') as log:
  first=subprocess.Popen(command('interrupted-output'),stdout=log,stderr=subprocess.STDOUT,env=env)
  deadline=time.monotonic()+900;saved=None
  while time.monotonic()<deadline:
   for file in checkpoint.glob('*/state.json'):
    try:state=json.loads(file.read_text('utf8'))
    except (OSError,ValueError):continue
    if state['completed']>=8:saved=state;break
   if saved:break
   if first.poll() is not None:raise RuntimeError('OCR exited before a checkpoint; inspect interrupted.log')
   time.sleep(.1)
  assert saved and saved['completed']==8,saved
  stop(first);first=None
 started=time.monotonic()
 with (area/'resumed.log').open('wb') as log:subprocess.run(command('resumed-output'),stdout=log,stderr=subprocess.STDOUT,env=env,check=True,timeout=900)
 text=(area/'resumed.log').read_text('utf8',errors='replace')
 events=[json.loads(m) for m in re.findall(r'SPECFLOW_PROGRESS (\{[^\r\n]+\})',text)]
 assert any(e.get('event')=='resume' and e.get('completed')==8 for e in events),events
 file=next((area/'resumed-output').rglob('*_content_list.json'));items=json.loads(file.read_text('utf8'))
 pages={i['page_idx'] for i in items if i.get('text')}
 assert pages==set(range(16)),sorted(pages)
 middle=json.loads(next((area/'resumed-output').rglob('*_middle.json')).read_text('utf8'))['pdf_info']
 assert len(middle)==16 and len({p['page_idx'] for p in middle})==16
 proof={'passed':True,'interrupted_after_pages':8,'resumed_from_page':9,'final_pages':16,'unique_original_page_indexes':16,'text_pages':16,'resumed_seconds':round(time.monotonic()-started,1),'runtime':str(args.engine),'checkpoint_dir':str(checkpoint)}
 (area/'proof.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(proof,ensure_ascii=False))
finally:
 if first is not None:stop(first)

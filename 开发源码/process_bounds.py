from pathlib import Path
root=Path(__file__).parent
p=root/'runtime.js';t=p.read_text(encoding='utf-8')
t=t.replace("!/^\\w{2}-\\d{2}$/.test(value)","!/^\\w{2}-\\d{2}$/.test(value)||!(Number(value.slice(-2))>=1&&Number(value.slice(-2))<={WT:24,RD:17,CL:21,SS:30}[id.split(':')[0]])")
p.write_text(t,encoding='utf-8')
p=root/'admin.js';t=p.read_text(encoding='utf-8')
t=t.replace("if(patch.status&&!", "if(patch.actual&&(!new RegExp('^'+id.split(':')[0]+'-\\\\d{2}$').test(patch.actual)||Number(patch.actual.slice(-2))<1||Number(patch.actual.slice(-2))>{WT:24,RD:17,CL:21,SS:30}[id.split(':')[0]]))throw Error('工序编码超出当前单位工程范围');if(patch.status&&!")
p.write_text(t,encoding='utf-8')

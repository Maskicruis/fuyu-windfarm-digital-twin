"""Append sanitized parsed results to an immutable base database distribution."""
from pathlib import Path
import argparse, csv, hashlib, json, zipfile

def build(data, library, base_preset, base_resources, output):
    output.mkdir(parents=True, exist_ok=True)
    preset=json.loads(base_preset.read_text('utf8'))
    resources=json.loads(base_resources.read_text('utf8'))
    records={d['id']:d for d in json.loads((data/'documents.json').read_text('utf8'))}
    delta=[]
    fields=['id','title','dirName','file','createdAt','updatedAt','parserOptions','pages','chars','images','items','parser']
    for i, seed in enumerate(preset['documents']):
        record=records[seed['id']]
        folder=library/record['dirName']
        assert record['status']=='ready' and (folder/'document.json').is_file(), seed['title']
        if seed['status']!='ready':delta.append(record)
        preset['documents'][i]={k:record[k] for k in fields if k in record}|{'status':'ready','sourceFile':seed['sourceFile'],'groupId':seed['groupId']}
    assert len(preset['documents'])==71
    preset.update(version='1.3.3',counts={'total':71,'indexed':71})
    preset_file=output/'database-manifest.json';preset_file.write_text(json.dumps(preset,ensure_ascii=False,indent=2)+'\n','utf8')
    catalog=output/'施工验收规范目录.csv'
    with catalog.open('w',encoding='utf-8-sig',newline='') as stream:
        writer=csv.writer(stream);writer.writerow(['序号','规范名称','状态','PDF页数','文档ID'])
        for i,item in enumerate(preset['documents'],1):writer.writerow([i,item['title'],'已入库',item.get('pages',''),item['id']])
    archive=output/'SpecFlow-1.3.3-Preindexed-Database-Update.zip'
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=3) as z:
        z.write(preset_file,'database/manifest.json');z.write(catalog,'database/施工验收规范目录.csv')
        for record in delta:
            folder=library/record['dirName']
            for file in folder.rglob('*'):
                if file.is_file() and file.suffix.lower()!='.pdf':
                    assert file.name not in ['settings.json','conversations.json']
                    z.write(file,'workspace/资料库/'+record['dirName']+'/'+file.relative_to(folder).as_posix())
    with zipfile.ZipFile(archive) as z:assert z.testzip() is None
    resources.update(version='1.3.3',revision=1,presetCounts={'total':71,'indexed':71},baseRequired=list(resources['required']))
    for part in resources['parts']:
        part['base']=True
        part['url']='https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/component-v1.3.3/'+part['name']
    resources['parts'].append({'name':archive.name,'role':'database','title':'补齐全部 71 份规范的预解析内容','bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'url':'https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/component-v1.3.3/'+archive.name})
    resources['required'] += ['workspace/资料库/'+r['dirName']+'/document.json' for r in delta]
    (output/'resources-manifest.json').write_text(json.dumps(resources,ensure_ascii=False,indent=2)+'\n','utf8')
    print(json.dumps({'originals':71,'preindexed':71,'additional_documents':len(delta),'delta_bytes':archive.stat().st_size}),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser()
    for name in ['data','library','base-preset','base-resources','output']:p.add_argument('--'+name,type=Path,required=True)
    a=p.parse_args();build(a.data,a.library,a.base_preset,a.base_resources,a.output)

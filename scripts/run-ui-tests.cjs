const {spawnSync}=require('node:child_process');
const path=require('node:path');
const src=path.join(__dirname,'..','开发源码');
for(const file of ['admin-tests/admin.test.cjs','construction-update.test.cjs','system-settings.test.cjs','scene-playback.test.cjs','knowledge-ui.test.cjs','agent-rag.test.cjs','system-admin.test.cjs','stream-ui.test.cjs','plugin-sdk.test.cjs']){
  const result=spawnSync(process.execPath,[path.join(src,file)],{cwd:src,stdio:'inherit'});
  if(result.status!==0)process.exit(result.status||1);
}

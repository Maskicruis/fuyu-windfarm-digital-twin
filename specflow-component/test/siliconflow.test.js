'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-silicon-'));process.env.KB_DATA_DIR=path.join(root,'data');
const {chatEndpoint,requestBody,mergeLlm,chat,chatStream,resourceEndpoint}=require('../src/llm');
const {createHttpServer}=require('../src/http-server');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('SiliconFlow handles root, version prefix and full URLs without losing the platform model namespace',()=>{
 for(const base of ['https://api.siliconflow.cn','https://api.siliconflow.cn/v1/','https://api.siliconflow.cn//chat/completions','https://api.siliconflow.cn/chat/completions','https://api.siliconflow.cn/v1//chat/completions'])assert.equal(chatEndpoint(base),'https://api.siliconflow.cn/v1/chat/completions');
 const cfg={baseUrl:'https://api.siliconflow.cn',model:'Pro/deepseek-ai/DeepSeek-V3.2',thinking:false};
 for(const stream of [true,false]){const body=requestBody(cfg,[{role:'user',content:'hello'}],{},stream);assert.equal(body.model,cfg.model);assert.equal(body.enable_thinking,false);assert.equal(body.thinking,undefined);assert.equal(body.max_tokens,4096);}
 assert.equal(requestBody({...cfg,thinking:true},[],{},true).enable_thinking,true);
 assert.equal(requestBody({...cfg,model:'deepseek-ai/DeepSeek-R1'},[],{},true).enable_thinking,undefined);
 assert.equal(requestBody({...cfg,baseUrl:'https://proxy.example/v1'},[],{},true).enable_thinking,undefined);
 assert.deepEqual(requestBody({...cfg,baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},[],{},true).thinking,{type:'disabled'});
 assert.equal(resourceEndpoint(cfg.baseUrl+'/chat/completions','models'),'https://api.siliconflow.cn/v1/models');
 assert.equal(resourceEndpoint(cfg.baseUrl+'/v1/chat/completions','embeddings'),'https://api.siliconflow.cn/v1/embeddings');
});
test('changing API origin requires that platform key; path-only corrections retain the saved key',()=>{
 const current={baseUrl:'https://api.deepseek.com',apiKey:'official-only',model:'deepseek-flash'};
 assert.throws(()=>mergeLlm(current,{baseUrl:'https://api.siliconflow.cn/v1'}),/更换 API 平台/);
 assert.equal(mergeLlm(current,{baseUrl:'https://api.deepseek.com/v1'}).apiKey,'official-only');
 assert.equal(mergeLlm(current,{baseUrl:'https://api.siliconflow.cn/v1',apiKey:'Bearer silicon-only'}).apiKey,'silicon-only');
});
test('platform model list and connection test use drafts without overwriting stored API settings or conversations',async t=>{
 const calls=[];let error=false;
 const provider=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({url:req.url,auth:req.headers.authorization,body:raw?JSON.parse(raw):null});res.setHeader('Content-Type','application/json');if(error){res.writeHead(400,{'x-siliconcloud-trace-id':'trace-fixture'});res.end(JSON.stringify({code:20012,message:'Model unavailable'}));return;}res.end(JSON.stringify(req.method==='GET'?{data:[{id:'Pro/deepseek-ai/DeepSeek-V3.2'}]}:{choices:[{message:{content:'OK'}}]}));});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));const {server,service}=createHttpServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await service.shutdown();provider.closeAllConnections();server.closeAllConnections();await Promise.all([new Promise(r=>provider.close(r)),new Promise(r=>server.close(r))]);});
 service.updateSettings({llm:{baseUrl:'https://api.deepseek.com',apiKey:'official-only',model:'deepseek-flash'}});
 const before=JSON.stringify(service.settings),conversations=service.conversations.length,base='http://127.0.0.1:'+server.address().port;
 const draft={baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1/chat/completions',apiKey:'silicon-only',model:'Pro/deepseek-ai/DeepSeek-V3.2'};
 const post=async(action,llm)=>{const response=await fetch(base+'/api/v1/llm/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({llm})});return {status:response.status,body:await response.json()};};
 const models=await post('models',draft),check=await post('test',draft);assert.equal(models.body.data.models[0],draft.model);assert.equal(check.body.data.reply,'OK');assert.equal(calls[0].url,'/v1/models');assert.equal(calls[1].url,'/v1/chat/completions');assert.equal(calls[1].body.model,draft.model);assert.equal(calls[1].body.max_tokens,16);assert.equal(calls[1].body.messages.length,1);assert.equal(calls[1].auth,'Bearer silicon-only');
 assert.equal(JSON.stringify(service.settings),before);assert.equal(service.conversations.length,conversations);assert.ok(!JSON.stringify(check.body).includes('silicon-only'));
 const blocked=await post('models',{...draft,apiKey:undefined});assert.equal(blocked.status,400);assert.equal(calls.length,2);
 error=true;const bad=await post('test',draft);assert.equal(bad.status,502);assert.match(bad.body.error.message,/20012.*Model unavailable/);assert.match(bad.body.error.message,/trace-fixture/);
});

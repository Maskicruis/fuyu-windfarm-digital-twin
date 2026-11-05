'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {chat,chatStream,chatEndpoint}=require('../src/llm');
test('provider root, versioned prefix and full chat URL resolve exactly once',()=>{
 for(const url of ['https://api.deepseek.com','https://api.deepseek.com/chat/completions/'])assert.equal(chatEndpoint(url),'https://api.deepseek.com/chat/completions');
 assert.equal(chatEndpoint('https://api.deepseek.com/v1'),'https://api.deepseek.com/v1/chat/completions');
 assert.equal(chatEndpoint('https://gateway.example/openai/v1/'),'https://gateway.example/openai/v1/chat/completions');
 assert.equal(chatEndpoint('https://gateway.example/custom/chat/completions?api-version=1#fragment'),'https://gateway.example/custom/chat/completions?api-version=1');
 assert.equal(chatEndpoint('http://localhost:8000'),'http://localhost:8000/v1/chat/completions');
 assert.throws(()=>chatEndpoint('file:///x'));assert.throws(()=>chatEndpoint('https://user:secret@example.com'));
});
test('JSON and streaming both use a full configured URL without duplicate segments and explain 404',async t=>{
 let fail=false;const paths=[];const server=http.createServer((req,res)=>{paths.push(req.url);req.resume();if(fail){res.writeHead(404);res.end(JSON.stringify({error:{message:'Unknown model fixture-secret'}}));return;}if(paths.length===1){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'ok'}}]}));}else{res.setHeader('Content-Type','text/event-stream');res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const cfg={baseUrl:'http://127.0.0.1:'+server.address().port+'/custom/chat/completions',model:'fixture',apiKey:'fixture-secret'};
 assert.equal((await chat(cfg,[])).content,'ok');assert.equal((await chatStream(cfg,[],()=>{})).content,'ok');
 fail=true;for(const result of [await chat(cfg,[]),await chatStream(cfg,[],()=>{})]){assert.equal(result.status,404);assert.match(result.error,/接口地址和模型名称/);assert.ok(!result.error.includes('fixture-secret'));}
 assert.ok(paths.every(p=>p==='/custom/chat/completions'));
});

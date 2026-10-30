'use strict';
// DOM/VM behavior tests only; actual WebGL playback is checked in the browser.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict');
const {JSDOM,VirtualConsole}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'scene-playback.js'),'utf8');
const base=fs.readFileSync(path.join(__dirname,'frontend-base.html'),'utf8');
const results=[];let assertions=0;
const eq=(a,b,m)=>{assertions++;assert.deepEqual(a,b,m);};
const ok=(a,m)=>{assertions++;assert.ok(a,m);};
function fixture(overrides={}){
  const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM('<!doctype html><html><body><button id="tour-button"><svg><use href="#i-play"></use></svg><span>场景演示</span></button><button id="view-2d"></button><button id="view-3d"></button><button id="home-view"></button><button id="zoom-in"></button><button id="zoom-out"></button></body></html>',{url:'http://127.0.0.1:8779/frontend.html',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console});
  const w=dom.window,d=w.document,calls=[];
  w.s={scope:'ALL',view:'overview',view3d:true,simPlaying:false,...overrides};
  w.v6={ready:true};w.unitState={playing:true,task:'simulation'};
  w.stopTour=()=>{calls.push(['oldStop']);w.s.touring=false;d.getElementById('tour-button').innerHTML='<svg><use href="#i-play"></use></svg><span>场景演示</span>';};
  w.syncV6=()=>calls.push(['sync',!!w.s.overviewPlaying,w.s.simPlaying]);
  w.refresh=()=>calls.push(['refresh']);w.toast=text=>calls.push(['toast',text]);
  w.FuyuScene={setOverviewPlayback:enabled=>calls.push(['play',enabled]),view2D:enabled=>calls.push(['view2D',enabled])};
  for(const id of ['view-2d','view-3d','home-view','zoom-in','zoom-out'])d.getElementById(id).onclick=()=>calls.push(['original',id]);
  w.eval(source);
  return{dom,w,d,calls,errors,button:d.getElementById('tour-button'),click:id=>d.getElementById(id).click(),play:()=>d.getElementById('tour-button').click(),event:(name,target=d)=>target.dispatchEvent(new w.Event(name))};
}
function test(name,fn){try{fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.stack});}}
function useFixture(options,fn){const f=fixture(options);try{fn(f);eq(f.errors.length,0,'no DOM exceptions');}finally{f.dom.window.close();}}
test('play and pause apply motion flag, visual label and accessible state without stepping construction',()=>useFixture({},f=>{
  eq(f.button.getAttribute('aria-pressed'),'false');eq(f.button.querySelector('span').textContent,'播放场景');
  f.play();eq(f.w.s.overviewPlaying,true);eq(f.w.s.touring,false);eq(f.w.s.simPlaying,false);eq(f.w.unitState.playing,true);
  eq(f.button.getAttribute('aria-pressed'),'true');eq(f.button.querySelector('use').getAttribute('href'),'#i-pause');ok(f.calls.some(x=>x[0]==='play'&&x[1]===true));
  f.play();eq(f.w.s.overviewPlaying,false);eq(f.w.s.touring,false);eq(f.button.getAttribute('aria-pressed'),'false');eq(f.button.querySelector('span').textContent,'播放场景');ok(f.calls.some(x=>x[0]==='play'&&x[1]===false));
}));
test('not-ready, non-overview and editor selection cannot start playback',()=>{
  useFixture({},f=>{f.w.v6.ready=false;f.play();eq(f.calls.filter(x=>x[0]==='play').length,0);ok(f.calls.some(x=>x[0]==='toast'));});
  useFixture({scope:'WT'},f=>{f.play();eq(f.calls.length,0);});
  useFixture({view:'records'},f=>{f.play();eq(f.calls.length,0);});
  useFixture({},f=>{f.d.documentElement.dataset.fuyuEditing='true';f.play();eq(f.calls.length,0);});
});
test('starting from 2D preserves the chosen view while playing equipment',()=>useFixture({view3d:false},f=>{
  f.play();eq(f.w.s.view3d,false);eq(f.calls.some(x=>x[0]==='refresh'),false);ok(f.calls.some(x=>x[0]==='sync'));ok(f.calls.some(x=>x[0]==='play'&&x[1]===true));
}));
test('manual scene interaction keeps motion running; settings opening pauses it',()=>useFixture({},f=>{
  f.play();f.event('fuyu-scene-interaction');eq(f.w.s.overviewPlaying,true);f.event('fuyu-settings-opening');eq(f.w.s.overviewPlaying,false);
}));
test('stopTour preserves original cleanup and stops scene for scope switching and Escape path',()=>useFixture({},f=>{
  f.play();f.w.stopTour();eq(f.calls.filter(x=>x[0]==='oldStop').length,1);eq(f.w.s.overviewPlaying,false);eq(f.w.unitState.playing,true);eq(f.button.querySelector('span').textContent,'播放场景');
  const before=f.calls.filter(x=>x[0]==='play').length;f.w.stopTour();eq(f.calls.filter(x=>x[0]==='oldStop').length,2);eq(f.calls.filter(x=>x[0]==='play').length,before,'repeated stop does not alter construction motion');
}));
test('hidden tab and pagehide pause motion without automatic resume',()=>useFixture({},f=>{
  f.play();Object.defineProperty(f.d,'hidden',{configurable:true,value:true});f.event('visibilitychange');eq(f.w.s.overviewPlaying,false);
  Object.defineProperty(f.d,'hidden',{configurable:true,value:false});f.event('visibilitychange');eq(f.w.s.overviewPlaying,false);
  f.play();f.event('pagehide',f.w);eq(f.w.s.overviewPlaying,false);
}));
test('manual 2D, 3D, reset and zoom retain motion and original action',()=>useFixture({},f=>{
  for(const id of ['view-2d','view-3d','home-view','zoom-in','zoom-out']){if(!f.w.s.overviewPlaying)f.play();f.click(id);eq(f.w.s.overviewPlaying,true,id+' retains playback');ok(f.calls.some(x=>x[0]==='original'&&x[1]===id),id+' retains original action');}
}));
test('scene API toggles only rotors without moving camera or cancelling view transitions',()=>{
  const match=base.match(/function setOverviewPlayback\(enabled\)\{[\s\S]*?\n\}/);ok(match,'explicit public scene API exists');
  const attrs={},sandbox={Me:{autoRotate:false,autoRotateSpeed:0},fe:{domElement:{setAttribute:(k,v)=>attrs[k]=v}},gn:{start:1},rh:false};vm.createContext(sandbox);vm.runInContext(match[0],sandbox);
  eq(sandbox.setOverviewPlayback(true),true);eq(sandbox.Me.autoRotate,false);eq(sandbox.Me.autoRotateSpeed,0);eq(sandbox.rh,true);ok(sandbox.gn,'start retains pending 2D-to-3D transition');eq(attrs['data-overview-playing'],'true');
  eq(sandbox.setOverviewPlayback(false),true);eq(sandbox.Me.autoRotate,false);eq(sandbox.rh,false);eq(attrs['data-overview-playing'],'false');ok(sandbox.gn,'pause also preserves view transition');eq(attrs['aria-busy'],undefined);
  sandbox.Me=null;eq(sandbox.setOverviewPlayback(true),false);
});
test('base scope changes and Escape use wrapped stop, and scene user-control start signals interaction independently',()=>{
  for(const functionName of ['selectAsset','selectScope','openUnitWorkspace']){const start=base.indexOf('function '+functionName+'(');ok(start>=0,functionName);const body=base.slice(start,base.indexOf('\n',start));ok(body.includes('stopTour()'),functionName+' stops overview motion');}
  const init=base.slice(base.indexOf('function initializeUI()'),base.indexOf('function renderMap(){v6MapBridge();}'));ok(/e\.key==='Escape'[\s\S]*?stopTour\(\)/.test(init),'Escape stops tour');
  ok(base.includes('Me.addEventListener("start",()=>{document.dispatchEvent(new CustomEvent("fuyu-scene-interaction"))'),'controls drag/wheel dispatches an independent interaction event');
  ok(base.includes("s.overviewPlaying||s.simPlaying"),'overview motion is considered by model sync');
});
const report={passed:results.every(x=>x.passed),groups:results.length,assertions,results};
fs.writeFileSync(path.join(__dirname,'scene-playback-test-report.json'),JSON.stringify(report,null,2));
process.stdout.write(JSON.stringify(report,null,2)+'\n');if(!report.passed)process.exitCode=1;

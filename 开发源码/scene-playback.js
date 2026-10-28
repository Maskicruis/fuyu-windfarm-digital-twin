(function(){'use strict';
// Project-wide visual playback is independent of construction-step playback.
if(typeof s==='undefined'||!document.getElementById('tour-button'))return;
const button=document.getElementById('tour-button');
let playing=false;
function paint(){
  button.classList.toggle('active',playing);
  button.setAttribute('aria-pressed',String(playing));
  button.setAttribute('aria-label',playing?'暂停全场场景':'播放全场场景');
  button.title=playing?'暂停镜头巡游与风机动态':'播放全场镜头巡游与风机动态';
  const href=playing?'#i-pause':'#i-play';
  const use=button.querySelector('use');if(use)use.setAttribute('href',href);
  const label=button.querySelector('span');if(label)label.textContent=playing?'暂停场景':'播放场景';
}
function pause(){
  if(playing){
    playing=false;s.overviewPlaying=false;s.touring=false;
    window.FuyuScene?.setOverviewPlayback?.(false);
    if(typeof syncV6==='function')syncV6();
  }
  paint();
}
const originalStop=stopTour;
stopTour=function(){originalStop();pause();};
button.onclick=function(){
  if(playing){pause();return;}
  if(s.scope!=='ALL'||s.view!=='overview')return;
  if(document.documentElement.dataset.fuyuEditing==='true')return;
  if(!window.FuyuScene||typeof v6==='undefined'||!v6.ready){toast('三维场景尚未就绪，请稍后再试。');return;}
  if(!s.view3d){s.view3d=true;refresh();}
  playing=true;s.overviewPlaying=true;s.touring=true;
  syncV6();window.FuyuScene.setOverviewPlayback?.(true);paint();
};
document.addEventListener('click',e=>{if(e.target.closest?.('#view-2d,#view-3d,#home-view,#zoom-in,#zoom-out'))pause();},true);
document.addEventListener('fuyu-scene-interaction',pause);
document.addEventListener('fuyu-settings-opening',pause);
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
window.addEventListener('pagehide',pause);
paint();
})();

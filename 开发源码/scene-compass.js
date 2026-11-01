(function(){'use strict';
let heading=Number(document.querySelector('#v6-scene canvas')?.dataset.cameraHeading)||0;
function paint(){const el=document.getElementById('unit-compass');if(!el)return;el.style.setProperty('--heading',heading+'deg');el.dataset.heading=heading.toFixed(1);const label=String(Math.round(heading)%360).padStart(3,'0')+'°';if(el.querySelector('small').textContent!==label)el.querySelector('small').textContent=label;el.setAttribute('aria-label','指北针，场景方位 '+Math.round(heading)%360+' 度');}
function install(){const scene=document.getElementById('u-scene');if(!scene)return;if(!document.getElementById('unit-compass')){const el=document.createElement('div');el.id='unit-compass';el.className='fuyu-compass';el.setAttribute('role','img');el.title='场景北向为 -Z，随视角转动';el.innerHTML='<div class="fc-rose"><b>N</b><span>E</span><span>S</span><span>W</span><svg viewBox="0 0 24 50" aria-hidden="true"><path d="M12 2 21 25 12 22 3 25Z" fill="#ff5263"/><path d="M12 48 3 25 12 28 21 25Z" fill="#d9f7ff"/></svg></div><small>000°</small>';scene.append(el);}paint();}
const prior=renderUnitWorkspace;renderUnitWorkspace=function(...args){const result=prior.apply(this,args);install();return result;};
document.addEventListener('fuyu-scene-camera',event=>{if(!Number.isFinite(event.detail?.heading))return;heading=((event.detail.heading%360)+360)%360;paint();});
window.FuyuUnitCompass={install};install();
})();

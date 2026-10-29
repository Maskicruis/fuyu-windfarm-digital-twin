'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('specflowDesktop',{
 app:{info:()=>ipcRenderer.invoke('desktop:info'),openDataFolder:()=>ipcRenderer.invoke('desktop:open-data')},
 dialog:{chooseDirectory:()=>ipcRenderer.invoke('dialog:choose-directory'),chooseMineru:()=>ipcRenderer.invoke('dialog:choose-mineru')},
 window:{minimize:()=>ipcRenderer.send('window:minimize'),toggleMaximize:()=>ipcRenderer.send('window:toggle-maximize'),close:()=>ipcRenderer.send('window:close'),isMaximized:()=>ipcRenderer.invoke('window:is-maximized'),onMaximized:callback=>{const listener=(_e,payload)=>callback(payload);ipcRenderer.on('window:maximized',listener);return()=>ipcRenderer.removeListener('window:maximized',listener);}}
});

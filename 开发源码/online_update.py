"""Local desktop updater. GitHub credentials never enter UI exports or release files."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.request
import urllib.error
from urllib.parse import urlsplit
from deepseek_service import WindowsKeyVault

from app_version import VERSION
REPOSITORY='Maskicruis/fuyu-windfarm-digital-twin'
MAX_PACKAGE=512*1024*1024


class UpdateError(Exception):
    pass


def version(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d+\.\d+\.\d+',value):
        raise UpdateError('更新版本号格式无效')
    return tuple(map(int,value.split('.')))


def github_url(url):
    u=urlsplit(url)
    if u.scheme!='https' or u.username or u.password or u.port not in (None,443):
        raise UpdateError('更新地址必须是可信 HTTPS 地址')
    if u.hostname not in ['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']:
        raise UpdateError('更新服务重定向到未受信任的地址')
    return url


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        github_url(newurl)
        result=super().redirect_request(req,fp,code,msg,headers,newurl)
        if urlsplit(newurl).hostname!='api.github.com':
            result.remove_header('Authorization')
        return result


class UpdateVault(WindowsKeyVault):
    def __init__(self,root):
        super().__init__(root)
        self.path=Path(os.environ.get('LOCALAPPDATA',str(root)))/'FuyuUIStudio/credentials/github-updates.key'
        self.entropy=b'FuyuUIStudio:GitHubUpdater:v1'


class UpdateService:
    def __init__(self,workspace,assets,*,vault=None,opener=None,current=VERSION):
        self.workspace=Path(workspace);self.assets=Path(assets);self.current=current
        self.folder=self.workspace/'data/updates';self.folder.mkdir(parents=True,exist_ok=True)
        self.config_file=self.folder/'settings.json';self.vault=vault or UpdateVault(workspace)
        self.opener=opener or urllib.request.build_opener(SafeRedirect())
        self.lock=threading.RLock();self.busy=False;self.available=None;self.package=None
        self.target=None;self.exit_callback=None;self.port=0
        self.state={'phase':'idle','message':'点击检查更新','progress':0,'received':0,'total':0}

    def config(self):
        try:cfg=json.loads(self.config_file.read_text('utf-8'))
        except (OSError,ValueError):cfg={}
        return {'repository':cfg.get('repository',REPOSITORY)}

    def status(self):
        with self.lock:
            return {**self.state,**self.config(),'currentVersion':self.current,'busy':self.busy,
                    'availableVersion':self.available['version'] if self.available else None,
                    'notes':self.available.get('notes','') if self.available else '',
                    'canInstall':bool(self.target and self.exit_callback),'hasToken':bool(self.vault.path.exists())}

    def configure(self,patch):
        if not isinstance(patch,dict) or set(patch)-{'repository','token','clearToken'}:
            raise UpdateError('更新配置字段无效')
        with self.lock:
            if self.busy:raise UpdateError('更新任务进行中，请稍后修改配置')
            repository=patch.get('repository',self.config()['repository'])
            if not isinstance(repository,str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repository):
                raise UpdateError('仓库格式应为 owner/repository')
            if 'clearToken' in patch and not isinstance(patch['clearToken'],bool):raise UpdateError('清除令牌状态无效')
            token=patch.get('token','')
            if not isinstance(token,str) or len(token)>512 or any(ord(c)<33 or ord(c)>126 for c in token):
                raise UpdateError('GitHub 令牌格式无效')
            if token:self.vault.write(token)
            elif patch.get('clearToken'):self.vault.write('')
            self.config_file.write_text(json.dumps({'repository':repository}), 'utf-8')
            self.available=None;self.package=None;self.state={'phase':'idle','message':'更新配置已保存','progress':0}
            return self.status()

    def token(self):
        token=self.vault.read()
        if token:return token
        # Existing Windows Git login is a fallback; no Git dependency is required when a token is saved.
        git=shutil.which('git')
        if not git:return ''
        try:
            result=subprocess.run([git,'credential','fill'],input='protocol=https\nhost=github.com\n\n',text=True,
                capture_output=True,timeout=8,creationflags=0x08000000 if os.name=='nt' else 0,
                env={**os.environ,'GIT_TERMINAL_PROMPT':'0','GCM_INTERACTIVE':'Never'})
            return next((line.split('=',1)[1] for line in result.stdout.splitlines() if line.startswith('password=')), '')
        except (OSError,subprocess.TimeoutExpired):return ''

    def request(self,url,*,binary=False):
        github_url(url)
        headers={'Accept':'application/octet-stream' if binary else 'application/vnd.github+json',
                 'User-Agent':'Fuyu-Desktop-Updater/'+self.current,'X-GitHub-Api-Version':'2022-11-28'}
        token=self._token
        if token and urlsplit(url).hostname=='api.github.com':headers['Authorization']='Bearer '+token
        try:return self.opener.open(urllib.request.Request(url,headers=headers),timeout=45)
        except urllib.error.HTTPError as e:
            if e.code in (401,403,404):raise UpdateError('无法读取发布源；私有仓库请在此保存有 Contents:Read 权限的 GitHub 令牌，或使用本机已登录的 Git。') from None
            raise UpdateError('更新服务返回 HTTP '+str(e.code)) from None

    def json(self,url,*,binary=False):
        with self.request(url,binary=binary) as response:
            raw=response.read(1024*1024+1)
        if len(raw)>1024*1024:raise UpdateError('更新元数据过大')
        return json.loads(raw)

    def check(self):
        self._token=self.token();repository=self.config()['repository'];api='https://api.github.com/repos/'+repository
        releases=self.json(api+'/releases?per_page=30');choices=[]
        for release in releases:
            if release.get('draft') or release.get('prerelease'):continue
            tag=str(release.get('tag_name','')).removeprefix('v')
            try:parsed=version(tag)
            except UpdateError:continue
            asset=next((a for a in release.get('assets',[]) if a.get('name')=='fuyu-update.json' and a.get('state')=='uploaded'),None)
            if asset:choices.append((parsed,release,asset))
        if not choices:
            self.available=None;self.state.update(phase='current',message='当前没有兼容的在线更新发布',progress=0);return
        _,release,asset=max(choices,key=lambda x:x[0])
        if version(str(release['tag_name']).removeprefix('v'))<=version(self.current):
            self.available=None;self.state.update(phase='current',message='已是最新版本 V'+self.current,progress=0);return
        if type(asset.get('id')) is not int:raise UpdateError('更新清单资产无效')
        manifest=self.json(api+'/releases/assets/'+str(asset['id']),binary=True)
        self.available=self.validate_manifest(manifest,release)
        self.state.update(phase='available',message='发现新版本 V'+self.available['version'],progress=0)

    @staticmethod
    def validate_manifest(manifest,release):
        if not isinstance(manifest,dict) or manifest.get('schema')!='fuyu-desktop-update/v1' or manifest.get('product')!='fuyu-windfarm-digital-twin':
            raise UpdateError('更新清单产品或格式不匹配')
        v=manifest.get('version');version(v)
        if v!=str(release['tag_name']).removeprefix('v'):raise UpdateError('清单版本与发布标签不一致')
        a=manifest.get('windows-x64',{})
        if not isinstance(a,dict):raise UpdateError('更新安装包描述无效')
        filename=a.get('file','')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+\.exe',filename) or not re.fullmatch(r'[0-9a-f]{64}',a.get('sha256','')):
            raise UpdateError('更新安装包名称或校验值无效')
        size=a.get('size')
        if type(size) is not int or not 1024<=size<=MAX_PACKAGE:raise UpdateError('安装包大小无效')
        asset=next((x for x in release.get('assets',[]) if x.get('name')==filename and x.get('state')=='uploaded' and x.get('size')==size),None)
        if not asset or type(asset.get('id')) is not int:raise UpdateError('发布中缺少匹配的完整安装包')
        return {'version':v,'file':filename,'size':size,'sha256':a['sha256'],'id':asset['id'],
                'notes':str(manifest.get('notes',''))[:4000]}

    def download(self):
        if not self.available:raise UpdateError('请先检查更新')
        self._token=self.token();item=self.available;self.state.update(phase='downloading',message='正在下载并校验安装包',received=0,total=item['size'],progress=0)
        part=self.folder/(item['file']+'.part');destination=self.folder/item['file'];digest=hashlib.sha256();received=0
        try:
            with self.request('https://api.github.com/repos/'+self.config()['repository']+'/releases/assets/'+str(item['id']),binary=True) as response,part.open('wb') as output:
                while True:
                    chunk=response.read(256*1024)
                    if not chunk:break
                    received+=len(chunk)
                    if received>item['size']:raise UpdateError('下载内容超过清单声明大小')
                    digest.update(chunk);output.write(chunk)
                    with self.lock:self.state.update(received=received,progress=round(received*100/item['size'],1))
            if received!=item['size'] or digest.hexdigest()!=item['sha256']:raise UpdateError('安装包校验失败，当前程序未被修改，请重试下载')
            with part.open('rb') as source:
                if source.read(2)!=b'MZ':raise UpdateError('下载内容不是 Windows 程序')
            part.replace(destination);self.package=destination;self.state.update(phase='ready',message='下载及 SHA256 校验通过，可安装并重启',progress=100)
        finally:part.unlink(missing_ok=True)

    def install(self):
        if not self.target or not self.exit_callback:raise UpdateError('请在桌面 EXE 中安装更新；源码服务仅支持检查与下载')
        if self.state['phase']!='ready' or not self.package or not self.available:raise UpdateError('请先完成下载和校验')
        if hashlib.sha256(self.package.read_bytes()).hexdigest()!=self.available['sha256']:raise UpdateError('待安装文件发生变化，请重新下载')
        worker=self.folder/'install-update.ps1'
        # Windows PowerShell 5.1 requires a BOM for Chinese paths/messages in source files.
        worker.write_text((self.assets/'updater-worker.ps1').read_text('utf-8-sig'), 'utf-8-sig')
        args=['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(worker),'-Target',str(self.target),
              '-Package',str(self.package),'-ParentPid',str(os.getpid()),'-Workspace',str(self.workspace),
              '-ExpectedVersion',self.available['version'],'-ExpectedHash',self.available['sha256'],'-Port',str(self.port)]
        subprocess.Popen(args,creationflags=0x08000000,close_fds=True,
                         env={**os.environ,'PYINSTALLER_RESET_ENVIRONMENT':'1'})
        self.state.update(phase='installing',message='正在安装；程序将关闭并重新启动。更新不会替换 workspace。')
        threading.Timer(1.2,self.exit_callback).start()

    def start(self,action):
        if action not in ['check','download','install']:raise UpdateError('未知更新操作')
        with self.lock:
            if self.busy:raise UpdateError('更新任务正在执行')
            if action=='install':self.install();return self.status()
            self.busy=True;self.state.update(phase='checking' if action=='check' else 'downloading',message='正在检查发布源' if action=='check' else '正在下载',progress=0)
        def run():
            try:getattr(self,action)()
            except Exception as error:
                with self.lock:self.state.update(phase='error',message=str(error)[:500] if isinstance(error,UpdateError) else '更新连接失败，请检查网络后重试')
            finally:
                with self.lock:self.busy=False
        threading.Thread(target=run,daemon=True,name='fuyu-updater').start();return self.status()

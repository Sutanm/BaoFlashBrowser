import { session, BrowserWindow } from 'electron';
import log from 'electron-log';
import path from 'path';

export function initSession(getWindow: () => BrowserWindow | null): void {
  const defaultSession = session.defaultSession;

  defaultSession.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36',
  );

  // Serve permissive crossdomain.xml for Flash cross-origin requests
  const crossDomainXML = '<?xml version="1.0"?><!DOCTYPE cross-domain-policy SYSTEM "http://www.macromedia.com/xml/dtds/cross-domain-policy.dtd"><cross-domain-policy><allow-access-from domain="*"/></cross-domain-policy>';
  defaultSession.webRequest.onBeforeRequest(
    { urls: ['*://*/crossdomain.xml', '*://*/crossdomain.xml?*'] },
    (_details, callback) => {
      callback({ redirectURL: 'data:text/xml;charset=utf-8,' + encodeURIComponent(crossDomainXML) });
    },
  );

  // Intercept Taomee SWFObject and replace checkUpgrade with no-op
  defaultSession.webRequest.onBeforeRequest(
    { urls: ['*://webres.61.com/common/js/swfobject.js*'] },
    (_details, callback) => {
      callback({ redirectURL: 'data:text/javascript;charset=utf-8,' + encodeURIComponent(patchedSWFObject()) });
    },
  );

  // Handle downloads — track progress and send to renderer
  defaultSession.on('will-download', (_event, item) => {
    const downloadId = 'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const filename = item.getFilename() || item.getURL().split('/').pop() || 'download';

    const send = (payload: Record<string, unknown>) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('download:updated', { id: downloadId, ...payload });
      }
    };

    send({
      url: item.getURL(),
      filename,
      state: 'progressing',
      progress: 0,
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      mimeType: item.getMimeType(),
      savePath: item.getSavePath(),
      startTime: Date.now(),
    });

    let lastBytes = 0;
    let lastTime = Date.now();

    item.on('updated', () => {
      const now = Date.now();
      const received = item.getReceivedBytes();
      const total = item.getTotalBytes();
      const progr = total > 0 ? Math.round((received / total) * 100) : 0;
      const dt = (now - lastTime) / 1000;
      const speed = dt > 0 ? formatBytes((received - lastBytes) / dt) + '/s' : '—';

      send({
        state: item.getState() === 'completed' ? 'completed' :
              item.getState() === 'cancelled' ? 'cancelled' :
              item.getState() === 'interrupted' ? 'interrupted' : 'progressing',
        progress: progr,
        receivedBytes: received,
        totalBytes: total,
        speed,
      });

      lastBytes = received;
      lastTime = now;
    });

    item.on('done', () => {
      send({ state: 'completed', progress: 100, speed: '—' });
    });
  });

  log.info('[Session] initialized');
}

function formatBytes(bytesPerSec: number): string {
  if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(1) + ' MB';
  if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(0) + ' KB';
  return Math.round(bytesPerSec) + ' B';
}

export function patchedSWFObject(): string {
  // SWFObject with checkUpgrade replaced to always return false
  return `
var _swf_patched=1;
if("undefined"==typeof deconcept)var deconcept={};
"undefined"==typeof deconcept.util&&(deconcept.util={});
"undefined"==typeof deconcept.SWFObjectUtil&&(deconcept.SWFObjectUtil={});
deconcept.SWFObject=function(a,b,c,d,e,f,g,h,k,l){
  if(document.getElementById){
    this.DETECT_KEY=l?l:"detectflash";
    this.skipDetect=deconcept.util.getRequestParameter(this.DETECT_KEY);
    this.params={};this.variables={};this.attributes=[];
    if(a)this.setAttribute("swf",a);
    if(b)this.setAttribute("id",b);
    if(c)this.setAttribute("width",c);
    if(d)this.setAttribute("height",d);
    if(e)this.setAttribute("version",new deconcept.PlayerVersion(e.toString().split(".")));
    this.installedVer=deconcept.SWFObjectUtil.getPlayerVersion();
    if(!window.opera&&document.all&&7<this.installedVer.major)deconcept.SWFObject.doPrepUnload=!0;
    if(f)this.addParam("bgcolor",f);
    this.addParam("quality",g?g:"high");
    this.setAttribute("useExpressInstall",!1);
    this.setAttribute("doExpressInstall",!1);
    this.setAttribute("xiRedirectUrl",h?h:window.location);
    this.setAttribute("redirectUrl","");
    if(k)this.setAttribute("redirectUrl",k);
  }
};
deconcept.SWFObject.prototype={
  useExpressInstall:function(a){this.xiSWFPath=a?a:"expressinstall.swf";this.setAttribute("useExpressInstall",!0);},
  setAttribute:function(a,b){this.attributes[a]=b;},
  getAttribute:function(a){return this.attributes[a];},
  addParam:function(a,b){this.params[a]=b;},
  getParams:function(){return this.params;},
  addVariable:function(a,b){this.variables[a]=b;},
  getVariable:function(a){return this.variables[a];},
  getVariables:function(){return this.variables;},
  getVariablePairs:function(){
    var a=[],b,c=this.getVariables();
    for(b in c)a[a.length]=b+"="+c[b];
    return a;
  },
  getSWFHTML:function(){
    var a="";
    if(deconcept.SWFObjectUtil.isIE11()){
      this.getAttribute("doExpressInstall")&&(this.addVariable("MMplayerType","ActiveX"),this.setAttribute("swf",this.xiSWFPath));
      a='<object id="'+this.getAttribute("id")+'" type="application/x-shockwave-flash" width="'+this.getAttribute("width")+'" height="'+this.getAttribute("height")+'" style="'+this.getAttribute("style")+'">';
      a=a+('<param name="movie" value="'+this.getAttribute("swf")+'" />');
      var b=this.getParams(),c;
      for(c in b)a+='<param name="'+c+'" value="'+b[c]+'" />';
      c=this.getVariablePairs().join("&");
      0<c.length&&(a+='<param name="flashvars" value="'+c+'" />');
      a+="</object>";
    }else if(navigator.plugins&&navigator.mimeTypes&&navigator.mimeTypes.length){
      this.getAttribute("doExpressInstall")&&(this.addVariable("MMplayerType","PlugIn"),this.setAttribute("swf",this.xiSWFPath));
      a='<embed type="application/x-shockwave-flash" src="'+this.getAttribute("swf")+'" width="'+this.getAttribute("width")+'" height="'+this.getAttribute("height")+'" style="'+this.getAttribute("style")+'"';
      a+=' id="'+this.getAttribute("id")+'" name="'+this.getAttribute("id")+'" ';
      b=this.getParams();
      for(c in b)a+=[c]+'="'+b[c]+'" ';
      c=this.getVariablePairs().join("&");
      0<c.length&&(a+='flashvars="'+c+'"');
      a+="/>";
    }else{
      this.getAttribute("doExpressInstall")&&(this.addVariable("MMplayerType","ActiveX"),this.setAttribute("swf",this.xiSWFPath));
      a='<object id="'+this.getAttribute("id")+'" classid="clsid:D27CDB6E-AE6D-11cf-96B8-444553540000" width="'+this.getAttribute("width")+'" height="'+this.getAttribute("height")+'" style="'+this.getAttribute("style")+'">';
      a+='<param name="movie" value="'+this.getAttribute("swf")+'" />';
      b=this.getParams();
      for(c in b)a+='<param name="'+c+'" value="'+b[c]+'" />';
      c=this.getVariablePairs().join("&");
      0<c.length&&(a+='<param name="flashvars" value="'+c+'" />');
      a+="</object>";
    }
    return a;
  },
  upgrade:function(a){
    var b=this.getAttribute("micro")?this.getAttribute("micro"):false;
    var c=b?("//webres.61.com/common/flash/upgrade_micro.html?m="+b):"//webres.61.com/common/flash/upgrade.html";
    a=("string"==typeof a?document.getElementById(a):a);
    a.innerHTML='<iframe style="width:100%;height:100%" src="'+c+'"></iframe>';
  },
  checkUpgrade:function(a){return false;},
  write:function(a){
    if(this.getAttribute("useExpressInstall")){
      var b=new deconcept.PlayerVersion([6,0,65]);
      this.installedVer.versionIsValid(b)&&!this.installedVer.versionIsValid(this.getAttribute("version"))&&(this.setAttribute("doExpressInstall",!0),this.addVariable("MMredirectURL",encodeURIComponent(this.getAttribute("xiRedirectUrl"))),document.title=document.title.slice(0,47)+" - Flash Player Installation",this.addVariable("MMdoctitle",document.title));
    }
    if(this.skipDetect||this.getAttribute("doExpressInstall")||this.installedVer.versionIsValid(this.getAttribute("version"))){
      ("string"==typeof a?document.getElementById(a):a).innerHTML=this.getSWFHTML();
      navigator.plugins&&navigator.mimeTypes.length||(window[this.getAttribute("id")]=document.getElementById(this.getAttribute("id")));
      this.checkUpgrade(a);
      return!0;
    }
    ""!=this.getAttribute("redirectUrl")&&document.location.replace(this.getAttribute("redirectUrl"));
    this.checkUpgrade(a);
    return!1;
  }
};
deconcept.SWFObjectUtil.getPlayerVersion=function(){
  var a=new deconcept.PlayerVersion([0,0,0]);
  if(navigator.plugins&&navigator.mimeTypes.length&&!deconcept.SWFObjectUtil.isIE11()){
    var b=navigator.plugins["Shockwave Flash"];
    b&&b.description&&(a=new deconcept.PlayerVersion(b.description.replace(/([a-zA-Z]|\\s)+/,"").replace(/(\\s+r|\\s+b[0-9]+)/,".").split(".")));
  }else if(navigator.userAgent&&0<=navigator.userAgent.indexOf("Windows CE"))for(b=1,c=3;b;)try{c++,b=new ActiveXObject("ShockwaveFlash.ShockwaveFlash."+c),a=new deconcept.PlayerVersion([c,0,0]);}catch(d){b=null;}
  else{try{b=new ActiveXObject("ShockwaveFlash.ShockwaveFlash.7");}catch(d){try{b=new ActiveXObject("ShockwaveFlash.ShockwaveFlash.6"),a=new deconcept.PlayerVersion([6,0,21]),b.AllowScriptAccess="always";}catch(e){if(6==a.major)return a;}try{b=new ActiveXObject("ShockwaveFlash.ShockwaveFlash");}catch(e){}}null!=b&&(a=new deconcept.PlayerVersion(b.GetVariable("\\$version").split(" ")[1].split(",")));}
  return a;
};
deconcept.PlayerVersion=function(a){this.major=null!=a[0]?parseInt(a[0]):0;this.minor=null!=a[1]?parseInt(a[1]):0;this.rev=null!=a[2]?parseInt(a[2]):0;};
deconcept.PlayerVersion.prototype.versionIsValid=function(a){return this.major<a.major?!1:this.major>a.major?!0:this.minor<a.minor?!1:this.minor>a.minor?!0:this.rev<a.rev?!1:!0;};
deconcept.util={getRequestParameter:function(a){var b=document.location.search||document.location.hash;if(null==a)return b;if(b)for(b=b.substring(1).split("&"),c=0;c<b.length;c++)if(b[c].substring(0,b[c].indexOf("="))==a)return b[c].substring(b[c].indexOf("=")+1);return"";}};
deconcept.SWFObjectUtil.isIE11=function(){return document.documentMode&&!window.attachEvent;};
deconcept.SWFObjectUtil.cleanupSWFs=function(){for(var a=document.getElementsByTagName("OBJECT"),b=a.length-1;0<=b;b--){a[b].style.display="none";for(var c in a[b])"function"==typeof a[b][c]&&(a[b][c]=function(){});}};
deconcept.SWFObject.doPrepUnload&&!deconcept.unloadSet&&(deconcept.SWFObjectUtil.prepUnload=function(){__flash_unloadHandler=function(){};__flash_savedUnloadHandler=function(){};window.attachEvent("onunload",deconcept.SWFObjectUtil.cleanupSWFs);},window.attachEvent("onbeforeunload",deconcept.SWFObjectUtil.prepUnload),deconcept.unloadSet=!0);
!document.getElementById&&document.all&&(document.getElementById=function(a){return document.all[a];});
window.getQueryParamValue=deconcept.util.getRequestParameter;
window.FlashObject=deconcept.SWFObject;
window.SWFObject=deconcept.SWFObject;
`.trim();
}

export function clearCache(): void {
  const defaultSession = session.defaultSession;
  defaultSession.clearCache().then(() => {
    log.info('[Session] cache cleared');
  });
}

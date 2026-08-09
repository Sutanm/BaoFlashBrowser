import { session } from 'electron';
import log from 'electron-log';
import type { Session } from 'electron';
import { chunkRedirectUrl } from './js-patch-service';
import { setupDownloadHandlers } from './download';
import { getWebRequestObserver } from './userscripts';

const setupPartitions = new Set<string>();

export function patchedSWFObject(): string {
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

export function applyCompatibilitySessionConfig(sess: Session): void {
  sess.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36',
  );

  // Old game pages should not inherit broad device permissions from Chromium 87.
  // Fullscreen and pointer lock remain available for game interaction.
  const gamePermissions = new Set(['fullscreen', 'pointerLock']);
  sess.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(gamePermissions.has(permission));
  });

  // Keep Flash policy files on their original origin. PPAPI treats redirects
  // from crossdomain.xml to a data: URL as aborted, which breaks remote game
  // services after login. Only Taomee's legacy Flash-version gate is patched.
  // This is the SINGLE onBeforeRequest listener for the session: Electron 11
  // webRequest listeners replace each other on re-registration, so the
  // ES2022 chunk patch (js-patch-service) shares this callback.
  sess.webRequest.onBeforeRequest(
    { urls: ['*://*/*'] },
    (details: any, callback: any) => {
      try {
        const jsRedirect = chunkRedirectUrl(details.url);
        if (jsRedirect) {
          callback({ redirectURL: jsRedirect });
          return;
        }
        const requestUrl = new URL(details.url);
        if (requestUrl.hostname === 'webres.61.com' && requestUrl.pathname === '/common/js/swfobject.js') {          callback({ redirectURL: 'data:text/javascript;charset=utf-8,' + encodeURIComponent(patchedSWFObject()) });
          return;
        }
      } catch { /* let malformed/unexpected requests continue unchanged */ }
      // GM_webRequest observation: dispatch to interested scripts, never intercept.
      try {
        getWebRequestObserver()?.notifyBeforeRequest({
          url: details.url,
          method: details.method ?? 'GET',
          webContentsId: Number(details.webContentsId),
        });
      } catch { /* observation must never break the request */ }
      callback({});
    },
  );

  // CORS 头注入：仅对 .swf 文件，避免 Ruffle 跨域 fetch 失败
  // 收窄范围到 SWF，不全局注入以防过度宽松
  sess.webRequest.onHeadersReceived(
    { urls: ['*://*/*.swf', '*://*/*.swf?*'] },
    (details: any, callback: any) => {
      const responseHeaders = details.responseHeaders || {};
      responseHeaders['Access-Control-Allow-Origin'] = ['*'];
      responseHeaders['Access-Control-Allow-Methods'] = ['GET, POST, HEAD, OPTIONS'];
      responseHeaders['Access-Control-Allow-Headers'] = ['*'];
      callback({ responseHeaders });
    },
  );

  // GM_webRequest observation: onCompleted/onErrorOccurred are unoccupied in
  // Electron 11 (only onBeforeRequest/onHeadersReceived are taken above), so
  // the observer registers them directly.
  getWebRequestObserver()?.attach(sess);

}

function applySessionConfig(sess: Session): void {
  applyCompatibilitySessionConfig(sess);
  // Unified download handler (Chromium tracking or aria2)
  setupDownloadHandlers(sess);
}

/**
 * One-time session configuration per partition:
 * - Sets user agent
 * - Leaves each site's native Flash crossdomain.xml policy untouched
 * - Redirects Taomee swfobject.js to patched version
 * - Registers unified download handlers (Chromium tracking + aria2)
 *
 * AGENTS.md: tabs use persist: partition, defaultSession must also be configured separately
 */
export function setupSessionOnce(sess: Session): void {
  const partition = (sess as any).partition || '__default__';
  if (setupPartitions.has(partition)) return;
  setupPartitions.add(partition);
  applySessionConfig(sess);
  log.info(`[SessionManager] configured partition: ${partition}`);
}

/** Compatibility entry point — configures both defaultSession and persist: partition. */
export function initSession(): void {
  setupSessionOnce(session.defaultSession);
  setupSessionOnce(session.fromPartition('persist:'));
}


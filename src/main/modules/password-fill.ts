import type { WebContents } from 'electron';
import log from 'electron-log';
import type { FillCredential } from './password-store';
import { getCaptureContextIds } from './password-capture';

export interface PasswordFillResult {
  success: boolean;
  filledFields: number;
  filledCredentials: number;
  usernames: string[];
  reason?: 'no-credential' | 'no-form' | 'debugger-unavailable' | 'destroyed';
}

interface ScriptFillResult {
  filledFields?: number;
  filledCredentials?: number;
}

export function buildPasswordFillExpression(username: string, password: string): string {
  const fillFunction = `(function(savedUsername,savedPassword){
    function usable(input){
      if(input.disabled||input.readOnly||input.type==='hidden')return false;
      var style=window.getComputedStyle(input);
      if(style.display==='none'||style.visibility==='hidden'||style.opacity==='0')return false;
      var rect=input.getBoundingClientRect();
      return rect.width>0&&rect.height>0;
    }
    function setNativeValue(input,value){
      var oldValue=input.value;
      var descriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
      if(descriptor&&descriptor.set)descriptor.set.call(input,value);else input.value=value;
      var tracker=input._valueTracker;
      if(tracker)tracker.setValue(oldValue);
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    // 站点常把提示文字直接写在账号框的 value 上（而不是 placeholder），并在点击时
    // 清空、失焦时回填。实测 7k7k 登录层：#un_name value="用户名/邮箱/KK号"，
    // 点击才清空。旧逻辑把这种"从没被用户编辑过的默认文本"当成"用户已填了别的账号"，
    // 于是整个填充（连密码一起）直接放弃 —— 用户看到的就是"必须点一下账号密码框"。
    // 判据刻意收紧到"HTML 的 value 属性本身就是提示文字、且 DOM 值仍与之一致"，
    // 即这串文字从未被改写过；用户真敲进去的同名文字（value 属性为空）不受影响。
    function hintValue(input){
      var value=input.value||'';
      if(!value)return '';
      var trimmed=value.trim();
      var hint=(input.getAttribute('placeholder')||input.getAttribute('aria-label')||'').trim();
      var initial=(input.getAttribute('value')||'').trim();
      if(hint&&initial&&trimmed===hint&&initial===trimmed)return '';
      return value;
    }
    function findUsername(scope,passwordInput){
      var inputs=Array.prototype.slice.call(scope.querySelectorAll('input'));
      var candidates=inputs.filter(function(input){
        var type=(input.type||'text').toLowerCase();
        return type!=='password'&&['text','email','tel',''].indexOf(type)>=0&&usable(input);
      });
      var match=candidates.find(function(input){return(input.autocomplete||'').toLowerCase()==='username';});
      if(!match)match=candidates.find(function(input){
        return /user|login|account|email|phone|mobile|name|用户|账号|帐号|邮箱|手机/i.test(
          [input.name,input.id,input.placeholder,input.getAttribute('aria-label')||''].join(' '));
      });
      if(!match){
        var passwordIndex=inputs.indexOf(passwordInput);
        match=candidates.filter(function(input){return inputs.indexOf(input)<passwordIndex;}).pop();
      }
      return match||null;
    }
    var passwordInputs=Array.prototype.slice.call(document.querySelectorAll('input[type="password"]'));
    var filledFields=0,filledCredentials=0,visited=new Set();
    passwordInputs.forEach(function(passwordInput){
      if(!usable(passwordInput)||passwordInput.value)return;
      var autocomplete=(passwordInput.autocomplete||'').toLowerCase();
      if(autocomplete==='new-password'||autocomplete==='one-time-code')return;
      var scope=passwordInput.form||passwordInput.closest('form')||
        passwordInput.closest('[role="form"], [class*="login" i], [id*="login" i]')||document;
      if(visited.has(scope))return;
      visited.add(scope);
      var scopedPasswords=Array.prototype.slice.call(scope.querySelectorAll('input[type="password"]')).filter(usable);
      if(scopedPasswords.length!==1||scopedPasswords.some(function(input){
        return(input.autocomplete||'').toLowerCase()==='new-password';
      }))return;
      var formText='';
      if(scope!==document){
        formText=[scope.id||'',scope.className||'',scope.getAttribute('name')||'',scope.getAttribute('action')||'',
          passwordInput.name||'',passwordInput.id||'',passwordInput.placeholder||''].join(' ');
        var submit=scope.querySelector('button[type="submit"],input[type="submit"]');
        if(submit)formText+=' '+(submit.textContent||submit.value||'');
      }
      if(/register|sign[\\s_-]*up|create[\\s_-]*account|join[\\s_-]*now|注册|创建账号|创建帐号/i.test(formText))return;
      var usernameInput=findUsername(scope,passwordInput);
      var currentUsername=usernameInput?hintValue(usernameInput):'';
      if(currentUsername&&currentUsername!==savedUsername)return;
      if(usernameInput&&!currentUsername&&savedUsername){setNativeValue(usernameInput,savedUsername);filledFields+=1;}
      setNativeValue(passwordInput,savedPassword);filledFields+=1;filledCredentials+=1;
    });
    return{filledFields:filledFields,filledCredentials:filledCredentials};
  })`;
  return `${fillFunction}(${JSON.stringify(username)},${JSON.stringify(password)})`;
}

async function evaluate(debuggerApi: WebContents['debugger'], expression: string, contextId?: number): Promise<{ result?: { value?: unknown } }> {
  const params: Record<string, unknown> = { expression, returnByValue: true, userGesture: true };
  if (contextId !== undefined) params.contextId = contextId;
  return debuggerApi.sendCommand('Runtime.evaluate', params);
}

export async function fillPasswordsInWebContents(
  wc: WebContents,
  resolveCredential: (frameUrl: string) => FillCredential | null,
): Promise<PasswordFillResult> {
  const empty: PasswordFillResult = { success: false, filledFields: 0, filledCredentials: 0, usernames: [] };
  if (wc.isDestroyed()) return { ...empty, reason: 'destroyed' };

  const contexts = new Set<number>(getCaptureContextIds(wc));
  let attachedHere = false;
  const onMessage = (_event: Electron.Event, method: string, params: { context?: { id?: unknown }; executionContextId?: unknown }): void => {
    if (method === 'Runtime.executionContextCreated' && typeof params?.context?.id === 'number') {
      contexts.add(params.context.id);
    } else if (method === 'Runtime.executionContextDestroyed' && typeof params?.executionContextId === 'number') {
      contexts.delete(params.executionContextId);
    } else if (method === 'Runtime.executionContextsCleared') {
      contexts.clear();
    }
  };

  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
    }
    wc.debugger.on('message', onMessage);
    if (attachedHere) {
      await wc.debugger.sendCommand('Runtime.enable');
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    const targets: Array<number | undefined> = contexts.size ? [...contexts] : [undefined];
    const usernames = new Set<string>();
    let matchedCredential = false;
    let filledFields = 0;
    let filledCredentials = 0;

    for (const contextId of targets) {
      try {
        const locationResult = await evaluate(wc.debugger, 'location.href', contextId);
        const frameUrl = locationResult?.result?.value;
        if (typeof frameUrl !== 'string') continue;
        const credential = resolveCredential(frameUrl);
        if (!credential) continue;
        matchedCredential = true;
        const result = await evaluate(
          wc.debugger,
          buildPasswordFillExpression(credential.username, credential.password),
          contextId,
        );
        const value = result?.result?.value as ScriptFillResult | undefined;
        if (!value) continue;
        filledFields += Number(value.filledFields) || 0;
        filledCredentials += Number(value.filledCredentials) || 0;
        if ((Number(value.filledCredentials) || 0) > 0) usernames.add(credential.username);
      } catch {
        // A frame can disappear while a page is loading; the scheduled retry handles it.
      }
    }

    return {
      success: filledCredentials > 0,
      filledFields,
      filledCredentials,
      usernames: [...usernames],
      reason: filledCredentials > 0 ? undefined : (matchedCredential ? 'no-form' : 'no-credential'),
    };
  } catch (error) {
    log.debug('[PasswordFill] CDP unavailable:', error instanceof Error ? error.message : 'Unknown error');
    return { ...empty, reason: 'debugger-unavailable' };
  } finally {
    try { wc.debugger.removeListener('message', onMessage); } catch { /* destroyed */ }
    if (attachedHere) {
      try { wc.debugger.detach(); } catch { /* destroyed or already detached */ }
    }
  }
}

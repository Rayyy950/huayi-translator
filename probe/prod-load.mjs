import { spawn } from 'node:child_process';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT='/tmp/huayi-prod-load', PORT=9241;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class CDP{constructor(u){this.ws=new WebSocket(u);this.id=0;this.p=new Map();this.errs=[];this.ready=new Promise((res,rej)=>{this.ws.onopen=res;this.ws.onerror=rej});this.ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const q=this.p.get(m.id);this.p.delete(m.id);m.error?q.rej(new Error(JSON.stringify(m.error))):q.res(m.result)}else if(m.method==='Runtime.exceptionThrown')this.errs.push(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text);else if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')this.errs.push(m.params.args.map(a=>a.value??a.description).join(' '))}}
send(method,params={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('timeout'))}},30000)})}
async eval(e){const r=await this.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async clickTestId(id){const r=await this.eval(`(()=>{const el=document.querySelector('[data-testid="${id}"]');if(!el)return null;el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);if(!r)return false;for(const t of ['mouseMoved','mousePressed','mouseReleased'])await this.send('Input.dispatchMouseEvent',{type:t,x:r.x,y:r.y,button:'left',clickCount:1});return true}}
async function j(u){for(let i=0;i<80;i++){try{const r=await fetch(u);if(r.ok)return r.json()}catch{}await sleep(200)}throw new Error('timeout')}
const chrome=spawn(CHROME,[`--user-data-dir=/tmp/huayi-prod-profile`,`--remote-debugging-port=${PORT}`,'--enable-unsafe-extension-debugging','--no-first-run','--no-default-browser-check','--window-size=1280,900','about:blank'],{stdio:'ignore'});
const out={};
try{
 const v=await j(`http://127.0.0.1:${PORT}/json/version`);const b=new CDP(v.webSocketDebuggerUrl);await b.ready;
 const {id:extId}=await b.send('Extensions.loadUnpacked',{path:EXT});out.extId=extId;await sleep(2000);
 await b.send('Target.createTarget',{url:`chrome-extension://${extId}/options.html`});await sleep(2000);
 let list=await j(`http://127.0.0.1:${PORT}/json/list`);const t=list.find(x=>x.url===`chrome-extension://${extId}/options.html`);const p=new CDP(t.webSocketDebuggerUrl);await p.ready;await p.send('Runtime.enable');
 out.optionsText=(await p.eval(`document.body.innerText.slice(0,500)`)).replace(/\s+/g,' ').slice(0,300);
 out.permissionsBefore=JSON.parse(await p.eval(`chrome.permissions.getAll().then(x=>JSON.stringify(x))`));
 out.clicked=await p.clickTestId('grant-all');
 await sleep(3500);
 out.permissionsAfter=JSON.parse(await p.eval(`chrome.permissions.getAll().then(x=>JSON.stringify(x))`));
 out.afterClickText=(await p.eval(`document.body.innerText.slice(0,800)`)).replace(/\s+/g,' ').slice(0,500);
 out.errors=p.errs;
 await b.send('Target.createTarget',{url:'http://localhost:8787/index.html'});
 await sleep(3000);
 list=await j(`http://127.0.0.1:${PORT}/json/list`);const f=list.find(x=>x.url.includes('localhost:8787'));
 if(f){const fp=new CDP(f.webSocketDebuggerUrl);await fp.ready;await fp.send('Runtime.enable');await sleep(1000);out.contentInjected=await fp.eval(`!!document.querySelector('[data-huayi-host]')`);fp.ws.close()}
 p.ws.close();
}catch(e){out.error=String(e)}finally{
 try{const v=await j(`http://127.0.0.1:${PORT}/json/version`,5);const bb=new CDP(v.webSocketDebuggerUrl);await bb.ready;await bb.send('Browser.close')}catch{}
 chrome.kill('SIGTERM');console.log(JSON.stringify(out,null,2));setTimeout(()=>process.exit(0),400);
}

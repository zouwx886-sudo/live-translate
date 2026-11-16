(function(){
'use strict';
var STORE='lt_transcript_v1', FONT='lt_font_v1';
var $=function(id){return document.getElementById(id)};
var logEl=$('log'), interimEl=$('interim'), statusEl=$('status'), msgEl=$('msg'), btn=$('toggle');
var entries=[];
try{entries=JSON.parse(localStorage.getItem(STORE)||'[]')}catch(e){entries=[]}
var zhSize=parseInt(localStorage.getItem(FONT)||'24',10);
var running=false, rec=null, wakeLock=null, restartTimer=null, fatal=false, lastStart=0;

var ua=navigator.userAgent||'';
var isIOS=/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
var isAndroid=/Android/i.test(ua);
var SR=window.SpeechRecognition||window.webkitSpeechRecognition;

function showMsg(t,err){msgEl.textContent=t;msgEl.className=err?'err':'';msgEl.style.display=t?'block':'none'}
function setStatus(t,on){statusEl.textContent=t;statusEl.className=on?'on':''}
function save(){try{localStorage.setItem(STORE,JSON.stringify(entries,function(k,v){return k==='_el'?undefined:v}))}catch(e){}}
function pad(n){return (n<10?'0':'')+n}
function fmt(ts){var d=new Date(ts);return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())}
function nearBottom(){return logEl.scrollHeight-logEl.scrollTop-logEl.clientHeight<120}
function scrollDown(){logEl.scrollTop=logEl.scrollHeight}
function applyFont(){document.querySelectorAll('.zh').forEach(function(z){if(!z.classList.contains('pending'))z.style.fontSize=zhSize+'px'});localStorage.setItem(FONT,zhSize)}

function render(e){
  var d=e._el;
  if(!d){d=document.createElement('div');d.className='entry';d.innerHTML='<div class="meta"></div><div class="en"></div><div class="zh"></div>';e._el=d;logEl.appendChild(d)}
  d.children[0].textContent=fmt(e.t);
  d.children[1].textContent=e.en;
  var z=d.children[2];
  if(e.zh){z.textContent=e.zh;z.className='zh';z.style.fontSize=zhSize+'px'}
  else if(e.failed){z.textContent='（翻译失败，点这里重试）';z.className='zh pending';z.onclick=function(){e.failed=false;render(e);translate(e)}}
  else{z.textContent='翻译中…';z.className='zh pending'}
}
function renderAll(){
  logEl.innerHTML='';
  if(!entries.length){logEl.innerHTML='<div id="empty">点下面的「开始」，把手机对着老师。<br>英文会自动翻译成中文。</div>';return}
  entries.forEach(function(e){e._el=null;render(e)});
  scrollDown();
}

// ---- translation (keyless, CORS-enabled endpoints, tried in order) ----
function fetchT(url,ms){
  var c=window.AbortController?new AbortController():null;
  var t=setTimeout(function(){c&&c.abort()},ms||8000);
  return fetch(url,c?{signal:c.signal}:{}).then(function(r){clearTimeout(t);if(!r.ok)throw new Error('HTTP '+r.status);return r.json()});
}
var providers=[
  function(q){ // Google (dict-chrome-ex)
    return fetchT('https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=zh-CN&q='+encodeURIComponent(q)).then(function(j){
      var x=Array.isArray(j)?j[0]:null; if(Array.isArray(x))x=x[0]; if(!x||typeof x!=='string')throw new Error('bad');return x})},
  function(q){ // Google (gtx)
    return fetchT('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q='+encodeURIComponent(q)).then(function(j){
      var s=(j&&j[0]||[]).map(function(p){return p[0]}).join('');if(!s)throw new Error('bad');return s})},
  function(q){ // MyMemory
    return fetchT('https://api.mymemory.translated.net/get?langpair=en|zh-CN&q='+encodeURIComponent(q.slice(0,480))).then(function(j){
      var s=j&&j.responseData&&j.responseData.translatedText;if(!s||j.responseStatus!=200||/MYMEMORY WARNING/i.test(s))throw new Error('bad');return s})}
];
var pref=0;
function translate(e){
  var i=0,order=providers.slice(pref).concat(providers.slice(0,pref));
  function next(){
    if(i>=order.length){e.failed=true;render(e);save();
      if(!navigator.onLine)showMsg('没有网络：英文还会继续记录，联网后点「翻译失败」那条可以重试。',true);return}
    var idx=(pref+i)%providers.length;
    order[i++](e.en).then(function(zh){pref=idx;e.zh=zh;e.failed=false;var b=nearBottom();render(e);save();if(b)scrollDown();
      if(msgEl.textContent.indexOf('没有网络')===0)showMsg('')}).catch(next);
  }
  next();
}

function addFinal(text){
  text=(text||'').trim(); if(!text)return;
  var emp=$('empty'); if(emp)emp.remove();
  var b=nearBottom();
  var e={t:Date.now(),en:text,zh:''};
  entries.push(e); render(e); save(); if(b)scrollDown();
  translate(e);
}

// ---- speech recognition ----
function makeRec(){
  var r=new SR();
  r.lang='en-US'; r.continuous=true; r.interimResults=true; r.maxAlternatives=1;
  r.onstart=function(){setStatus('● 正在听…（英文 → 中文）',true)};
  r.onresult=function(ev){
    var interim='';
    for(var i=ev.resultIndex;i<ev.results.length;i++){
      var res=ev.results[i];
      if(res.isFinal)addFinal(res[0].transcript); else interim+=res[0].transcript;
    }
    interimEl.textContent=interim;
  };
  r.onerror=function(ev){
    var er=ev.error;
    if(er==='not-allowed'||er==='service-not-allowed'){
      fatal=true;
      showMsg(isIOS?'麦克风权限被拒绝。请到 iPhone「设置 → Safari 浏览器 → 麦克风」改成「允许」，并在「设置 → 隐私与安全性 → 语音识别」里允许 Safari，然后刷新页面。'
        :'麦克风权限被拒绝。请点地址栏左边的锁/设置图标 → 权限 → 麦克风 → 允许，然后刷新页面。（从桌面图标打开的话：长按图标 → 应用信息 → 权限 → 麦克风）',true);
      stop();
    }else if(er==='audio-capture'){fatal=true;showMsg('找不到麦克风，或者麦克风被别的 App（比如录音、通话）占用了。',true);stop()}
    else if(er==='network'){showMsg('语音识别需要联网，网络不稳定，正在重试…',true)}
    else if(er==='language-not-supported'){fatal=true;showMsg('这个浏览器不支持英文语音识别。',true);stop()}
    // 'no-speech' / 'aborted' -> just restart via onend
  };
  r.onend=function(){
    interimEl.textContent='';
    if(running&&!fatal){
      setStatus('重新连接中…',false);
      var wait=(Date.now()-lastStart<1000)?1000:150; // avoid tight loops
      clearTimeout(restartTimer);
      restartTimer=setTimeout(startRec,wait);
    }
  };
  return r;
}
function startRec(){
  if(!running)return;
  try{rec=makeRec();lastStart=Date.now();rec.start()}
  catch(e){clearTimeout(restartTimer);restartTimer=setTimeout(startRec,1000)}
}
function start(){
  if(!SR){unsupported();return}
  fatal=false; running=true; showMsg('');
  btn.textContent='停止'; btn.classList.add('running');
  startRec(); keepAwake();
}
function stop(){
  running=false; clearTimeout(restartTimer);
  try{rec&&rec.stop()}catch(e){}
  btn.textContent='开始'; btn.classList.remove('running');
  setStatus('已停止',false); interimEl.textContent='';
  releaseAwake();
}

// ---- wake lock ----
function keepAwake(){
  if('wakeLock' in navigator){
    navigator.wakeLock.request('screen').then(function(l){wakeLock=l;l.addEventListener('release',function(){wakeLock=null})}).catch(function(){});
  }
}
function releaseAwake(){try{wakeLock&&wakeLock.release()}catch(e){}wakeLock=null}
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='visible'&&running){if(!wakeLock)keepAwake();
    // browsers often kill recognition in the background; kick it
    clearTimeout(restartTimer);restartTimer=setTimeout(function(){try{rec&&rec.abort()}catch(e){}startRec()},300);}
});

function unsupported(){
  btn.disabled=true;btn.style.opacity=.5;
  showMsg(isIOS?'这个浏览器不支持语音识别。iPhone 请用 Safari 打开本页面（iOS 14.5 以上），不要用微信/QQ 里的内置浏览器。'
    :isAndroid?'这个浏览器不支持语音识别。安卓手机请用 Google Chrome 打开本页面，不要用微信/QQ 或手机自带浏览器。'
    :'这个浏览器不支持语音识别。请用 Chrome（安卓/电脑）或 Safari（iPhone）打开。',true);
}

// ---- buttons ----
btn.onclick=function(){running?stop():start()};
$('clear').onclick=function(){
  if(!entries.length)return;
  if(confirm('确定清空全部记录吗？建议先「导出笔记」。')){entries=[];save();renderAll()}
};
$('export').onclick=function(){
  if(!entries.length){alert('还没有内容');return}
  var d=new Date(entries[0].t);
  var name='课堂笔记_'+d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+'_'+pad(d.getHours())+pad(d.getMinutes())+'.txt';
  var txt='课堂实时翻译笔记  '+d.toLocaleString('zh-CN')+'\n\n'+entries.map(function(e){
    return '['+fmt(e.t)+']\nEN: '+e.en+'\n中: '+(e.zh||'（未翻译）')}).join('\n\n')+'\n';
  var blob=new Blob(['\ufeff'+txt],{type:'text/plain;charset=utf-8'});
  var file=null; try{file=new File([blob],name,{type:'text/plain'})}catch(e){}
  if(file&&navigator.canShare&&navigator.canShare({files:[file]})&&isIOS){
    navigator.share({files:[file],title:name}).catch(function(){download(blob,name)});
  }else download(blob,name);
};
function download(blob,name){
  var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},2000);
}
$('bigger').onclick=function(){zhSize=Math.min(44,zhSize+2);applyFont()};
$('smaller').onclick=function(){zhSize=Math.max(16,zhSize-2);applyFont()};
window.addEventListener('online',function(){entries.forEach(function(e){if(e.failed){e.failed=false;render(e);translate(e)}})});

// ---- init ----
renderAll();
entries.forEach(function(e){if(!e.zh&&!e.failed)translate(e)});
if(!SR)unsupported();
else if(!window.isSecureContext)showMsg('需要用 https 网址打开才能用麦克风。',true);
if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('sw.js').catch(function(){})})}
})();

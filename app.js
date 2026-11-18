(function(){
'use strict';
var STORE='lt_transcript_v1', FONT='lt_font_v1', LANG_KEY='lt_lang_v1', METER_KEY='lt_meter_v1';
var LANGS=['en-GB','en-US','en-IN','en-AU','en-SG'];
var $=function(id){return document.getElementById(id)};
var logEl=$('log'), interimEl=$('interim'), statusEl=$('status'), msgEl=$('msg'), btn=$('toggle');
var hintEl=$('hint'), meterWrap=$('meter-wrap'), meterFill=$('meter-fill'), meterBtn=$('meterBtn'), langEl=$('lang');
var entries=[];
try{entries=JSON.parse(localStorage.getItem(STORE)||'[]')}catch(e){entries=[]}
var zhSize=parseInt(localStorage.getItem(FONT)||'24',10);
var running=false, rec=null, wakeLock=null, restartTimer=null, watchdogTimer=null, fatal=false, lastStart=0;
var backoff=150, pendingInterim='', langTried={};

var savedLang=localStorage.getItem(LANG_KEY)||'en-GB';
if(LANGS.indexOf(savedLang)<0)savedLang='en-GB';
var lang=savedLang;
langEl.value=lang;

var meterEnabled=localStorage.getItem(METER_KEY);
meterEnabled=meterEnabled===null?true:meterEnabled!=='0';
var meterStream=null, audioCtx=null, analyser=null, meterRaf=0, lastLoud=0, meterOk=false;
var timeBuf=null;

var ua=navigator.userAgent||'';
var isIOS=/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
var isAndroid=/Android/i.test(ua);
var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
var blockedApp=detectBlockedApp();

function detectBlockedApp(){
  if(/MicroMessenger/i.test(ua))return 'wechat';
  if(/MQQBrowser/i.test(ua)||/(?:^|[^\w])QQ\//i.test(ua))return 'qq';
  if(/VivoBrowser/i.test(ua))return 'vivo';
  return null;
}

function showMsg(t,err){msgEl.textContent=t;msgEl.className=err?'err':'';msgEl.style.display=t?'block':'none'}
function showHint(t){hintEl.textContent=t||'';hintEl.style.display=t?'block':'none'}
function setStatus(t,on){statusEl.textContent=t;statusEl.className=on?'on':''}
function save(){try{localStorage.setItem(STORE,JSON.stringify(entries,function(k,v){return k==='_el'?undefined:v}))}catch(e){}}
function pad(n){return (n<10?'0':'')+n}
function fmt(ts){var d=new Date(ts);return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())}
function nearBottom(){return logEl.scrollHeight-logEl.scrollTop-logEl.clientHeight<120}
function scrollDown(){logEl.scrollTop=logEl.scrollHeight}
function applyFont(){document.querySelectorAll('.zh').forEach(function(z){if(!z.classList.contains('pending'))z.style.fontSize=zhSize+'px'});localStorage.setItem(FONT,zhSize)}
function persistLang(){try{localStorage.setItem(LANG_KEY,lang)}catch(e){}}
function persistMeter(){try{localStorage.setItem(METER_KEY,meterEnabled?'1':'0')}catch(e){}}

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
  if(!entries.length){logEl.innerHTML='<div id="empty">点下面的「开始」，把手机尽量靠近老师。<br>英文会自动翻译成中文。<br>请用 Chrome 打开（不要用微信、QQ 或 vivo 自带浏览器）。</div>';return}
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

function flushInterim(){
  if(pendingInterim){var t=pendingInterim;pendingInterim='';interimEl.textContent='';addFinal(t)}
}

function setInterim(text){
  pendingInterim=(text||'').trim();
  interimEl.textContent=pendingInterim?('正在听：'+pendingInterim):'';
}

// ---- mic level meter ----
function updateMeterBtn(){
  meterBtn.textContent=meterEnabled?'音量条：开':'音量条：关';
  meterBtn.className=meterEnabled?'on':'';
  meterBtn.setAttribute('aria-pressed',meterEnabled?'true':'false');
}
function showMeterBar(on){meterWrap.className=on?'show':''}

function stopMeter(){
  if(meterRaf){cancelAnimationFrame(meterRaf);meterRaf=0}
  if(meterStream){try{meterStream.getTracks().forEach(function(t){t.stop()})}catch(e){}meterStream=null}
  if(audioCtx){try{audioCtx.close()}catch(e){}audioCtx=null}
  analyser=null; timeBuf=null; meterOk=false;
  showMeterBar(false); showHint('');
  if(meterFill){meterFill.style.width='0';meterFill.className=''}
}

function disableMeterForConflict(){
  meterEnabled=false; persistMeter(); updateMeterBtn(); stopMeter();
  showMsg('音量条和语音识别冲突，已自动关闭音量条，识别会继续。你可以稍后再打开试试。',false);
}

function tickMeter(){
  meterRaf=requestAnimationFrame(tickMeter);
  if(!analyser)return;
  if(!timeBuf||timeBuf.length!==analyser.fftSize)timeBuf=new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(timeBuf);
  var sum=0,i,v;
  for(i=0;i<timeBuf.length;i++){v=(timeBuf[i]-128)/128;sum+=v*v}
  var rms=Math.sqrt(sum/timeBuf.length);
  var pct=Math.min(100,Math.pow(rms,0.55)*200);
  meterFill.style.width=pct+'%';
  var low=rms<0.028;
  meterFill.className=low?'low':'';
  if(!running)return;
  if(!low){lastLoud=Date.now();if(hintEl.textContent.indexOf('声音太小')===0)showHint('')}
  else if(lastLoud&&Date.now()-lastLoud>5000){showHint('声音太小，请把手机靠近老师')}
}

function startMeter(){
  if(!meterEnabled)return Promise.resolve();
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    meterEnabled=false; persistMeter(); updateMeterBtn();
    return Promise.resolve();
  }
  stopMeter();
  var constraints={audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:true}};
  return navigator.mediaDevices.getUserMedia(constraints).catch(function(){
    return navigator.mediaDevices.getUserMedia({audio:true});
  }).then(function(stream){
    if(!running||!meterEnabled){stream.getTracks().forEach(function(t){t.stop()});return}
    meterStream=stream;
    var AC=window.AudioContext||window.webkitAudioContext;
    if(!AC){showMeterBar(false);return}
    audioCtx=new AC();
    if(audioCtx.state==='suspended')audioCtx.resume().catch(function(){});
    var src=audioCtx.createMediaStreamSource(stream);
    analyser=audioCtx.createAnalyser();
    analyser.fftSize=1024;
    analyser.smoothingTimeConstant=0.65;
    src.connect(analyser);
    meterOk=true; lastLoud=Date.now();
    showMeterBar(true); tickMeter();
  }).catch(function(){
    stopMeter();
    // Permission or device error: leave SpeechRecognition to surface a clearer message
  });
}

// ---- speech recognition ----
function clearTimers(){clearTimeout(restartTimer);clearTimeout(watchdogTimer)}

function bumpWatchdog(){
  clearTimeout(watchdogTimer);
  if(!running||fatal)return;
  watchdogTimer=setTimeout(function(){
    if(!running||fatal)return;
    setStatus('重新连接中…',false);
    try{rec&&rec.abort()}catch(e){}
    scheduleRestart(300);
  },12000);
}

function scheduleRestart(wait){
  if(!running||fatal)return;
  clearTimeout(restartTimer);
  if(wait==null){
    if(Date.now()-lastStart<800){backoff=Math.min(2000,Math.max(backoff,200)*1.6);wait=backoff}
    else{backoff=150;wait=120}
  }
  restartTimer=setTimeout(startRec,wait);
}

function tryFallbackLang(){
  if(langTried[lang])return false;
  langTried[lang]=true;
  var next=lang==='en-GB'?'en-US':'en-GB';
  if(langTried[next])return false;
  lang=next; langEl.value=lang; persistLang();
  showMsg('这个浏览器暂时不支持刚才选的口音，已改成'+(lang==='en-GB'?'英式英语':'美式英语')+'。',false);
  return true;
}

function makeRec(){
  var r=new SR();
  r.lang=lang; r.continuous=true; r.interimResults=true; r.maxAlternatives=3;
  r.onstart=function(){backoff=150;setStatus('● 正在听…（英文 → 中文）',true);bumpWatchdog()};
  r.onresult=function(ev){
    backoff=150; lastLoud=Date.now(); bumpWatchdog();
    if(hintEl.textContent.indexOf('声音太小')===0)showHint('');
    var interim='';
    for(var i=ev.resultIndex;i<ev.results.length;i++){
      var res=ev.results[i];
      var text=(res[0]&&res[0].transcript)||'';
      if(res.isFinal){pendingInterim='';addFinal(text)} else interim+=text;
    }
    if(interim)setInterim(interim);
    else if(!pendingInterim)interimEl.textContent='';
  };
  r.onerror=function(ev){
    if(r!==rec)return;
    var er=ev.error;
    bumpWatchdog();
    if(er==='not-allowed'||er==='service-not-allowed'){
      fatal=true;
      showMsg(isIOS?'麦克风权限被拒绝。请到 iPhone「设置 → Safari 浏览器 → 麦克风」改成「允许」，并在「设置 → 隐私与安全性 → 语音识别」里允许 Safari，然后刷新页面。'
        :'麦克风权限被拒绝。请点地址栏左边的锁/设置图标 → 权限 → 麦克风 → 允许，然后刷新页面。（从桌面图标打开的话：长按图标 → 应用信息 → 权限 → 麦克风）',true);
      stop();
    }else if(er==='audio-capture'){
      if(meterOk||meterStream){
        disableMeterForConflict();
        scheduleRestart(200);
      }else{
        fatal=true;showMsg('找不到麦克风，或者麦克风被别的 App（比如录音、通话）占用了。',true);stop();
      }
    }else if(er==='network'){
      showMsg('语音识别需要联网，网络不稳定，正在重试…',true);
      scheduleRestart(600);
    }else if(er==='language-not-supported'){
      if(tryFallbackLang())scheduleRestart(200);
      else{fatal=true;showMsg('这个浏览器不支持英文语音识别。请用 Google Chrome 打开。',true);stop()}
    }else if(er==='no-speech'){
      scheduleRestart(120);
    }
    // 'aborted' -> restart via onend
  };
  r.onend=function(){
    if(r!==rec)return;
    flushInterim();
    if(running&&!fatal){
      setStatus('重新连接中…',false);
      scheduleRestart();
    }else if(!running){
      interimEl.textContent='';
    }
    bumpWatchdog();
  };
  return r;
}
function startRec(){
  if(!running||fatal)return;
  clearTimeout(restartTimer);
  bumpWatchdog();
  try{
    var old=rec; rec=null;
    flushInterim();
    if(old){try{old.abort()}catch(e){}}
    rec=makeRec();lastStart=Date.now();rec.start();
  }catch(e){
    scheduleRestart(Math.min(2000,Math.max(400,backoff)));
    backoff=Math.min(2000,backoff*1.5);
  }
}
function start(){
  if(blockedApp||!SR){unsupported();return}
  if(!window.isSecureContext){showMsg('需要用 https 网址打开才能用麦克风。',true);return}
  fatal=false; running=true; langTried={}; showMsg(''); showHint('');
  btn.textContent='停止'; btn.classList.add('running');
  setStatus('正在启动…',false);
  lastLoud=Date.now();
  keepAwake();
  var ready=meterEnabled?startMeter():Promise.resolve();
  ready.then(function(){if(running&&!fatal)startRec()}).catch(function(){if(running&&!fatal)startRec()});
}
function stop(){
  running=false; clearTimers();
  flushInterim();
  try{rec&&rec.stop()}catch(e){}
  rec=null;
  stopMeter();
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
  var chromeTip='请复制这个网址，用 Google Chrome 打开：\n'+location.href+'\n不要用微信、QQ 或 vivo 自带浏览器。打开后可以点浏览器菜单「添加到主屏幕」。';
  if(blockedApp==='wechat')showMsg('微信内置浏览器不能用语音识别。'+chromeTip,true);
  else if(blockedApp==='qq')showMsg('QQ 内置浏览器不能用语音识别。'+chromeTip,true);
  else if(blockedApp==='vivo')showMsg('vivo 自带浏览器不能用语音识别。'+chromeTip,true);
  else if(isIOS)showMsg('这个浏览器不支持语音识别。iPhone 请用 Safari 打开本页面（iOS 14.5 以上），不要用微信/QQ 里的内置浏览器。',true);
  else if(isAndroid)showMsg('这个浏览器不支持语音识别。安卓手机或平板请用 Google Chrome 打开本页面，不要用微信、QQ 或手机自带浏览器。复制网址：'+location.href,true);
  else showMsg('这个浏览器不支持语音识别。请用 Chrome（安卓/电脑）或 Safari（iPhone）打开。',true);
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

langEl.onchange=function(){
  var v=langEl.value;
  if(LANGS.indexOf(v)<0)v='en-GB';
  lang=v; langTried={}; persistLang();
  if(running&&!fatal){
    setStatus('切换口音中…',false);
    try{rec&&rec.abort()}catch(e){}
    scheduleRestart(150);
  }
};
meterBtn.onclick=function(){
  meterEnabled=!meterEnabled; persistMeter(); updateMeterBtn();
  if(!running){stopMeter();return}
  if(meterEnabled){
    startMeter().catch(function(){});
  }else{
    stopMeter();
  }
};

// ---- init ----
updateMeterBtn();
renderAll();
entries.forEach(function(e){if(!e.zh&&!e.failed)translate(e)});
if(blockedApp||!SR)unsupported();
else if(!window.isSecureContext)showMsg('需要用 https 网址打开才能用麦克风。',true);
if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('sw.js').catch(function(){})})}
})();

'use strict';
// Own, version-bound telemetry DLL. The game never captures audio; Electron owns it.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFile,spawn}=require('child_process');
const {asset,appDir}=require('./paths'),nearby=require('./nearby'),log=require('./log');
const {envelope,sample,controls}=require('./bedrock-telemetry');
const config=require('./config');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
let timer=null,busy=false,root='',manifest=null,session=null,nextProbe=0,stopped=true,watcher=null,retries={pid:0,count:0};
let status={status:'idle'},comfortStatus=null;
function publish(next){if(JSON.stringify(next)===JSON.stringify(status))return;status=next;nearby.setBridgeState(next);log.info('Bedrock voice: '+JSON.stringify(next));}
function run(file,args){return new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout:18000,maxBuffer:65536},(e,out,err)=>e?reject(new Error(String(err||e.message).trim())):resolve(String(out))));}
function verifiedFile(name,directory){
 const spec=manifest.files[name],bytes=fs.readFileSync(asset('bedrock',name));
 if(!spec||bytes.length!==spec.size||hash(bytes)!==spec.sha256)throw new Error('module_integrity');
 const file=path.join(directory,name);fs.mkdirSync(directory,{recursive:true});
 if(!fs.existsSync(file)||hash(fs.readFileSync(file))!==spec.sha256)fs.writeFileSync(file,bytes);
 return file;
}
function version(file){
 if(path.basename(file).toLowerCase()!=='minecraft.windows.exe')return '';
 const xml=fs.readFileSync(path.join(path.dirname(file),'AppxManifest.xml'),'utf8');
 const tag=/<Identity\b[^>]*\/>/.exec(xml)?.[0]||'';
 if(!/\bName="Microsoft\.MinecraftUWP"/.test(tag)||!/\bProcessorArchitecture="x64"/.test(tag))return '';
 return /\bVersion="([0-9.]+)"/.exec(tag)?.[1]||'';
}
// Our name in Bedrock (the game showed it before, else the Xbox gamertag):
// on a version it doesn't know, the module finds the fields by it.
function expectedName(){
 const cfg=config.get(),acc=(cfg.accounts||[]).find(a=>a.type==='xbox'&&a.gamertag)||(cfg.accounts||[]).find(a=>a.gamertag);
 const name=String(cfg.bedrockName||acc?.gamertag||'');
 return /^[A-Za-z0-9 _.-]{1,32}$/.test(name)?name:'';
}
function writeSession(s,enabled=true){
 const text='\ufeff[bridge]\r\ntoken='+s.token+'\r\nenabled='+(enabled?'1':'0')+'\r\nheartbeat='+Math.floor(Date.now()/1000)+'\r\npreferences='+path.join(appDir,'bedrock-bridge','comfort.ini')+'\r\nmicOff='+(config.get().voice?.micOff?'1':'0')+'\r\nmicSequence='+s.micSequence+'\r\nplayer='+expectedName()+'\r\noverlay='+require('./bedrock-cosmetics').overlayList()+'\r\n';
 const file=path.join(s.dir,'bridge.ini');fs.writeFileSync(file+'.tmp',text,'utf16le');fs.renameSync(file+'.tmp',file);s.lastWrite=Date.now();
}
// again in a moment if the module is reading it just now (Windows: busy), not the end of the session
function rewrite(s){try{writeSession(s);}catch(e){if(!['EBUSY','EPERM','EACCES'].includes(e.code))throw e;}}
function clear(){if(session){try{writeSession(session,false);}catch{}nearby.stop(session.pid);session=null;}}
// known versions, or any 1.26+ when the module adapts itself (it reads only there and reports whether it managed)
const supported=v=>manifest.packages.includes(v)||(manifest.adaptive===true&&/^1\.(2[6-9]|[3-9][0-9])\.\d+\.\d+$/.test(v));
async function attach(game){
 clear();const s=session={pid:game.pid,token:crypto.randomBytes(32).toString('hex'),dir:path.join(root,String(game.pid)),started:Date.now(),failed:false,micSequence:0,lastWrite:0};
 let packageVersion='';try{packageVersion=version(game.path);}catch{}
 if(!supported(packageVersion)){s.failed=true;publish({status:'unsupported',packageVersion});return;}
 publish({status:'loading',packageVersion});
 try{
  const dll=verifiedFile('mcl-bedrock.dll',s.dir);
  writeSession(s);
  await run(path.join(root,'mcl-bedrock-loader.exe'),[String(game.pid),dll]);
  if(stopped||session!==s)return;
  s.started=Date.now();publish({status:'waiting',packageVersion});
 }catch(e){
  // a game that has only just started may not let us in yet: again on the next look, a few times
  const again=/remote_system_module|open_process|load_timeout|module_not_loaded/.test(e.message)&&(retries.pid===game.pid?++retries.count:(retries={pid:game.pid,count:1}).count)<=5;
  if(again&&session===s)session=null;else s.failed=true;
  publish({status:'error',reason:e.message});
 }
}
async function tick(){
 if(busy||stopped)return;busy=true;
 try{
  // no game yet: the watcher puts the module in the moment one starts (see watch)
  if(watcher)return;
  if(Date.now()>=nextProbe){
   nextProbe=Date.now()+3000;
   const games=JSON.parse(await run(path.join(root,'mcl-bedrock-loader.exe'),['--probe']));
   if(stopped)return;
   const game=games.find(g=>g.pid===session?.pid)||games[0];
   if(!game){clear();publish({status:'idle'});watch(installed(),true);return;}
   if(!Number.isSafeInteger(game.pid)||game.pid<=0||typeof game.path!=='string')throw new Error('invalid_game_process');
   if(game.pid!==session?.pid)await attach(game);
  }
  if(stopped||!session||session.failed)return;
  const s=session;let frame,stat;
  if(Date.now()-s.lastWrite>=1000)rewrite(s);
  try{const file=path.join(s.dir,'telemetry.json');stat=fs.statSync(file);if(stat.size>65536)throw new Error('frame_size');frame=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  if(!envelope(frame,{pid:s.pid,token:s.token,mtimeMs:stat?.mtimeMs})){
   nearby.stop(s.pid);if(Date.now()-s.started>10000)publish({status:'error',reason:'telemetry_unavailable'});return;
  }
  if(frame.status==='unsupported'){nearby.stop(s.pid);s.failed=true;publish({status:'unsupported',reason:frame.reason});return;}
  if (frame.status === 'world' && !sample(frame)) {
   nearby.stop(s.pid);publish({status:'error',reason:'invalid_world_data'});return;
  }
  const c=frame.controls;if(c&&typeof c==='object')comfortStatus={zoom:String(c.zoom||''),vsync:String(c.vsync||''),fullbright:c.fullbrightAvailable===true};
  const input=controls(frame);
  if(input&&input.micSequence>s.micSequence){s.micSequence=input.micSequence;config.updateSettings({voice:{...config.get().voice,micOff:input.micOff}});rewrite(s);}
  nearby.acceptBedrock(frame,s.pid);
  publish({status:frame.status,reason:frame.reason||'',name:frame.status==='world'?frame.name:''});
 }catch(e){clear();publish({status:'error',reason:e.message});}finally{busy=false;}
}
function start(){
 // the fixer turned the module off (it was in the game's crashes): Bedrock as it is
 if(timer||process.platform!=='win32'||config.get().bedrockSafe)return;
 try{
  manifest=JSON.parse(fs.readFileSync(asset('bedrock','manifest.json'),'utf8'));
  if(manifest.protocol!==1||!Array.isArray(manifest.packages))throw new Error('module_manifest');
  root=path.join(appDir,'bedrock-bridge',hash(Buffer.from(JSON.stringify(manifest))).slice(0,20));
  verifiedFile('mcl-bedrock-loader.exe',root);stopped=false;nextProbe=0;
  timer=setInterval(tick,250);timer.unref();tick();
 }catch(e){publish({status:'error',reason:e.message});}
}
// The game is being started from here (game: {install, packageVersion}).
function soon(game={}){watch(game,false);}
const installed=()=>({packageVersion:require('./bedrock').cached()?.packageVersion||''});
// No game running: the loader waits for one and puts the module in the moment
// it's there — the cosmetics need it in before the game reads its vanilla
// files, however it's started (from here, the Xbox app, Start) and however long
// that takes (sign-in, an update: a minute and more). quiet: nobody's waiting
// for it (the status stays idle until a game comes).
function watch(game={},quiet){
 if(stopped||watcher||(session&&!session.failed&&alive(session.pid)))return;
 if(!game.packageVersion||!supported(game.packageVersion)){if(!quiet)nextProbe=0;return;}
 let s;
 try{
  clear();
  s={pid:0,token:crypto.randomBytes(32).toString('hex'),dir:path.join(root,'launch-'+crypto.randomBytes(4).toString('hex')),started:Date.now(),failed:false,micSequence:0,lastWrite:0};
  const dll=verifiedFile('mcl-bedrock.dll',s.dir);writeSession(s);
  const w=watcher=spawn(path.join(root,'mcl-bedrock-loader.exe'),['--watch',dll,quiet?'3600000':'300000',String(process.pid)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let out='';w.stdout.on('data',d=>{out+=d;});
  w.on('error',e=>{if(watcher===w)watcher=null;publish({status:'error',reason:e.message});});
  w.on('close',()=>{
   if(watcher!==w)return;watcher=null;nextProbe=0;
   let r=null;try{r=JSON.parse(out.trim().split('\n').pop());}catch{}
   if(stopped)return;
   if(!r||!r.pid){publish({status:'idle'});return;}
   if(r.error){publish({status:'error',reason:r.error});return;}
   s.pid=r.pid;s.started=Date.now();session=s;retries={pid:r.pid,count:0};
   publish({status:'waiting',packageVersion:game.packageVersion||''});
  });
  if(!quiet)publish({status:'loading',packageVersion:game.packageVersion||''});
 }catch(e){watcher=null;publish({status:'error',reason:e.message});}
 sweep(s&&s.dir);
}
// a game process that's still there
function alive(pid){if(!pid)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
// the folders of earlier launches (their module gone with their game)
function sweep(keep){
 try{for(const n of fs.readdirSync(root))if(n.startsWith('launch-')&&path.join(root,n)!==keep&&path.join(root,n)!==session?.dir)fs.rm(path.join(root,n),{recursive:true,force:true},()=>{});}catch{}
}
function stop(){stopped=true;clearInterval(timer);timer=null;if(watcher){try{watcher.kill();}catch{}watcher=null;}clear();}
module.exports={start,stop,soon,state:()=>status,comfort:()=>comfortStatus,version};

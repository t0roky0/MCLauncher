const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'),path=require('node:path');
function fixture({denied=false,pending=false}={}){
 const events=new Map(), listeners=new Map(), calls=[],errors=[],micWaiters=[];
 let opened=0,stopped=0;
 const state={config:{language:'ru',voice:{channel:'nearby',noise:'off',micOff:true}},party:{active:false}};
 const stream=()=>{const track={stop(){stopped++},applyConstraints:async()=>{}};return {getTracks:()=>[track],getAudioTracks:()=>[track]}};
 const param=()=>({value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}});
 const node=()=>({connect(n){return n},disconnect(){},gain:param(),frequency:param(),start(){},stop(){},stream:stream()});
 class AudioContext{
  constructor(){this.destination=node();this.currentTime=0}
  async resume(){} async close(){}
  createMediaStreamSource(){return node()}createAnalyser(){return node()}createGain(){return node()}createMediaStreamDestination(){return node()}createBiquadFilter(){return node()}createOscillator(){return node()}
 }
 function subscribe(map,key,fn){if(!map.has(key))map.set(key,[]);map.get(key).push(fn)}
 const emit=(key,v)=>{for(const fn of events.get(key)||[])fn(v)};
 const store={get:key=>state[key],set:patch=>{Object.assign(state,patch);for(const key of Object.keys(patch))for(const fn of listeners.get(key)||[])fn(state[key])},on:(key,fn)=>subscribe(listeners,key,fn)};
 const source=fs.readFileSync(path.join(__dirname,'../../src/renderer/js/voice.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
 const context={
  onEvent:(key,fn)=>subscribe(events,key,fn),store,
  api:async(...args)=>{calls.push(args);if(args[0]==='config:set')return {...state.config,...args[1]};if(args[0]==='nearby:state')return {active:false,members:[]};if(args[0]==='voice:ptt')return {native:true};return {}},
  navigator:{mediaDevices:{async getUserMedia(){opened++;if(denied)throw Error('Mic denied');if(pending)return new Promise(resolve=>micWaiters.push(()=>resolve(stream())));return stream()}}},
  window:{addEventListener(){}},AudioContext,performance,console,toast:e=>errors.push(e),relaySupported:()=>false,setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout
 };
 vm.runInNewContext(source+'\ninitVoice();globalThis.voice={voiceState,nearbyVoiceState,settingsState,join,leave,setMicOff,setMode,setNoise};',context);
 return {emit,store,calls,errors,voice:context.voice,opened:()=>opened,stopped:()=>stopped,resolveMic:()=>micWaiters.shift()?.()};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const sample={active:true,connected:true,members:[{id:'self',self:true}]};
test('nearby auto-starts in a world without joining party voice',async()=>{
 const f=fixture();await flush();assert.equal(f.opened(),0);
 f.emit('nearby:changed',sample);await flush();
 assert.equal(f.opened(),1);assert.equal(f.voice.nearbyVoiceState().on,true);assert.equal(f.voice.voiceState().on,false);assert.equal(f.voice.nearbyVoiceState().micOff,true);
 assert.ok(f.calls.some(c=>c[0]==='nearby:voice'&&c[1]?.on&&!c[1].mic));
 f.emit('nearby:changed',sample);await flush();assert.equal(f.opened(),1);
 f.emit('nearby:changed',{active:false,members:[]});await flush();assert.equal(f.voice.nearbyVoiceState().on,false);assert.equal(f.stopped(),1);
});
test('party entry stays manual and leaving preserves nearby voice and PTT',async()=>{
 const f=fixture();await flush();f.store.set({party:sample});await flush();assert.equal(f.opened(),0);
 await f.voice.join();assert.equal(f.voice.voiceState().on,true);
 f.emit('nearby:changed',sample);await flush();assert.equal(f.opened(),2);
 await f.voice.setMode('ptt');await f.voice.setMicOff(false);
 assert.equal(f.voice.voiceState().micOff,false);assert.equal(f.voice.nearbyVoiceState().micOff,false);
 for(const key of ['party:voice','nearby:voice'])assert.ok(f.calls.some(c=>c[0]===key&&c[1]?.mic));
 f.voice.leave();await flush();assert.equal(f.voice.voiceState().on,false);assert.equal(f.voice.nearbyVoiceState().on,true);assert.equal(f.stopped(),1);
 assert.equal(f.calls.filter(c=>c[0]==='win:keepAlive').at(-1)[1],true);
 assert.equal(JSON.stringify(f.calls.filter(c=>c[0]==='voice:ptt').at(-1)[1]),'[86]');
 f.emit('nearby:changed',{active:false,members:[]});await flush();assert.equal(f.stopped(),2);assert.equal(f.calls.filter(c=>c[0]==='win:keepAlive').at(-1)[1],false);
});
test('world exit and next entry preserve manual party call',async()=>{
 const f=fixture();await flush();f.store.set({party:sample});await f.voice.join();f.emit('nearby:changed',sample);await flush();
 f.emit('nearby:changed',{active:false,members:[]});await flush();assert.equal(f.voice.voiceState().on,true);assert.equal(f.voice.nearbyVoiceState().on,false);
 f.emit('nearby:changed',sample);await flush();assert.equal(f.opened(),3);assert.equal(f.voice.voiceState().on,true);
 f.store.set({party:{active:false,members:[]}});await flush();assert.equal(f.voice.voiceState().on,false);assert.equal(f.voice.nearbyVoiceState().on,true);
});
test('shared noise settings restart only active calls',async()=>{
 const f=fixture();await flush();f.store.set({party:sample});f.emit('nearby:changed',sample);await flush();
 await f.voice.setNoise('standard');assert.equal(f.voice.voiceState().on,false);assert.equal(f.voice.nearbyVoiceState().on,true);assert.equal(f.opened(),2);
});
test('mic denial reported once per world and retried after re-entry',async()=>{
 const f=fixture({denied:true});await flush();for(let i=0;i<3;i++){f.emit('nearby:changed',sample);await flush()}
 assert.equal(f.opened(),1);assert.equal(f.errors.length,1);f.emit('nearby:changed',{active:false,members:[]});await flush();f.emit('nearby:changed',sample);await flush();assert.equal(f.opened(),2);assert.equal(f.errors.length,2);
});
test('leaving party during mic permission does not cancel nearby join',async()=>{
 const f=fixture({pending:true});await flush();f.store.set({party:sample});const joining=f.voice.join();f.emit('nearby:changed',sample);
 f.voice.leave();f.resolveMic();await joining;f.resolveMic();await flush();assert.equal(f.voice.voiceState().on,false);assert.equal(f.voice.nearbyVoiceState().on,true);assert.equal(f.stopped(),1);
});


const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const A='a'.repeat(32), B='b'.repeat(32), C='c'.repeat(32);
const line = data => '[MC Launcher] nearby\t'+Buffer.from(data).toString('base64');
function fixture() {
  const clients=[], events=[]; let now=10000, interval;
  const config={gameSkins:true,voice:{channel:'nearby',range:32},accounts:[]};
  class MqttClient {
    constructor(url, options) {this.options=options;this.sent=[];this.topics=[];clients.push(this);}
    async connect() {} subscribe(t){this.topics.push(t);} unsubscribe(t){this.topics=this.topics.filter(x=>x!==t);}
    publish(t,b){this.sent.push([t,JSON.parse(b)]);} close(){this.closed=true;}
  }
  const deps={'./mqtt':{MqttClient},'./config':{get:()=>config},'./skins':{localSkinFor:()=>null}};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../src/main/nearby.js'),'utf8'),{module,exports:module.exports,require:id=>deps[id]||require(id.startsWith('.')?path.join(__dirname,'../../src/main',id):id),Buffer,Date:{now:()=>now},setInterval:fn=>{interval=fn;return {unref(){}}},clearInterval(){}});
  const api=module.exports;api.onEvent((...e)=>events.push(e));
  return {api,clients,events,config,advance:ms=>now+=ms,interval:()=>interval?.(),packet:(from,type,extra={})=>Buffer.from(JSON.stringify({from,type,at:now,nonce:require('crypto').randomBytes(8).toString('hex'),...extra}))};
}
test('samples are bounded, accept stdout prefixes, reject chat and non-finite distances',()=>{
  const f=fixture(), raw=line(`${A}\tSelf\n${B}\tFriend\t8\t0.5\n${C}\tFar\tInfinity\t0`);
  assert.equal(f.api.parse(raw).players.length,1);
  assert.equal(f.api.parse('[12:30:00] [Render thread/INFO]: [STDOUT]: '+raw).players[0].distance,8);
  assert.equal(f.api.parse('[CHAT] '+raw),undefined);
  assert.equal(f.api.parse(line('')),null);
});
test('presence/signalling only comes from locally visible players; stale world drops to silence',async()=>{
  const f=fixture();f.api.accept(line(`${A}\tSelf\n${B}\tFriend\t8\t0`),123);await Promise.resolve();
  const c=f.clients[0], ownTopic=c.topics[0], peerTopic=c.topics[1];
  c.options.onMessage(peerTopic,f.packet(B,'hi',{voice:{on:true,mic:true}}));
  assert.equal(f.api.state().members.length,2);
  f.api.setVoice({on:true,mic:true});
  c.options.onMessage(ownTopic,f.packet(C,'signal',{kind:'offer',sdp:'other world'}));
  assert.equal(f.events.filter(e=>e[0]==='signal').length,0);
  c.options.onMessage(ownTopic,f.packet(B,'signal',{kind:'offer',sdp:'valid'}));
  assert.equal(f.events.filter(e=>e[0]==='signal').length,1);
  f.api.accept(line(`${A}\tSelf\n${B}\tFriend\t40\t0`),123);
  f.advance(300);c.options.onMessage(ownTopic,f.packet(B,'signal',{kind:'offer',sdp:'too far'}));
  assert.equal(f.events.filter(e=>e[0]==='signal').length,1);
  f.advance(2000);assert.equal(f.api.state().active,false);f.interval();assert.ok(c.closed);
});
test('leaving loaded players unsubscribes without reconnect and inactive process cannot stop current world',async()=>{
  const f=fixture();f.api.accept(line(`${A}\tSelf\n${B}\tFriend\t8\t0`),123);await Promise.resolve();
  assert.equal(f.clients[0].topics.length,2);
  f.api.accept(line(`${A}\tSelf`),123);assert.equal(f.clients[0].topics.length,1);
  f.api.stop(456);assert.equal(f.api.state().active,true);
  f.api.stop(123);assert.equal(f.api.state().active,false);
});
test('oversized texture headers and duplicate signalling are not accepted',async()=>{
  const f=fixture();f.api.accept(line(`${A}\tSelf\n${B}\tFriend\t8\t0`),123);await Promise.resolve();
  const c=f.clients[0], b=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(b);b.write('IHDR',12);b.writeUInt32BE(100000,16);b.writeUInt32BE(100000,20);
  c.options.onMessage(c.topics[1],f.packet(B,'hi',{skin:'data:image/png;base64,'+b.toString('base64'),voice:{on:true}}));
  assert.equal(f.api.state().members[1].skin,'');
  f.api.setVoice({on:true});const packet=f.packet(B,'signal',{kind:'offer',sdp:'one'});
  c.options.onMessage(c.topics[0],packet);c.options.onMessage(c.topics[0],packet);
  assert.equal(f.events.filter(e=>e[0]==='signal').length,1);
});

test('Bedrock peers require mutual world membership, fresh positions and same dimension',async()=>{
  const {playerId}=require('../../src/main/bedrock-telemetry');
  const f=fixture(),self=playerId('Self'),other=playerId('Friend');
  const sample={status:'world',name:'Self',position:[0,64,0],dimension:'Overworld',players:['Self','Friend']};
  f.api.acceptBedrock(sample,777);await Promise.resolve();
  const c=f.clients[0],peerTopic=c.topics[1],ownTopic=c.topics[0];
  const location={position:[3,64,4],dimension:'Overworld',players:[self,other]};
  c.options.onMessage(peerTopic,f.packet(other,'hi',{voice:{on:true},bedrock:location}));
  assert.equal(f.api.state().members[1].distance,5);
  f.api.setVoice({on:true});
  c.options.onMessage(ownTopic,f.packet(other,'signal',{kind:'offer',sdp:'world'}));
  assert.equal(f.events.filter(e=>e[0]==='signal').length,1);
  c.options.onMessage(peerTopic,f.packet(other,'move',{bedrock:{...location,dimension:'Nether'}}));
  assert.equal(f.api.state().members.length,1);
  c.options.onMessage(peerTopic,f.packet(other,'move',{bedrock:{...location,players:[other]}}));
  assert.equal(f.api.state().members.length,1);
  c.options.onMessage(peerTopic,f.packet(other,'move',{bedrock:location}));
  f.advance(1600);f.api.acceptBedrock(sample,777);
  assert.equal(f.api.state().active,true);assert.equal(f.api.state().members.length,1);
  c.options.onMessage(peerTopic,f.packet(other,'move',{bedrock:{...location,position:[50,64,0]}}));
  c.options.onMessage(ownTopic,f.packet(other,'signal',{kind:'offer',sdp:'outside range'}));
  assert.equal(f.events.filter(e=>e[0]==='signal').length,1);
  f.api.acceptBedrock({status:'menu'},777);assert.equal(f.api.state().active,false);assert.ok(c.closed);
});

test('Bedrock cannot take over a live Java world, and malformed samples stop its own voice',()=>{
  const f=fixture();f.api.accept(line(`${A}\tSelf`),123);
  const sample={status:'world',name:'Xbox Player',position:[0,64,0],dimension:'Overworld',players:['Xbox Player']};
  f.api.acceptBedrock(sample,777);assert.equal(f.api.state().members[0].id,A);
  f.api.stop(123);f.api.acceptBedrock(sample,777);assert.equal(f.api.state().members[0].name,'Xbox Player');
  f.api.acceptBedrock({...sample,position:[NaN,0,0]},777);assert.equal(f.api.state().active,false);
});

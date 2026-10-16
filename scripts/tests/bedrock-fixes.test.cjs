const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {serverList} = require('../../src/main/bedrock-servers');

test('seven partner servers are available without a profile or external server file', () => {
  const list = serverList();
  assert.equal(list.length, 7);
  assert.ok(list.every(s => s.featured && s.port === 19132));
  for (const name of ['MegaSMP','Enchanted','Mineville Zeqa']) assert.ok(list.some(s => s.name === name));
});

test('saved servers are preserved, invalid rows skipped, duplicate hosts normalized', () => {
  const list = serverList('0:Hive:Geo.HiveBedrock.Network:19132:0\n1:My:Server:example.org:19133:0\n2:Bad:example.org:70000:0\nbroken');
  assert.equal(list.length, 8);
  assert.equal(list.at(-1).name, 'My:Server');
  assert.equal(list.at(-1).ip, 'example.org:19133');
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-skins-test-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const accounts = [{id:'msa:a',type:'msa',uuid:'12345678-1234-1234-1234-123456789abc'}, {id:'xbox:b',type:'xbox',xuid:'2535411111111111'}, {id:'offline:c',type:'offline'}];
  const cfg = {accounts,activeAccount:accounts[0].id,bedrockSkin:'bedrock'};
  const skins = [{id:'bedrock',file:'bedrock.png',model:'slim',name:'Bedrock skin'}, {id:'java',file:'java.png',model:'classic',name:'Java skin'}];
  fs.writeFileSync(path.join(dir,'skins.json'),JSON.stringify(skins));
  for(const skin of skins) fs.writeFileSync(path.join(dir,skin.file),Buffer.from('64x64 test PNG'));
  fs.writeFileSync(path.join(dir,'active_skin.png'),Buffer.from('64x64 previous Java skin'));
  fs.writeFileSync(path.join(dir,'active_skin.json'),JSON.stringify({id:'java',model:'classic',accountId:'msa:a'}));
  const requests=[];
  let profileFailure=false, sessionSkin='https://textures.minecraft.net/old', worn=null;
  const deps={
    electron:{nativeImage:{createFromBitmap:(b,o)=>({toPNG:()=>Buffer.concat([Buffer.from('PNG'+o.width+'x'+o.height+':'),b])}),createFromBuffer:(b)=>{const m=b.length>=24 && b.readUInt32BE(0)===0x89504e47 ? ['',b.readUInt32BE(16),b.readUInt32BE(20)] : /^(?:PNG)?([0-9]+)x([0-9]+)/.exec(b.toString());return {isEmpty:()=>!m,getSize:()=>({width:m?+m[1]:0,height:m?+m[2]:0}),toPNG:()=>b,toBitmap:()=>Buffer.alloc(m?m[1]*m[2]*4:0)};}}}, './paths':{skinsDir:dir,capesDir:path.join(dir,'capes'),asset:(...p)=>path.join(__dirname,'../../assets',...p)}, './log':{info(){},warn(){}},
    './config':{get:()=>cfg,dashUuid:v=>v,mutate:fn=>fn(cfg)},
    './bedrock':{currentSkin:()=>worn},
    './auth':{activeAccount:()=>accounts.find(a=>a.id===cfg.activeAccount),minecraftToken:async id=>'token:'+id},
    './net':{request:async()=>{},getJson:async(url,opts)=>{
      requests.push({url,opts});
      if(url.includes('sessionserver'))return {properties:[{name:'textures',value:Buffer.from(JSON.stringify({textures:{SKIN:{url:sessionSkin}}})).toString('base64')}]};
      if(profileFailure)throw Error('offline');
      return {id:'uuid',name:'Player',skins:[{state:'ACTIVE',url:'https://textures.minecraft.net/new',variant:'SLIM'}],capes:[]};
    }}
  };
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../src/main/skins.js'),'utf8'),{module,exports:module.exports,require:id=>deps[id]||require(id),Buffer,FormData,Blob,console});
  return {api:module.exports,cfg,dir,deps,requests,failProfile(){profileFailure=true},newSession(){sessionSkin='https://textures.minecraft.net/changed'},wear(w){worn=w}};
}

test('Bedrock lobby uses its selected library skin, including slim arms', async t=>{
  const f=fixture(t); const a=await f.api.appearance({edition:'bedrock'});
  assert.match(a.skinUrl,/bedrock\.png/);assert.equal(a.model,'slim');assert.equal(f.requests.length,0);
});
test('Xbox account never inherits the previous Microsoft/Java local skin', async t=>{
  const f=fixture(t);f.cfg.activeAccount='xbox:b';f.cfg.bedrockSkin='';
  assert.equal(await f.api.appearance(),null);
  f.cfg.bedrockSkin='deleted';assert.equal(await f.api.appearance(),null);
});
test('Microsoft avatar uses fresh authenticated profile rather than cached session texture', async t=>{
  const f=fixture(t);const a=await f.api.appearance();
  assert.equal(a.skinUrl,'https://textures.minecraft.net/new');assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].opts.headers.Authorization,'Bearer token:msa:a');
});
test('public texture fallback works if the authenticated profile is unavailable',async t=>{
  const f=fixture(t);f.failProfile();assert.equal((await f.api.appearance()).skinUrl,'https://textures.minecraft.net/old');
});

test('official upload is explicit, rejects HD, and clears the local skin only after success', async t => {
  const f = fixture(t), png = path.join(f.dir, 'java.png');
  f.cfg.accounts[0].skin = 'java';
  const calls = [];
  f.deps['./net'].request = async (url, opts) => calls.push({url,opts});
  fs.writeFileSync(png, '128x128');
  await assert.rejects(f.api.apply('java','mojang'), /64×64/);
  assert.equal(calls.length, 0);
  assert.equal(f.cfg.accounts[0].skin,'java');
  fs.writeFileSync(png, '64x64');
  assert.equal((await f.api.apply('java','mojang')).uploaded,true);
  assert.equal(calls.length,1);
  assert.equal(calls[0].opts.method,'POST');
  assert.equal(calls[0].opts.headers.Authorization,'Bearer token:msa:a');
  assert.equal(f.cfg.accounts[0].skin,'');
  assert.equal(f.api.localSkinFor('msa:a'),null);
});

test('failed official upload preserves the launcher appearance', async t => {
  const f=fixture(t); f.cfg.accounts[0].skin='java';
  fs.writeFileSync(path.join(f.dir,'java.png'),'64x64');
  f.deps['./net'].request=async()=>{throw Error('unavailable');};
  f.deps['./net'].describe=e=>e.message;
  await assert.rejects(f.api.apply('java','mojang'),/unavailable/);
  assert.equal(f.cfg.accounts[0].skin,'java');
});

test('official cape stays visible with a launcher skin; selecting it removes only local cape override', async t => {
  const f=fixture(t); f.cfg.accounts[0].skin='java';
  f.deps['./net'].getJson=async()=>({id:'uuid',skins:[],capes:[{id:'official',url:'https://textures.minecraft.net/cape',state:'ACTIVE'}]});
  assert.equal((await f.api.appearance()).capeUrl,'https://textures.minecraft.net/cape');
  f.cfg.accounts[0].cape='custom';
  await f.api.setCape('official');
  assert.equal(f.cfg.accounts[0].cape,'');
  assert.equal(f.cfg.accounts[0].skin,'java');
});

test('resizing a skin uses nearest pixels and preserves transparent alpha', async t => {
  const f=fixture(t), source=Buffer.alloc(64*64*4);
  source.set([17,28,39,0],0); source.set([91,92,93,255],4);
  const decode=f.deps.electron.nativeImage.createFromBuffer;
  f.deps.electron.nativeImage.createFromBuffer=b=>b.toString()==='skin'?({isEmpty:()=>false,getSize:()=>({width:64,height:64}),toBitmap:()=>source,toPNG:()=>Buffer.from('skin')}):decode(b);
  let bitmap;
  f.deps.electron.nativeImage.createFromBitmap=(b,o)=>{bitmap=b;assert.equal(o.width,128);return {toPNG:()=>Buffer.from('128x128 resized PNG')};};
  const added=await f.api.add({name:'HD',dataUrl:'data:image/png;base64,c2tpbg==',size:128});
  assert.equal(added.width,128);
  assert.deepEqual([...bitmap.subarray(0,12)],[17,28,39,0,17,28,39,0,91,92,93,255]);
  await assert.rejects(f.api.update(added.id,{size:72}),/Размер скина/);
});

test('the supplied normal and 32x examples stay byte-for-byte 64x64 and 128x128', async t => {
  const f = fixture(t);
  const decode = b => ({ isEmpty: () => b.length < 24, getSize: () => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) }), toPNG: () => b,
    toBitmap: () => { throw Error('Valid examples must not be resampled'); } });
  f.deps.electron.nativeImage.createFromBuffer = decode;
  f.deps.electron.nativeImage.createFromPath = p => decode(fs.readFileSync(p));
  for (const size of [64, 128]) {
    const png = fs.readFileSync(path.join(__dirname, 'fixtures', `skin-${size}.png`));
    const added = await f.api.add({ name: `Example ${size}`, dataUrl: 'data:image/png;base64,' + png.toString('base64') });
    assert.equal(added.width, size);
    assert.deepEqual(fs.readFileSync(path.join(f.dir, added.file)), png);
    await f.api.apply(added.id);
    assert.deepEqual(f.api.localSkinFor(f.cfg.activeAccount).png, png);
    const exported = path.join(f.dir, `export-${size}.png`);
    await f.api.exportSkin(added.id, exported);
    assert.deepEqual(fs.readFileSync(exported), png);
    for (const tooLarge of [256, 512]) await assert.rejects(f.api.update(added.id, { size: tooLarge }), /128×128/);
  }
});

test('oversized and off-by-one imports are rejected even with a resize override', async t => {
  const f=fixture(t);
  for(const dimensions of ['256x256','512x512','129x128','128x129','65x64','64x65','32x32']) {
    const dataUrl=png(dimensions);
    await assert.rejects(f.api.add({dataUrl}), /128×128/);
    await assert.rejects(f.api.add({dataUrl,size:64}), /128×128/);
    const before=fs.readFileSync(path.join(f.dir,'java.png'));
    await assert.rejects(f.api.update('java',{dataUrl,size:64}), /128×128/);
    assert.deepEqual(fs.readFileSync(path.join(f.dir,'java.png')),before);
  }
  const alex=path.join(__dirname,'fixtures','skin-256.png');
  await assert.rejects(f.api.add({path:alex,size:64}), /256×256/);
});

test('invalid saved skins cannot be worn, exported or shared and are not silently rewritten', async t=>{
  const f=fixture(t); f.cfg.activeAccount='offline:c';
  const file=path.join(f.dir,'java.png'); fs.writeFileSync(file,'256x256');
  await assert.rejects(f.api.apply('java'),/256×256/);
  assert.equal(f.cfg.accounts[2].skin,undefined);
  f.cfg.accounts[2].skin='java';
  assert.equal(f.api.localSkinFor('offline:c'),null);
  assert.equal(await f.api.appearance(),null);
  const entry=f.api.list().find(s=>s.id==='java');
  assert.equal(entry.width,256); assert.equal(entry.valid,false);
  await assert.rejects(f.api.exportSkin('java',path.join(f.dir,'export.png')),/256×256/);
  assert.equal(fs.readFileSync(file,'utf8'),'256x256');
});

test('cape limits check pixels on import and again when wearing a saved cape', async t=>{
  const f=fixture(t); f.cfg.activeAccount='offline:c';
  const good=await f.api.addCape({dataUrl:png('128x64')});
  f.api.wearCape(good.id);
  for(const dim of ['256x128','129x64','128x65','65x32']) await assert.rejects(f.api.addCape({dataUrl:png(dim)}),/64×32/);
  const meta=JSON.parse(fs.readFileSync(path.join(f.dir,'capes','capes.json')));
  fs.writeFileSync(path.join(f.dir,'capes',meta[0].file),'256x128');
  f.api.wearCape('');
  assert.throws(()=>f.api.wearCape(good.id),/256×128/);
  assert.equal(f.cfg.accounts[2].cape,'');
  f.cfg.accounts[2].cape=good.id;
  assert.equal(f.api.localSkinFor('offline:c'),null);
  assert.equal(await f.api.appearance(),null);
});
test('launcher appearance preserves Mojang profile and works for a licensed account',async t=>{
  const f=fixture(t),uuid=f.cfg.accounts[0].uuid;
  await f.api.texturesByUuid(uuid);f.newSession();await f.api.apply('java');
  assert.equal((await f.api.texturesByUuid(uuid)).skinUrl,'https://textures.minecraft.net/old');
  assert.match((await f.api.appearance()).skinUrl,/java\.png/);
  assert.ok(f.api.localSkinFor('msa:a').png);
});
test('a guest does not inherit another account skin but can use its own',async t=>{
  const f=fixture(t);f.cfg.activeAccount='offline:c';assert.equal(await f.api.appearance(),null);
  // the pick is remembered for this account: its library skin itself
  await f.api.apply('java');assert.equal(f.cfg.accounts[2].skin,'java');
  assert.match((await f.api.appearance()).skinUrl,/java\.png/);
});
test('Xbox account shows the skin Bedrock itself wears when none was picked in the launcher', async t=>{
  const f=fixture(t);f.cfg.activeAccount='xbox:b';f.cfg.bedrockSkin='';
  f.wear({kind:'library',id:'bedrock'});
  assert.match((await f.api.appearance()).skinUrl,/bedrock.png/);
  const custom=path.join(f.dir,'custom.png');fs.writeFileSync(custom,Buffer.from('64x64 custom PNG'));
  f.wear({kind:'custom',file:custom});
  assert.equal((await f.api.appearance()).skinUrl,'data:image/png;base64,'+Buffer.from('64x64 custom PNG').toString('base64'));
  f.wear({kind:'persona'});assert.equal(await f.api.appearance(),null);
});

// capes without a Java licence: one's own PNGs (and, for its Xbox account
// only, an official Bedrock cape taken by 2.1.13 — an entry with an owner)
function officialCape(f,xuid,id){
  fs.mkdirSync(path.join(f.dir,'capes'),{recursive:true});
  fs.writeFileSync(path.join(f.dir,'capes',id+'.png'),'64x32 PNG '+id);
  const file=path.join(f.dir,'capes','capes.json');
  const list=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
  list.push({id,name:'Медный',file:id+'.png',kind:'bedrock',owner:xuid,width:64,height:32});
  fs.writeFileSync(file,JSON.stringify(list));
}
const png=(text)=>'data:image/png;base64,'+Buffer.from(text).toString('base64');

test('a cape of one\u2019s own: added like a skin and worn by a guest in Java', async t=>{
  const f=fixture(t);f.cfg.activeAccount='offline:c';
  assert.equal(f.api.capes().length,0,'no ready-made capes');
  const added=await f.api.addCape({name:'Мой',dataUrl:png('64x32 cape')});
  assert.equal(added.kind,'custom');assert.equal(added.name,'Мой');
  assert.equal((await f.api.addCape({dataUrl:png('64x32 cape')})).existed,true,'the same file twice is one cape');
  await assert.rejects(f.api.addCape({dataUrl:png('64x64 skin')}),/64\u00d732/);
  f.api.wearCape(added.id);assert.equal(f.cfg.accounts[2].cape,added.id);
  assert.ok((await f.api.appearance()).capeUrl.startsWith('mcl://user/capes/'));
  // the game: the cape alone, on the default skin
  const own=f.api.localSkinFor('offline:c');assert.equal(own.png,null);assert.ok(own.cape.length>0);
  // a Java licence wears Mojang capes, not these
  f.cfg.activeAccount='msa:a';assert.equal(f.api.capes().length,1);f.api.wearCape(added.id);
  assert.ok(f.api.localSkinFor('msa:a').cape.length > 0);
});
test('an official cape stays its Xbox account\u2019s', async t=>{
  const f=fixture(t);f.cfg.activeAccount='xbox:b';
  officialCape(f,'2535411111111111','copper1');officialCape(f,'2535499999999999','theirs1');
  assert.equal(JSON.stringify(f.api.capes().map(c=>c.id)),'["copper1"]','only its own');
  f.api.wearCape('copper1');assert.equal(f.cfg.accounts[1].cape,'copper1');
  assert.throws(()=>f.api.wearCape('theirs1'));
  f.cfg.activeAccount='offline:c';assert.equal(f.api.capes().length,0);
  // deleting one takes it off whoever wore it
  f.cfg.activeAccount='xbox:b';await f.api.removeCape('copper1');assert.equal(f.cfg.accounts[1].cape,'');
});

const {test}=require('node:test'),assert=require('node:assert/strict');
const {envelope,sample,presence,playerId}=require('../../src/main/bedrock-telemetry');
test('telemetry is tied to the launched process, nonce, protocol and freshness',()=>{
 const context={pid:42,token:'a'.repeat(64),mtimeMs:10000},frame={protocol:1,pid:42,token:context.token,status:'world'};
 assert.equal(envelope(frame,context,10000),true);
 for(const bad of [{pid:43},{token:'b'.repeat(64)},{protocol:2},{status:'ready'}])assert.equal(envelope({...frame,...bad},context,10000),false);
 assert.equal(envelope(frame,context,12000),false);assert.equal(envelope(frame,{...context,mtimeMs:undefined},10000),false);
});
test('Bedrock schema bounds names, coordinates and membership and separates IDs from Java',()=>{
 const s={status:'world',name:'Xbox Friend',dimension:'Overworld',position:[0,64,0],players:['Xbox Friend','Alex']};
 assert.ok(sample(s));assert.equal(playerId('Alex'),playerId('alex'));assert.match(playerId('Alex'),/^[a-f0-9]{32}$/);
 for(const bad of [{name:'A\nB'},{position:[Infinity,0,0]},{position:[0,0]},{players:[]},{players:Array(1001).fill('Alex')},{dimension:''}])assert.equal(sample({...s,...bad}),null);
 assert.equal(presence({position:[0,0,0],dimension:'Nether',players:['invalid']}),null);
});
test('Bedrock monsters beaten: a whole, non-negative counter or nothing',()=>{
 const s={status:'world',name:'Xbox Friend',dimension:'Overworld',position:[0,64,0],players:['Xbox Friend']};
 assert.equal(sample(s).kills,null);assert.equal(sample({...s,kills:12}).kills,12);
 for(const bad of [-1,1.5,'3',Infinity,2e9])assert.equal(sample({...s,kills:bad}).kills,null);
});

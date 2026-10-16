'use strict';
const crypto=require('crypto');
const nameOK=s=>typeof s==='string'&&s.length>=1&&s.length<=32&&!/[\x00-\x1f\x7f§]/.test(s)&&s.trim()===s;
const playerId=name=>crypto.createHash('sha256').update('mcl:bedrock:'+name.toLowerCase()).digest('hex').slice(0,32);
const positionOK=p=>Array.isArray(p)&&p.length===3&&p.every((n,i)=>Number.isFinite(n)&&Math.abs(n)<=(i===1?1000000:30000000));
// [pitch, yaw] in degrees when the module reads the camera: voice gets a direction.
const rotationOK=r=>Array.isArray(r)&&r.length===2&&r.every(Number.isFinite)&&Math.abs(r[0])<=90&&Math.abs(r[1])<=7200;
// monsters this player has beaten since the game started (a counter, for the event quests), when the module reads it
const killsOK=n=>Number.isInteger(n)&&n>=0&&n<=1e9;
function sample(frame){
 if(!frame||frame.status!=='world'||!nameOK(frame.name)||!positionOK(frame.position)||typeof frame.dimension!=='string'||!frame.dimension||frame.dimension.length>64||!Array.isArray(frame.players)||frame.players.length>1000||!frame.players.every(nameOK))return null;
 const id=playerId(frame.name), names=[...new Set(frame.players)];
 if(!names.some(n=>playerId(n)===id))return null;
 return {edition:'bedrock',id,name:frame.name,dimension:frame.dimension,position:frame.position.slice(),rotation:rotationOK(frame.rotation)?frame.rotation.slice():null,kills:killsOK(frame.kills)?frame.kills:null,players:names.map(name=>({id:playerId(name),name,pan:0})).filter(p=>p.id!==id).slice(0,1000)};
}
function spatial(snapshot,peer,now){
 const p=peer?.bedrock;
 if(!p||now-peer.movedAt>1500||p.dimension!==snapshot.dimension||!p.players.includes(snapshot.id)||!positionOK(p.position))return null;
 const [dx,dy,dz]=p.position.map((n,i)=>n-snapshot.position[i]),distance=Math.hypot(dx,dy,dz);
 if(!snapshot.rotation)return {distance,pan:0};
 // the same frame as Java's: yaw 0 faces south (+Z), 90 west
 const yaw=snapshot.rotation[1]*Math.PI/180,right=-dx*Math.cos(yaw)-dz*Math.sin(yaw),ahead=-dx*Math.sin(yaw)+dz*Math.cos(yaw),flat=Math.hypot(dx,dz);
 return {distance,pan:flat<0.01?0:Math.max(-1,Math.min(1,right/flat)),rel:[right,dy,ahead]};
}
function presence(value){
 if(!value||!positionOK(value.position)||typeof value.dimension!=='string'||value.dimension.length>64||!Array.isArray(value.players)||value.players.length>1001||!value.players.every(id=>/^[a-f0-9]{32}$/.test(id)))return null;
 return {position:value.position.slice(),dimension:value.dimension,players:value.players.slice()};
}
function envelope(frame,{pid,token,mtimeMs},now=Date.now()){
 return !!frame&&frame.protocol===1&&frame.pid===pid&&frame.token===token&&now-mtimeMs>=-1000&&now-mtimeMs<1500&&['world','menu','unsupported'].includes(frame.status);
}
function controls(frame){const c=frame?.controls;return c&&Number.isSafeInteger(c.micSequence)&&c.micSequence>=0&&c.micSequence<=0xffffffff&&typeof c.micOff==='boolean'?{micSequence:c.micSequence,micOff:c.micOff}:null;}
module.exports={sample,spatial,presence,envelope,playerId,controls};

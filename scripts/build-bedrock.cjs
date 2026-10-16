'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..'), build=path.join(root,'bedrock-native','build');
// Windows environments can contain both PATH and Path. MSBuild rejects duplicates.
const env={};for(const [key,value] of Object.entries(process.env)){const prior=Object.keys(env).find(k=>k.toLowerCase()===key.toLowerCase());env[prior||key]=value;}
function run(args){const r=spawnSync('cmake',args,{env,stdio:'inherit',windowsHide:true});if(r.error)throw r.error;if(r.status)process.exit(r.status);}
run(['-S',path.join(root,'bedrock-native'),'-B',build,'-G','Visual Studio 17 2022','-A','x64']);
run(['--build',build,'--config','Release']);
const target=path.join(root,'assets','bedrock');fs.mkdirSync(target,{recursive:true});
const files={};for(const name of ['mcl-bedrock.dll','mcl-bedrock-loader.exe']){const bytes=fs.readFileSync(path.join(build,'Release',name));files[name]={sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length};fs.writeFileSync(path.join(target,name),bytes);}
fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify({protocol:1,moduleVersion:'0.5.0',packages:['1.26.5203.0'],adaptive:true,files},null,2)+'\n');

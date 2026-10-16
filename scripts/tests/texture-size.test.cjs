const {test}=require('node:test'),assert=require('node:assert/strict');
const {textureUrl}=require('../../src/main/texture-size');
function png(w,h){const b=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(b);b.write('IHDR',12);b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return 'data:image/png;base64,'+b.toString('base64');}
test('received skin and cape textures obey exact pixel limits',()=>{
 for(const [w,h] of [[64,64],[64,32],[128,128]])assert.equal(textureUrl(png(w,h)),png(w,h));
 for(const [w,h] of [[256,256],[129,128],[128,129],[128,64]])assert.equal(textureUrl(png(w,h)),'');
 for(const [w,h] of [[64,32],[128,64]])assert.equal(textureUrl(png(w,h),'cape'),png(w,h));
 for(const [w,h] of [[256,128],[129,64],[128,65],[128,128]])assert.equal(textureUrl(png(w,h),'cape'),'');
});


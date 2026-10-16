// Add elbow and knee deformation without changing the skin atlas or the slim-arm width.
// Split triangles across the elbow, retaining their interpolated UV coordinates.
import { BufferGeometry, Float32BufferAttribute } from 'three';

function clip(poly, plane, above) {
  const out = [];
  for (let i=0; i<poly.length; i++) {
    const a=poly[i], b=poly[(i+1)%poly.length];
    const insideA=above ? a[1]>=plane : a[1]<=plane;
    const insideB=above ? b[1]>=plane : b[1]<=plane;
    if (insideA) out.push(a);
    if (insideA!==insideB) {
      const t=(plane-a[1])/(b[1]-a[1]);
      out.push(a.map((value,j)=>value+(b[j]-value)*t));
    }
  }
  return out;
}

export function segmentedGeometry(source) {
  const data=source.index ? source.toNonIndexed() : source.clone();
  const pos=data.getAttribute('position'), uv=data.getAttribute('uv'), normals=data.getAttribute('normal');
  const positions=[], uvs=[], ns=[];
  for(let i=0;i<pos.count;i+=3) {
    const triangle=[0,1,2].map(j=>[pos.getX(i+j),pos.getY(i+j),pos.getZ(i+j),uv.getX(i+j),uv.getY(i+j),normals.getX(i+j),normals.getY(i+j),normals.getZ(i+j)]);
    for(const [lo,hi] of [[-Infinity,-.08],[-.08,0],[0,.08],[.08,Infinity]]) {
      let poly=triangle;
      if(Number.isFinite(lo)) poly=clip(poly,lo,true);
      if(Number.isFinite(hi)) poly=clip(poly,hi,false);
      for(let j=1;j<poly.length-1;j++) for(const vertex of [poly[0],poly[j],poly[j+1]]) {
        positions.push(...vertex.slice(0,3));uvs.push(...vertex.slice(3,5));ns.push(...vertex.slice(5,8));
      }
    }
  }
  data.dispose();
  const geometry=new BufferGeometry();
  geometry.setAttribute('position',new Float32BufferAttribute(positions,3));
  geometry.setAttribute('normal',new Float32BufferAttribute(ns,3));
  geometry.setAttribute('uv',new Float32BufferAttribute(uvs,2));
  return geometry;
}

export class BendRig {
  constructor(skin) {
    this.parts=[];
    // arms bend at the elbow, legs at the knee: both sit mid-box
    for(const [side,arm] of [['left',skin.leftArm],['right',skin.rightArm],['leftLeg',skin.leftLeg],['rightLeg',skin.rightLeg]]) {
      for(const mesh of [arm.innerLayer,arm.outerLayer]) {
        const original=mesh.geometry;
        const geometry=segmentedGeometry(original);
        mesh.geometry=geometry;
        this.parts.push({side,mesh,original,geometry,positions:geometry.attributes.position.array.slice(),normals:geometry.attributes.normal.array.slice()});
      }
    }
  }
  // A bend is a number (fold forward, radians) or {x, z}: x folds the
  // forearm forward/back, z swings it sideways. Rotations happen in the
  // arm's scaled space, so the box keeps its proportions.
  // Knees take the same {x, z}: x > 0 folds the shin back.
  apply(left=0,right=0,leftLeg=0,rightLeg=0) {
    // the same bend as last frame (standing still, mostly): the arms are
    // already there — no vertices to redo, nothing to upload
    const key=JSON.stringify([left,right,leftLeg,rightLeg]);
    if(key===this.lastKey)return;
    this.lastKey=key;
    for(const p of this.parts) {
      const b=p.side==='left'?left:p.side==='right'?right:p.side==='leftLeg'?leftLeg:rightLeg;
      const ax=typeof b==='number'?b:(b&&b.x)||0, az=typeof b==='number'?0:(b&&b.z)||0;
      const dst=p.geometry.attributes.position.array, normal=p.geometry.attributes.normal.array;
      const sx=p.mesh.scale.x, sy=p.mesh.scale.y, sz=p.mesh.scale.z;
      for(let i=0;i<dst.length;i+=3) {
        const y=p.positions[i+1];
        const weight=Math.max(0,Math.min(1,(.08-y)/.16));
        const c1=Math.cos(ax*weight), s1=Math.sin(ax*weight), c2=Math.cos(az*weight), s2=Math.sin(az*weight);
        // position: scale up, rotate about x then z, scale back
        const X=p.positions[i]*sx, Y=y*sy, Z=p.positions[i+2]*sz;
        const Y1=Y*c1-Z*s1, Z1=Y*s1+Z*c1;
        dst[i]=(X*c2-Y1*s2)/sx;dst[i+1]=(X*s2+Y1*c2)/sy;dst[i+2]=Z1/sz;
        // normal: the same rotation in inverse-scaled space
        const nx=p.normals[i]/sx, ny=p.normals[i+1]/sy, nz=p.normals[i+2]/sz;
        const ny1=ny*c1-nz*s1, nz1=ny*s1+nz*c1;
        normal[i]=(nx*c2-ny1*s2)*sx;normal[i+1]=(nx*s2+ny1*c2)*sy;normal[i+2]=nz1*sz;
      }
      p.geometry.attributes.position.needsUpdate=true;
      p.geometry.attributes.normal.needsUpdate=true;
      p.geometry.computeBoundingSphere();
    }
  }
  dispose() {
    for(const p of this.parts) {p.mesh.geometry=p.original;p.geometry.dispose();}
    this.parts=[];
  }
}

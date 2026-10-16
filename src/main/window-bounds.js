'use strict';
// All bounds are Electron device-independent pixels, including Windows scaling.
function fitBounds(state, area, defW=1140, defH=800) {
  const s=state||{};
  const width=Math.min(area.width,Math.max(Math.min(900,area.width),Number(s.width)||defW));
  const height=Math.min(area.height,Math.max(Math.min(580,area.height),Number(s.height)||defH));
  const wantedX=Number.isFinite(s.x)?s.x:area.x+Math.round((area.width-width)/2);
  const wantedY=Number.isFinite(s.y)?s.y:area.y+Math.round((area.height-height)/2);
  return {width,height,x:Math.max(area.x,Math.min(wantedX,area.x+area.width-width)),y:Math.max(area.y,Math.min(wantedY,area.y+area.height-height))};
}
const MAIN_WINDOW_SIZE = Object.freeze({ width: 1261, height: 860 });
function fixedMainBounds(state, area) {
  return fitBounds({ ...state, ...MAIN_WINDOW_SIZE }, area, MAIN_WINDOW_SIZE.width, MAIN_WINDOW_SIZE.height);
}
module.exports={fitBounds, fixedMainBounds, MAIN_WINDOW_SIZE};

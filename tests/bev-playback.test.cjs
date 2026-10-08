const test = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
function load(filename) {
  filename=path.resolve(filename)
  const result=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}})
  const mod=new Module(filename);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));mod._compile(result.outputText,filename)
  return mod.exports
}
const {nearestFrame,reprojectPoint,isDisplayableObject}=load('src/utils/bevScene.ts')
const {validateTimelinePayload}=load('vite-bev-plugin.ts')
const object={id:'car',x:-4,z:3,vz:25,width:1.9,length:4.5,heading:0,kind:'vehicle',confidence:.9,rangeSource:'moge2'}
const frame=(timeSec,objects=[],lanes=[])=>({timeSec,objects,lanes})
test('a disappearing car must not race ahead at ego speed',()=>{
 const manifest={frames:[frame(0,[object]),frame(1)]}
 const output=nearestFrame(manifest,.49).objects[0]
 assert.equal(output.z,3);assert.equal(output.x,-4);assert.ok(isDisplayableObject(output))
 assert.equal(nearestFrame(manifest,.51).objects.length,0)
})
test('playhead geometry does not depend on direction or prior seeks',()=>{
 const manifest={frames:[frame(0,[object]),frame(1,[{...object,x:-3,z:4}])]}
 const expected=nearestFrame(manifest,.25)
 nearestFrame(manifest,.95);nearestFrame(manifest,0)
 assert.deepEqual(nearestFrame(manifest,.25),expected)
})
test('world-fixed history is transported to current ego coordinates',()=>{
 const point=reprojectPoint(0,20,{x:0,z:0,yaw:0},{x:0,z:10,yaw:0})
 assert.deepEqual(point,[0,10])
 const rotated=reprojectPoint(0,20,{x:0,z:0,yaw:0},{x:0,z:0,yaw:Math.PI/2})
 assert.ok(Math.abs(rotated[0]+20)<1e-9)
})
test('different lane IDs are never blended just because counts agree',()=>{
 const before={...frame(0,[],[[[1,4],[1,30]]]),laneIds:['a']}
 const after={...frame(1,[],[[[5,4],[5,30]]]),laneIds:['b']}
 assert.equal(nearestFrame({frames:[before,after]},.4).lanes[0][0][0],1)
})
test('lane identity rather than array order controls interpolation',()=>{
 const before={...frame(0,[],[[[1,4],[1,30]],[[5,4],[5,30]]]),laneIds:['a','b']}
 const after={...frame(1,[],[[[5.2,4],[5.2,30]],[[1.2,4],[1.2,30]]]),laneIds:['b','a']}
 assert.ok(Math.abs(nearestFrame({frames:[before,after]},.4).lanes[0][0][0]-1.08)<1e-9)
})
test('server rejects obsolete and empty caches',()=>{
 const value={clip:'example',schemaVersion:4,tracker:'kalman-road-history-v2',rangeBackend:'moge2',frames:[frame(0),frame(1)]}
 assert.match(validateTimelinePayload(value,'example'),/没有可用/)
 assert.match(validateTimelinePayload({...value,schemaVersion:3},'example'),/旧跟踪器/)
 const valid={...value,frames:[frame(0,[object]),frame(1,[object])]}
 assert.equal(validateTimelinePayload(valid,'example'),undefined)
 assert.match(validateTimelinePayload({...valid,frames:[frame(0,[{...object,heading:NaN}]),frame(1,[object])]},'example'),/非有限/)
})
test('near-field vulnerable road users use backend-compatible score thresholds',()=>{
 assert.equal(isDisplayableObject({...object,kind:'pedestrian',confidence:.3}),true)
})
test('outside an acceptance window never freezes stale geometry',()=>{
 const manifest={stepSec:.5,frames:[frame(48,[object]),frame(59.5,[object])]}
 assert.equal(nearestFrame(manifest,0),null)
 assert.equal(nearestFrame(manifest,61),null)
})

test('Python and Vite compute identical input fingerprints',async()=>{
 const {execFileSync}=require('node:child_process')
 const {inputFingerprints}=load('vite-bev-plugin.ts')
 const actual=await inputFingerprints(process.cwd(),'2026-07-23_07-54-38')
 const expected=JSON.parse(execFileSync('.recon-venv/bin/python',['-c',`import sys,json; from pathlib import Path; sys.path.insert(0,'tools'); from bev_version import pipeline_fingerprint,source_fingerprint; from reconstruct_bev import discover_videos; print(json.dumps(dict(pipeline=pipeline_fingerprint(Path('.'),Path('calibration/tesla_hw4_measured.json'),Path('yolo11n.pt')),source=source_fingerprint(discover_videos(Path('videos/2026-07-23_07-58-12'),'2026-07-23_07-54-38')))))`],{encoding:'utf8'}))
 assert.deepEqual(actual,expected)
})

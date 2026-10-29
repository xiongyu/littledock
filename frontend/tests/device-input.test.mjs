import test from 'node:test'
import assert from 'node:assert/strict'
import { devicePoint, wdbKey } from '../src/device-input.ts'
test('device input excludes letterboxing and maps displayed pixels to native coordinates',()=>{
  const bounds={left:100,top:50,width:1000,height:500}
  assert.equal(devicePoint(100,300,bounds,720,1280),undefined)
  assert.deepEqual(devicePoint(600,300,bounds,720,1280),{x:360,y:640,normalizedX:0.5,normalizedY:0.5})
  assert.equal(devicePoint(600,550,bounds,720,1280),undefined)
  assert.equal(devicePoint(1,1,bounds,0,0),undefined)
})
test('physical keyboard mapping preserves extended keys and reserves F8',()=>{
  assert.deepEqual(wdbKey('KeyA'),{scan_code:30,extended:false})
  assert.deepEqual(wdbKey('ArrowLeft'),{scan_code:75,extended:true})
  assert.deepEqual(wdbKey('ControlRight'),{scan_code:29,extended:true})
  assert.equal(wdbKey('F8'),undefined);assert.equal(wdbKey('Unknown'),undefined)
})

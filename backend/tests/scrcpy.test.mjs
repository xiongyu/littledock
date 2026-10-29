import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { ScrcpyFrames, scrcpyTouch, scrcpyKey, scrcpyClipboard, scrcpyScroll } from '../src/plugins/adb/scrcpy-protocol.ts'
import { h264Size } from '../src/plugins/adb/h264-size.ts'

test('scrcpy frames preserve config/key flags and every TCP split without dropping frames',()=>{
  const packet=(flags,payload)=>{const b=Buffer.alloc(12+payload.length);b.writeBigUInt64BE(flags);b.writeUInt32BE(payload.length,8);payload.copy(b,12);return b}
  const config=packet(1n<<63n,Buffer.from('config')),key=packet((1n<<62n)|123456n,Buffer.from('key')),delta=packet(123457n,Buffer.alloc(8193,71)),all=Buffer.concat([config,key,delta])
  for(const chunkSize of [1,7,12,13,500,16384]){const frames=[],parser=new ScrcpyFrames();for(let i=0;i<all.length;i+=chunkSize)parser.push(all.subarray(i,i+chunkSize),b=>frames.push(b));assert.deepEqual(frames,[config,key,delta])}
  for(const length of [0,4*1024*1024+1,0xffffffff]){const header=Buffer.alloc(12);header.writeUInt32BE(length,8);assert.throws(()=>new ScrcpyFrames().push(header,()=>assert.fail()),{code:'SCRCPY_FRAME'})}
})

test('scrcpy input encodes physical touch, key modifiers and UTF-8 paste exactly',()=>{
  const down=scrcpyTouch(0,719,1279,720,1280),up=scrcpyTouch(1,719,1279,720,1280)
  assert.equal(down.length,32);assert.equal(down.readBigInt64BE(2),-2n);assert.equal(down.readUInt32BE(10),719);assert.equal(down.readUInt16BE(18),720);assert.equal(down.readUInt16BE(22),65535);assert.equal(up.readUInt16BE(22),0);assert.equal(up.readUInt32BE(28),0)
  assert.throws(()=>scrcpyTouch(0,720,0,720,1280));assert.throws(()=>scrcpyTouch(0,NaN,0,720,1280))
  const key=scrcpyKey(29,true,0x1001);assert.equal(key.length,14);assert.equal(key.readUInt32BE(2),29);assert.equal(key.readUInt32BE(10),0x1001);assert.equal(scrcpyKey(29,false)[1],1)
  const paste=scrcpyClipboard('WebNav 中文 🧪');assert.equal(paste[0],9);assert.equal(paste[9],1);assert.equal(paste.readUInt32BE(10),Buffer.byteLength('WebNav 中文 🧪'));assert.equal(paste.subarray(14).toString(),'WebNav 中文 🧪')
  assert.throws(()=>scrcpyClipboard('x'.repeat(4097)));assert.throws(()=>scrcpyClipboard('\0'))
  const scroll=scrcpyScroll(20,30,720,1280,120);assert.equal(scroll.length,21);assert.equal(scroll.readInt16BE(15),-32767)
})

function sps(width,height){
  let bits='';const fixed=(n,size)=>{bits+=n.toString(2).padStart(size,'0')},ue=n=>{const s=(n+1).toString(2);bits+='0'.repeat(s.length-1)+s}
  fixed(66,8);fixed(0,8);fixed(31,8);ue(0);ue(0);ue(0);ue(0);ue(1);fixed(0,1);ue(Math.ceil(width/16)-1);ue(Math.ceil(height/16)-1);fixed(1,1);fixed(1,1);fixed(1,1);ue(0);ue((Math.ceil(width/16)*16-width)/2);ue(0);ue((Math.ceil(height/16)*16-height)/2);fixed(0,1);fixed(1,1)
  bits=bits.padEnd(Math.ceil(bits.length/8)*8,'0');const data=Buffer.from(bits.match(/.{8}/g).map(b=>parseInt(b,2)))
  return Buffer.concat([Buffer.from([0,0,0,1,0x67]),data,Buffer.from([0,0,1,0x68,0])])
}
test('H.264 rotation dimensions include SPS cropping and reject corrupt SPS',()=>{
  for(const [width,height] of [[720,1280],[1280,720],[1920,1080],[1024,768]])assert.deepEqual(h264Size(sps(width,height)),{width,height})
  assert.equal(h264Size(Buffer.from([0,0,1,0x68,0])),undefined)
  assert.throws(()=>h264Size(Buffer.from([0,0,1,0x67,66])))
})

test('bundled scrcpy server matches the pinned official release checksum',async()=>{
  const bytes=await readFile(new URL('../plugins/builtin.adb/scrcpy/scrcpy-server-v3.3.4.jar',import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e')
})

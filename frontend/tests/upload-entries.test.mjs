import test from 'node:test'
import assert from 'node:assert/strict'
import { droppedEntries,remoteChild } from '../src/upload-entries.ts'
const file=name=>({name,isFile:true,isDirectory:false,file(resolve){resolve(new File(['中文'],name))}})
const folder=(name,children)=>({name,isFile:false,isDirectory:true,createReader(){let index=0;return {readEntries(resolve){resolve(children.slice(index,index+=2))}}}})
const data=entries=>({items:entries.map(entry=>({kind:'file',webkitGetAsEntry(){return entry}})),files:[]})
test('folder drop reads every directory batch, preserves empty folders and full relative paths',async()=>{
  const result=await droppedEntries(data([folder('项目',[file('a.txt'),file('b.txt'),folder('empty',[]),folder('nested',[file('c.txt')])])]))
  assert.deepEqual(result.map(x=>x.relative),['项目','项目/a.txt','项目/b.txt','项目/empty','项目/nested','项目/nested/c.txt'])
  assert.equal(result[3].file,undefined);assert.equal(await result[1].file.text(),'中文')
  assert.equal(remoteChild('/C:/Users/demo/','项目/a.txt'),'/C:/Users/demo/项目/a.txt')
})
test('folder drop refuses excessive depth or entry count and supports ordinary file fallback',async()=>{
  let deep=file('end');for(let i=0;i<34;i++)deep=folder('level',[deep])
  await assert.rejects(droppedEntries(data([deep])),/32/)
  await assert.rejects(droppedEntries(data([folder('many',Array.from({length:2001},(_,i)=>file(String(i))))])),/2,000/)
  const result=await droppedEntries({items:[],files:[new File(['x'],'test.txt')]});assert.equal(result[0].relative,'test.txt')
})

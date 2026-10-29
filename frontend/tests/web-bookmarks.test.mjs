import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBookmarkSnapshot, validateBookmark } from '@webnav/shared'

test('website bookmarks accept standalone public and local URLs without requiring a server record', () => {
  for (const url of ['https://example.com/project?q=one#part', 'http://127.0.0.1:8080/', 'http://[::1]:8080/', 'https://新网站.example/']) {
    assert.deepEqual(validateBookmark({id:'website-1',name:' 网站 ',url}),{id:'website-1',name:'网站',url:new URL(url).href})
  }
})

test('website snapshot validates versions, unique IDs, public fields and bounded preview metadata before replacing client state', () => {
  const row = {id:'website',name:'网站',url:'https://example.com/',version:1,hasLogin:true,previewState:'ready',capturedAt:1234}
  assert.deepEqual(parseBookmarkSnapshot({revision:2,bookmarks:[row]}),{revision:2,bookmarks:[row]})
  for (const input of [
    {revision:-1,bookmarks:[]},
    {revision:1,bookmarks:[row,row]},
    {revision:1,bookmarks:[{...row,password:'must-not-appear'}]},
    {revision:1,bookmarks:[{...row,version:0}]},
    {revision:1,bookmarks:[{...row,hasLogin:'yes'}]},
    {revision:1,bookmarks:[{...row,previewState:'anything'}]},
    {revision:1,bookmarks:[{...row,capturedAt:Infinity}]},
    {revision:1,bookmarks:Array.from({length:201},(_,i)=>({...row,id:`site-${i}`}))},
  ]) assert.throws(()=>parseBookmarkSnapshot(input))
})
test('website bookmarks reject script/file links, embedded credentials, control characters and secret metadata', () => {
  for (const url of ['javascript:alert(1)','file:///C:/data','ftp://example.com','https://user:password@example.com','https://example.com/\npath','//example.com','example.com','']) {
    assert.throws(()=>validateBookmark({id:'website-1',name:'网站',url}))
  }
  for (const value of [
    {id:'../record',name:'网站',url:'https://example.com'},
    {id:'website',name:' '.repeat(3),url:'https://example.com'},
    {id:'website',name:'网站',url:'https://example.com',password:'forbidden'},
    {id:'website',name:'网站',url:'https://example.com',username:'private'},
  ]) assert.throws(()=>validateBookmark(value))
})

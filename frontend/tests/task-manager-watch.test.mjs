import test from 'node:test'
import assert from 'node:assert/strict'
import { addWatchedProcess, updateWatchedProcesses, MAX_WATCHED_PROCESSES } from '../src/task-manager-watch.ts'
import { parseTaskManagerCommandLine } from '@webnav/shared'
const process = (pid=10,startedAt=100) => ({pid,startedAt,ppid:0,name:'test-'+pid,cpuPercent:0,memoryBytes:1024})
const sample = (sampledAt,processes)=>({sampledAt,processes})
test('watch identities survive sorting, missing samples and PID reuse without adopting replacements',()=>{
 const a=process(), b=process(11), first=sample(1000,[a,b]);let watched=addWatchedProcess([],a,first);watched=addWatchedProcess(watched,b,first)
 watched=updateWatchedProcesses(watched,sample(2000,[{...b,cpuPercent:90},{...a,memoryBytes:4096}]),1000)
 assert.deepEqual(watched.map(item=>item.process.pid),[10,11]);assert.equal(watched[0].latest.memoryBytes-watched[0].baseline,3072)
 watched=updateWatchedProcesses(watched,sample(3000,[process(10,200),b]),1000)
 assert.equal(watched[0].latest,undefined);assert.equal(watched[0].cpu.at(-1).value,null);assert.equal(watched[0].memory.at(-1).value,null)
 assert.equal(watched[0].key,'10:100');assert.equal(watched[1].cpu.at(-1).value,0)
})
test('watch bounds, duplicate samples, unknown creation times and pause gaps are explicit',()=>{
 let watched=[];const s=sample(1000,[])
 for(let i=0;i<MAX_WATCHED_PROCESSES+2;i++)watched=addWatchedProcess(watched,process(i+1),s)
 assert.equal(watched.length,MAX_WATCHED_PROCESSES)
 assert.equal(addWatchedProcess([],process(1,0),s).length,0)
 let one=addWatchedProcess([],process(),s);one=addWatchedProcess(one,process(),s);assert.equal(one.length,1)
 const same=updateWatchedProcesses(one,s,1000);assert.equal(same[0],one[0])
 one=updateWatchedProcesses(one,sample(30000,[process()]),1000);assert.equal(one[0].cpu.at(-2).value,null)
 for(let at=31000;at<500000;at+=500)one=updateWatchedProcesses(one,sample(at,[process()]),1000)
 assert.ok(one[0].cpu.length<=300);assert.ok(one[0].cpu.at(-1).at-one[0].cpu[0].at<=300000)
})
test('command line boundary distinguishes empty, denied and truncated values and rejects malformed data',()=>{
 const base={pid:10,startedAt:100,commandLine:'app "中文 two words"',truncated:false}
 assert.equal(parseTaskManagerCommandLine(base).commandLine,base.commandLine)
 assert.equal(parseTaskManagerCommandLine({...base,commandLine:''}).commandLine,'')
 assert.equal(parseTaskManagerCommandLine({...base,commandLine:null,unavailable:'permission'}).unavailable,'permission')
 for(const override of [{commandLine:null},{commandLine:'x',unavailable:'permission'},{commandLine:'x'.repeat(32769)},{commandLine:'x\0secret'},{truncated:'true'}])assert.throws(()=>parseTaskManagerCommandLine({...base,...override}))
})

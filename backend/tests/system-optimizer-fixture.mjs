import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Isolated test adapter only: never included in the official bundled plugin.
export async function prepareOptimizerFixture(repo) {
    const rules = JSON.parse(await readFile(join(repo, 'windows/rules.json'), 'utf8'))
    // Replaces the adapter in this temporary Git fixture only; never part of the published plugin.
    const adapter = `const rules=${JSON.stringify(rules)};
    const values=new Map();const startup={exists:true,type:'ExpandString',data:'%TEMP%/fixture.exe --fixture-secret'};values.set('startup',startup);
    for(const rule of rules)values.set(rule.id,{exists:true,type:'DWord',data:rule.value===0?1:2});
    export class NativeWindowsAdapter {
      async snapshot(){return {identity:'isolated-fixture',computer:'测试电脑 · 模拟数据',user:'fixture',build:26200,scannedAt:Date.now(),coverage:['fixture'],warnings:[],items:[
        {id:'startup',name:'示例云盘',category:'startup',source:'CurrentUser / Registry64 / Run',state:'registered',writable:values.get('startup').exists,note:'fixture',target:{hive:'CurrentUser',view:'Registry64',path:'Software/fixture',name:'startup'},before:values.get('startup'),desired:{exists:false},details:startup.data},
        {id:'readonly',name:'系统计划任务（示例）',category:'startup',source:'Startup task',state:'Ready',writable:false,note:'只读'},
        ...rules.map(rule=>({id:rule.id,name:rule.title,category:'settings',source:rule.group,state:'custom',writable:true,note:rule.note,target:{hive:'CurrentUser',view:'Registry64',path:rule.path,name:rule.id},before:values.get(rule.id),desired:{exists:true,type:'DWord',data:rule.value}})),
        ...['示例浏览器','示例编辑器','示例播放器'].map((name,index)=>({id:'app'+index,name,category:'apps',source:'CurrentUser',state:'installed',writable:false,note:'',publisher:'测试发布者',version:'1.0'}))]}}
      async read(target){return structuredClone(values.get(target.name)||{exists:false})}
      async apply(target,expected,desired){const value=values.get(target.name);if(JSON.stringify(value)!==JSON.stringify(expected))return {status:'conflict',current:value};values.set(target.name,structuredClone(desired));return {status:'applied',current:desired}}
      async protect(value){return Buffer.from(value).toString('base64')}async unprotect(value){return Buffer.from(value,'base64').toString('utf8')}async openSettings(){}async close(){}
    }`
    await writeFile(join(repo, 'runtime/windows.js'), adapter)
}

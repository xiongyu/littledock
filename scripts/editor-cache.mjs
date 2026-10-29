import { join } from 'node:path'
import { homedir } from 'node:os'
import { editorPackages, EditorPackageCache } from '../backend/src/plugins/remote-editor/packages.ts'

const targets=process.argv.slice(2)
if(!targets.length||targets.some(target=>!Object.hasOwn(editorPackages,target))){
  console.error('用法：pnpm editor:cache windows-x64 linux-x64（可选 windows-arm64 / linux-arm64）')
  process.exitCode=1
}else{
  const data=process.env.WEBNAV_DATA_DIR??join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'WebNav')
  const cache=new EditorPackageCache(process.env.WEBNAV_EDITOR_PACKAGE_DIR??join(data,'editor-packages'))
  for(const target of targets){const pkg=editorPackages[target];console.log(`${pkg.product} ${pkg.version} (${target})`);let last=-1;const file=await cache.ensure(pkg,new AbortController().signal,p=>{if(Math.floor(p/10)>last){last=Math.floor(p/10);console.log(`${p}%`)}});console.log(file)}
}

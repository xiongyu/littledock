import { ref, watch } from 'vue'

export function useWorkspacePreferences(){
  const defaults={navigationWidth:232,navigationClosed:false,systemOpen:true,systemWidth:260,filesOpen:true,filesHeight:220}
  let initial={...defaults}
  try{
    const saved=JSON.parse(localStorage.getItem('webnav.workspace-layout')??'{}') as Record<string,unknown>
    for(const key of ['navigationClosed','systemOpen','filesOpen'] as const)if(typeof saved[key]==='boolean')initial[key]=saved[key]
    if(typeof saved.navigationWidth==='number'&&Number.isFinite(saved.navigationWidth))initial.navigationWidth=Math.max(164,Math.min(400,saved.navigationWidth))
    if(typeof saved.systemWidth==='number'&&Number.isFinite(saved.systemWidth))initial.systemWidth=Math.max(200,Math.min(420,saved.systemWidth))
    if(typeof saved.filesHeight==='number'&&Number.isFinite(saved.filesHeight))initial.filesHeight=Math.max(140,Math.min(420,saved.filesHeight))
  }catch{}
  const settings=ref(initial)
  watch(settings,value=>{try{localStorage.setItem('webnav.workspace-layout',JSON.stringify(value))}catch{}},{deep:true})
  return settings
}
export function dragDimension(event:PointerEvent,update:(event:PointerEvent)=>void){
  if(event.button!==0)return
  event.preventDefault()
  const target=event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const end=()=>{target.removeEventListener('pointermove',update);target.removeEventListener('pointerup',end);target.removeEventListener('pointercancel',end);target.removeEventListener('lostpointercapture',end)}
  target.addEventListener('pointermove',update);target.addEventListener('pointerup',end);target.addEventListener('pointercancel',end);target.addEventListener('lostpointercapture',end)
}
export function formatBytes(bytes:number){if(!bytes)return '0 B';const unit=Math.min(4,Math.floor(Math.log(bytes)/Math.log(1024)));return (bytes/1024**unit).toFixed(unit?1:0)+' '+['B','KiB','MiB','GiB','TiB'][unit]}

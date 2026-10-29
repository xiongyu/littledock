/** Physical Set-1 scan codes; F8 stays reserved by WDB. */
export function wdbKey(code:string):{scan_code:number;extended:boolean}|undefined{
  const rows:[string[],number][]=[
    [['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0','Minus','Equal','Backspace','Tab'],2],
    [['KeyQ','KeyW','KeyE','KeyR','KeyT','KeyY','KeyU','KeyI','KeyO','KeyP','BracketLeft','BracketRight','Enter','ControlLeft'],16],
    [['KeyA','KeyS','KeyD','KeyF','KeyG','KeyH','KeyJ','KeyK','KeyL','Semicolon','Quote','Backquote','ShiftLeft','Backslash'],30],
    [['KeyZ','KeyX','KeyC','KeyV','KeyB','KeyN','KeyM','Comma','Period','Slash','ShiftRight','NumpadMultiply','AltLeft','Space','CapsLock'],44],
  ]
  for(const [names,start] of rows){const index=names.indexOf(code);if(index>=0)return {scan_code:start+index,extended:false}}
  const normal:Record<string,number>={Escape:1,F1:59,F2:60,F3:61,F4:62,F5:63,F6:64,F7:65,F9:67,F10:68,F11:87,F12:88,NumLock:69,ScrollLock:70,Numpad7:71,Numpad8:72,Numpad9:73,NumpadSubtract:74,Numpad4:75,Numpad5:76,Numpad6:77,NumpadAdd:78,Numpad1:79,Numpad2:80,Numpad3:81,Numpad0:82,NumpadDecimal:83}
  const extended:Record<string,number>={ControlRight:29,AltRight:56,MetaLeft:91,MetaRight:92,ContextMenu:93,NumpadEnter:28,NumpadDivide:53,Home:71,ArrowUp:72,PageUp:73,ArrowLeft:75,ArrowRight:77,End:79,ArrowDown:80,PageDown:81,Insert:82,Delete:83}
  return normal[code]?{scan_code:normal[code]!,extended:false}:extended[code]?{scan_code:extended[code]!,extended:true}:undefined
}
export function devicePoint(clientX:number,clientY:number,bounds:{left:number;top:number;width:number;height:number},width:number,height:number){
  if(!width||!height||!bounds.width||!bounds.height)return undefined
  const scale=Math.min(bounds.width/width,bounds.height/height),left=bounds.left+(bounds.width-width*scale)/2,top=bounds.top+(bounds.height-height*scale)/2
  const x=(clientX-left)/scale,y=(clientY-top)/scale
  if(x<0||y<0||x>=width||y>=height)return undefined
  return {x:Math.min(width-1,Math.floor(x)),y:Math.min(height-1,Math.floor(y)),normalizedX:x/width,normalizedY:y/height}
}

import { ref } from 'vue'
export const remoteEditorRequest=ref<{sessionId:string;folder:string;name:string;revision:number}>()
export function openRemoteEditor(sessionId:string,folder:string,name:string) { remoteEditorRequest.value={sessionId,folder,name,revision:Date.now()} }

declare module 'jmuxer' {
  export default class JMuxer {
    constructor(options:{node:HTMLVideoElement;mode:'video';fps?:number;flushingTime?:number;maxDelay?:number;clearBuffer?:boolean;debug?:boolean;onReady?:()=>void;onError?:()=>void;onUnsupportedCodec?:()=>void})
    feed(data:{video:Uint8Array;duration:number;isLastVideoFrameComplete?:boolean}):void
    destroy():void
    reset():void
    // Pinned JMuxer 2.1.0 internals used solely to bound its append/remux queues.
    bufferControllers?:{video?:{queue:Uint8Array|null;cleanOffset:number}}|null
    remuxController?:{tracks:{video?:{mp4track:{len:number};remainingData:Uint8Array}}}|null
  }
}

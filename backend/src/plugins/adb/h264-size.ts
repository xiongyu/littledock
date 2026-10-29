/** H.264 SPS coded dimensions (7.3.2.1); bounded bit reads, including crop units. */
export function h264Size(config:Buffer):{width:number;height:number}|undefined{
  const starts:number[]=[]
  for(let i=0;i+3<config.length;i++)if(config[i]===0&&config[i+1]===0&&config[i+2]===1)starts.push(i+3)
  for(let i=0;i<starts.length;i++){
    const start=starts[i]!;if((config[start]!&31)!==7)continue
    const nal=config.subarray(start+1,i+1<starts.length?starts[i+1]!-3:config.length),data:number[]=[]
    for(let j=0;j<nal.length;j++){if(j>=2&&nal[j]===3&&nal[j-1]===0&&nal[j-2]===0)continue;data.push(nal[j]!)}
    let bit=0
    const read=(count:number)=>{if(count>32||bit+count>data.length*8)throw new Error('Truncated SPS');let value=0;for(let j=0;j<count;j++,bit++)value=value*2+((data[bit>>3]!>>(7-(bit&7)))&1);return value}
    const ue=()=>{let zeros=0;while(!read(1)){if(++zeros>24)throw new Error('SPS integer too large')}return 2**zeros-1+read(zeros)}
    const se=()=>{const value=ue();return value%2?(value+1)/2:-value/2}
    const profile=read(8);read(16);ue();let chroma=1,separate=0
    if([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile)){
      chroma=ue();if(chroma>3)throw new Error('Invalid SPS chroma');if(chroma===3)separate=read(1)
      ue();ue();read(1)
      if(read(1))for(let list=0;list<(chroma===3?12:8);list++)if(read(1)){let last=8,next=8;for(let n=0;n<(list<6?16:64);n++){if(next!==0)next=(last+se()+256)%256;if(next!==0)last=next}}
    }
    ue();const order=ue();if(order===0)ue();else if(order===1){read(1);se();se();const n=ue();if(n>256)throw new Error('Invalid SPS order');for(let j=0;j<n;j++)se()}
    ue();read(1);const mbs=ue()+1,mapUnits=ue()+1,frameOnly=read(1);if(!frameOnly)read(1);read(1)
    let left=0,right=0,top=0,bottom=0;if(read(1)){left=ue();right=ue();top=ue();bottom=ue()}
    const format=separate?0:chroma,cropX=format===1||format===2?2:1,cropY=(format===1?2:1)*(2-frameOnly)
    const width=mbs*16-(left+right)*cropX,height=(2-frameOnly)*mapUnits*16-(top+bottom)*cropY
    if(width<1||width>8192||height<1||height>8192)throw new Error('Invalid SPS dimensions')
    return {width,height}
  }
}

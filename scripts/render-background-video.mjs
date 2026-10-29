// Render a deterministic, seamless test video from the existing generated landscape.
// Requires ffmpeg on PATH. Output is a review artifact, not an installed/default background.
import { mkdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const source = fileURLToPath(new URL('../frontend/public/skins/harbor-dusk/workspace.png', import.meta.url))
const output = fileURLToPath(new URL('../docs/design/videos/harbor-dusk-loop.mp4', import.meta.url))
await mkdir(dirname(output), { recursive: true })
const cycle = '2*PI*T/8'
// Restrict the ripple to the lake, fade it out towards the fixed pier on the right.
const water = 'clip((Y/H-0.56)/0.44,0,1)*clip((0.86-X/W)/0.12,0,1)'
const x = `clip(X+(W/1280)*(2*sin(${cycle})+3.2*(${water})*sin(2*PI*Y/H*32-3*${cycle})),0,W-1)`
const y = `clip(Y+(H/720)*(0.8*sin(${cycle})+1.1*(${water})*sin(2*PI*Y/H*24-2*${cycle})),0,H-1)`
const filter = `scale=1280:720:flags=lanczos,setsar=1,format=yuv420p,geq=lum='lum(${x},${y})':cb='cb(${x},${y})':cr='cr(${x},${y})'`
const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-n', '-loop', '1', '-framerate', '24', '-i', source,
  '-vf', filter, '-t', '8', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', '-metadata', 'title=LittleDock - Harbor Dusk loop', output], { stdio: 'inherit', windowsHide: true })
await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))) })
console.log(JSON.stringify({ output, bytes: (await stat(output)).size, duration: 8, width: 1280, height: 720, fps: 24, audio: false }))

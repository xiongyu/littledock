import { connect } from 'node:net'
if (process.argv[2] === 'get' && process.env.WEBNAV_SYNC_PIPE) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => { input += chunk; if (input.length > 4096) process.exit(1) })
  process.stdin.on('end', () => {
    const request = Object.fromEntries(input.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
    const socket = connect(process.env.WEBNAV_SYNC_PIPE!)
    socket.setTimeout(3000, () => socket.destroy()); socket.on('error', () => process.exit(1))
    socket.on('connect', () => socket.end(JSON.stringify(request) + '\n'))
    let result = ''
    socket.on('data', bytes => { result += bytes.toString(); if (result.length > 16384) socket.destroy() })
    socket.on('end', () => { try { const data = JSON.parse(result) as Record<string, string>; if (data.username && data.password && !/[\r\n\0]/.test(data.username + data.password)) process.stdout.write(`username=${data.username}\npassword=${data.password}\n\n`) } catch { process.exitCode = 1 } })
  })
}

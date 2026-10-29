import { parentPort } from 'node:worker_threads'
import { argon2id } from 'hash-wasm'
parentPort!.once('message', async ({ input, salt }: { input: Uint8Array; salt: Uint8Array }) => {
  try { const result = await argon2id({ password: input, salt, memorySize: 65536, iterations: 3, parallelism: 4, hashLength: 32, outputType: 'binary' }); parentPort!.postMessage(result); result.fill(0) }
  finally { input.fill(0); salt.fill(0); parentPort!.close() }
})

// Bound image RPCs below the business socket's eight-request limit.
let active = 0
const queue: (() => void)[] = []
export async function loadBookmarkPreview<T>(current: () => boolean, load: () => Promise<T>): Promise<T | undefined> {
  if (active >= 2) await new Promise<void>(resolve => queue.push(resolve))
  else active++
  try { return current() ? await load() : undefined }
  finally {
    const next = queue.shift()
    if (next) next()
    else active--
  }
}

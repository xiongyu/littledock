/** Guacamole lengths count Unicode code points, not UTF-8 bytes or JS code units. */
export function guacamoleInstruction(...values: (string | number)[]): string {
  return values.map(value => {
    const text = String(value)
    let length = text.length
    // Base64 images and BMP text have one code point per UTF-16 code unit.
    // Avoid allocating a character array for every image fragment.
    if (/[\ud800-\udbff]/.test(text)) for (let at = 0; at + 1 < text.length; at++) {
      const high = text.charCodeAt(at), low = text.charCodeAt(at + 1)
      if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) { length--; at++ }
    }
    return `${length}.${text}`
  }).join(',') + ';'
}

/** Bounded incremental decoder for the embedded RDP display/input transport. */
export class GuacamoleDecoder {
  private length = ''
  private remaining = -1
  private parts: string[] = []
  private highSurrogate = ''
  private elements: string[] = []
  private size = 0
  private readonly limit: number
  private failed = false
  constructor(limit = 64 * 1024) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid Guacamole instruction limit')
    this.limit = limit
  }
  private account(count: number) {
    this.size += count
    if (this.size > this.limit) throw new Error('Guacamole instruction too large')
  }
  push(text: string, instruction: (values: string[]) => void) {
    if (this.failed) throw new Error('Guacamole decoder has failed')
    try {
      let at = 0
      while (at < text.length) {
        if (this.remaining === -1) {
          const character = text[at++]!, code = character.charCodeAt(0)
          this.account(1)
          if (code >= 48 && code <= 57 && this.length.length < 8) { this.length += character; continue }
          if (character !== '.' || !this.length) throw new Error('Invalid Guacamole length')
          this.remaining = Number(this.length); this.length = ''
          if (this.remaining > this.limit) throw new Error('Guacamole element too large')
        } else if (this.remaining > 0) {
          // A caller may split a UTF-16 pair between chunks. Hold only that one
          // code unit; never retain the already-consumed input packet/history.
          if (this.highSurrogate) {
            const low = text.charCodeAt(at)
            if (low < 0xdc00 || low > 0xdfff) throw new Error('Invalid Guacamole Unicode')
            this.account(1); this.parts.push(this.highSurrogate + text[at++]!); this.highSurrogate = ''; this.remaining--
            if (!this.remaining) continue
          }
          const start = at
          const available = Math.min(this.remaining, text.length - at), slice = text.slice(at, at + available)
          // Image blobs are base64 and almost all traffic takes this native
          // string-scan path, without a JavaScript loop over every byte.
          if (available && !/[\ud800-\udfff]/.test(slice)) {
            this.account(available); this.parts.push(slice); this.remaining -= available; at += available; continue
          }
          let points = 0
          // Scan once, then retain a contiguous slice. Per-character string
          // appends allocate thousands of ropes for every base64 image blob.
          while (at < text.length && points < this.remaining) {
            const code = text.charCodeAt(at)
            if (code >= 0xd800 && code <= 0xdbff) {
              if (at + 1 === text.length) break
              const low = text.charCodeAt(at + 1)
              if (low < 0xdc00 || low > 0xdfff) throw new Error('Invalid Guacamole Unicode')
              at += 2
            } else {
              if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Invalid Guacamole Unicode')
              at++
            }
            points++
          }
          if (points) { this.account(points); this.parts.push(text.slice(start, at)); this.remaining -= points }
          if (this.remaining && at < text.length) this.highSurrogate = text[at++]!
        } else {
          const character = text[at++]!
          this.account(1)
          if (character !== ',' && character !== ';') throw new Error('Invalid Guacamole delimiter')
          if (this.elements.length >= 256) throw new Error('Too many Guacamole arguments')
          this.elements.push(this.parts.length === 1 ? this.parts[0]! : this.parts.join('')); this.parts = []; this.remaining = -1
          if (character === ';') { const values = this.elements; this.elements = []; this.size = 0; instruction(values) }
        }
      }
    } catch (error) {
      this.failed = true; this.length = ''; this.parts = []; this.highSurrogate = ''; this.elements = []; this.size = 0
      throw error
    }
  }
}

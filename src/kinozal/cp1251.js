// Kinozal pages and forms use windows-1251.

const decoder = new TextDecoder('windows-1251')

export function decode (buf) {
  return decoder.decode(buf)
}

// Reverse table for the upper half of windows-1251.
const encodeTable = new Map()
for (let b = 0x80; b <= 0xff; b++) {
  const ch = decoder.decode(Uint8Array.of(b))
  if (ch !== '�') encodeTable.set(ch, b)
}

/** Percent-encode a string as windows-1251 (for query strings and form bodies). */
export function encodeURIComponent1251 (str) {
  let out = ''
  for (const ch of String(str)) {
    const code = ch.codePointAt(0)
    if (code < 0x80) {
      out += /[A-Za-z0-9\-_.~]/.test(ch) ? ch : '%' + code.toString(16).toUpperCase().padStart(2, '0')
    } else {
      const b = encodeTable.get(ch)
      out += b === undefined ? '%3F' : '%' + b.toString(16).toUpperCase()
    }
  }
  return out
}

export function formBody1251 (fields) {
  return Object.entries(fields).map(([k, v]) => `${encodeURIComponent1251(k)}=${encodeURIComponent1251(v)}`).join('&')
}

/** String → windows-1251 bytes. */
export function encode (str) {
  const out = []
  for (const ch of String(str)) {
    const code = ch.codePointAt(0)
    out.push(code < 0x80 ? code : (encodeTable.get(ch) ?? 0x3f))
  }
  return Buffer.from(out)
}

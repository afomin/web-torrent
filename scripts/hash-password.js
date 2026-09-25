// Usage: npm run hash-password   (prompts for the password, prints AUTH_PASSWORD_HASH=...)
// Non-interactive: PASSWORD_TO_HASH=... node scripts/hash-password.js  (prints only the hash)
import readline from 'node:readline'
import crypto from 'node:crypto'

function hash (password) {
  const salt = crypto.randomBytes(16)
  const h = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `scrypt$16384$${salt.toString('base64')}$${h.toString('base64')}`
}

if (process.env.PASSWORD_TO_HASH) {
  console.log(hash(process.env.PASSWORD_TO_HASH))
  process.exit(0)
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
rl._writeToOutput = s => { if (!rl.muted) rl.output.write(s) }

rl.question('Password: ', password => {
  rl.close()
  process.stdout.write('\n')
  if (password.length < 10) console.warn('Warning: use at least 10 characters.')
  // Single quotes keep "$" literal in .env files and docker compose.
  console.log(`AUTH_PASSWORD_HASH='${hash(password)}'`)
})
rl.muted = true

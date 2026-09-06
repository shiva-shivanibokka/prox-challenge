// Offline check of the grounding verifier. No API calls, no server: npm run check
// The door caption asserts "65 A" for Stick 120V; the manual prints 80 A. A number
// only the flagged caption supports must never come back clean.
import { verify } from '../lib/verify.ts'
const a = verify('Stick on 120V is rated 40% at 65 A [door p.1].', [], [])
const b = verify('MIG at 200A on 240V is 25% duty cycle [p.7].', [])
const c = verify('Set the wire speed to 9999 IPM [p.7].', [])
console.log('flagged 65A  ->', JSON.stringify(a.miscited), JSON.stringify(a.fabricated))
console.log('real 25%/200A->', JSON.stringify(b.miscited), JSON.stringify(b.fabricated))
console.log('invented     ->', JSON.stringify(c.miscited), JSON.stringify(c.fabricated))
if (a.miscited.length + a.fabricated.length === 0) throw new Error('FAIL: flagged number passed as verified')
if (b.miscited.length + b.fabricated.length !== 0) throw new Error('FAIL: real number rejected')
if (c.fabricated.length === 0) throw new Error('FAIL: invented number not caught')
console.log('unit check OK')

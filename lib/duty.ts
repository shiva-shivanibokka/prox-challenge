/**
 * Duty cycle, computed deterministically from the verified specification matrix.
 *
 * Imports tables.json directly rather than going through kb.ts, because the
 * calculator component runs in the browser and kb.ts pulls in the whole 300KB
 * index. This module is the only knowledge the client needs.
 *
 * The manual publishes exactly two rated points per process per input voltage --
 * for MIG on 240V, 25% @ 200A and 100% @ 115A. It does not publish a curve, and
 * duty cycle is not linear in current, so anything between those points is
 * genuinely unspecified. This never interpolates. Inventing a duty cycle for a
 * welder is how someone cooks the machine.
 */
import tablesJson from '../public/kb/tables.json'

export type Spec = {
  process: string
  input_volts: number
  current_range_a: number[]
  duty_cycles: { percent: number; amps: number }[]
}

export const SPECS: Spec[] =
  (tablesJson as { specs?: { data?: { processes?: Spec[] } } }).specs?.data?.processes ?? []

export type Duty =
  | { ok: false; message: string }
  | {
      ok: true
      rated: boolean
      percent?: number
      amps: number
      weldMinutes?: number
      restMinutes?: number
      range: number[]
      message: string
    }

export function dutyCycle(process: string, volts: number, amps: number): Duty {
  const s = SPECS.find(
    (x) => x.process.toLowerCase() === process.toLowerCase() && x.input_volts === volts,
  )
  if (!s) {
    const have = SPECS.map((x) => `${x.process} @ ${x.input_volts}V`).join(', ')
    return { ok: false, message: `No rated data for ${process} on ${volts}V. Rated: ${have}.` }
  }

  const [lo, hi] = s.current_range_a
  if (amps < lo || amps > hi) {
    return {
      ok: false,
      message:
        `${amps}A is outside the ${s.process} range on ${volts}V, which is ${lo}-${hi}A [p.7]. ` +
        `The manual gives no duty cycle there.`,
    }
  }

  const sorted = [...s.duty_cycles].sort((a, b) => a.amps - b.amps)
  const continuous = sorted.find((d) => d.percent === 100)
  const exact = sorted.find((d) => d.amps === amps)

  if (exact) {
    const weld = (10 * exact.percent) / 100
    return {
      ok: true, rated: true, percent: exact.percent, amps,
      weldMinutes: weld, restMinutes: 10 - weld, range: s.current_range_a,
      message:
        exact.percent === 100
          ? `${s.process} at ${amps}A on ${volts}V is rated 100% duty cycle -- weld continuously [p.7].`
          : `${s.process} at ${amps}A on ${volts}V is rated ${exact.percent}% duty cycle: ` +
            `${weld} minutes welding, then ${10 - weld} minutes resting, per 10-minute period [p.7, p.19].`,
    }
  }

  if (continuous && amps <= continuous.amps) {
    return {
      ok: true, rated: true, percent: 100, amps,
      weldMinutes: 10, restMinutes: 0, range: s.current_range_a,
      message:
        `${s.process} on ${volts}V is rated 100% duty cycle up to ${continuous.amps}A, ` +
        `so ${amps}A can be welded continuously [p.7].`,
    }
  }

  const below = [...sorted].reverse().find((d) => d.amps < amps)
  const above = sorted.find((d) => d.amps > amps)
  const bracket = [below, above]
    .filter(Boolean)
    .map((d) => `${d!.percent}% @ ${d!.amps}A`)
    .join(' and ')
  return {
    ok: true, rated: false, amps, range: s.current_range_a,
    message:
      `The manual does not publish a duty cycle for ${s.process} at exactly ${amps}A on ` +
      `${volts}V. It rates only ${bracket} [p.7]. Duty cycle is not linear in current, so ` +
      `do not interpolate. Work to the ` +
      `${below ? `${below.percent}% @ ${below.amps}A` : 'lower'} figure to stay safe.`,
  }
}

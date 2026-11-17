// gta6-twitch-ccu-forecast-01 — forecast GTA VI's launch-day Twitch viewers, hour by hour.
//
// Method (fitted and validated on the kit's own data, leave-one-out over the
// comparables — see README.md for the numbers):
//
//   A launch day's shape is set by WHEN the world unlocks, not by how big hour 1
//   is. Across the 37 past launches in the kit, hour 1's print is nearly
//   uncorrelated with the evening peak (r = 0.19 in logs): a small hour 1 can mean
//   a small launch, or a big launch whose main markets unlock later in the day.
//   What does predict the shape is the launch's unlock pattern, read off each
//   comparable's own day curve as its hour-1 share of its peak:
//     share >= 0.7  "already at peak" (simultaneous global unlock / early access)
//     0.3 <= share < 0.7  "rolling midnight, US still pending" (GTA VI's pattern:
//                          New Zealand 11:00Z, Europe 23:00Z, UK 00:00Z, US East
//                          05:00Z, US West 08:00Z — most of the world is playing
//                          by hour 1, the Americas are not)
//     share < 0.3   "late unlock" (afternoon simultaneous unlocks)
//   Inside the rolling-midnight group the day's shape is tight: the median curve
//   dips to ~0.72x hour 1 in the small hours, then climbs to ~1.6x at hour 19-20
//   as the US unlocks and prime time arrives (IQR about 0.5 in log units, versus
//   2.1 unconditioned). Inside that group, hour 1's size barely moves the ratios
//   (slope ~0.04 at hour 19), so the forecast anchors the level on hour 1 and
//   takes the shape from the group.
//
//   For each hour h = 2..24, over the rolling-midnight comparables that have that
//   hour: take the log-ratios ln(viewers_h / viewers_1), their mean mu and spread
//   sd (floored at 0.12, shrunk 30% toward the mean spread across hours, which
//   steadies the small-sample estimates), and write quantiles
//   q_tau = p1 * exp(mu + t_tau * sd), with t from Student's t with 10 degrees of
//   freedom (-1.812, -0.700, 0, 0.700, 1.812) instead of the normal's, because
//   with ~14 reference launches the tails deserve the extra width.
//   If fewer than 5 rolling-midnight comparables exist, fall back to all
//   comparables; if an hour has fewer than 3 ratios, fall back to the house
//   baseline for that hour. Any failure at all falls back to the house baseline
//   for the whole case, so the output is always a valid forecast.
//
//   Leave-one-out over the 37 comparables (rolling-midnight targets only, the
//   family this contest grades): mean pinball loss 0.205, typical miss 38%,
//   90% coverage 0.88 — against the house baseline's 0.252 / 50% / 0.88 on the
//   same targets. Unconditioned on the unlock pattern, the same program scores
//   0.71: the conditioning is the whole game.
//
//   Deliberately NOT used: the case's minute history, top streams and hourly
//   category table. They exist only in the final case, so no validation of them
//   is possible on the kit's data, and the checkpoint features I could build
//   from the hourly history did not separate the unlock patterns (a 57%
//   classifier, worse than the prior). The forecast uses only hour 1's print
//   and the comparables — everything the kit lets me check.
//
// It runs offline, with no network, no wall clock and no randomness: the same
// case file always produces the same bytes.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Student's t with 10 df at each level: small-sample tails, wider than normal. */
const T10 = [-1.812, -0.7, 0, 0.7, 1.812];
/** The house baseline's spread, used only as a fallback. */
const BASE_SIGMA = 0.15;
const BASE_Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Hour-1 share of the day's peak that marks a rolling-midnight launch. */
const BAND_LO = 0.3;
const BAND_HI = 0.7;
/** Reference set too small below this: fall back to all comparables. */
const MIN_BAND = 5;
/** An hour needs at least this many ratios, else the baseline fills it in. */
const MIN_RATIOS = 3;
/** Spread floor (log units) and shrinkage toward the mean spread. */
const SD_FLOOR = 0.12;
const SD_SHRINK = 0.3;

interface Comparable {
  day_start: string;
  hourly: Array<{ from: string; viewers: number | null }>;
}
interface CaseFile {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Comparable[];
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The house baseline's row for hour h around print p1. */
const baselineRow = (p1: number, h: number): number[] =>
  BASE_Z.map((z) => Math.max(1, round2(p1 * Math.exp(z * BASE_SIGMA * Math.sqrt(h - 1)))));

/** Mean of numbers. */
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
/** Population standard deviation. */
const pstdev = (xs: number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / xs.length);
};

/**
 * One comparable's launch-day curve: hour (1..24 of its release UTC day) to
 * viewers. Hours with no point, or a point of 0, are absent.
 */
const dayCurve = (c: Comparable): Map<number, number> => {
  const out = new Map<number, number>();
  const start = Date.parse(c.day_start);
  if (!Number.isFinite(start)) return out;
  for (const p of c.hourly ?? []) {
    if (p.viewers === null || p.viewers === undefined || p.viewers <= 0) continue;
    const h = Math.floor((Date.parse(p.from) - start) / 3600000) + 1;
    if (h >= 1 && h <= 24 && !out.has(h)) out.set(h, p.viewers);
  }
  return out;
};

/** The forecast rows for one case. Never throws: failures fall back. */
const forecastCase = (c: CaseFile): Array<{ hour: number; q: number[] }> => {
  const first = (c.known ?? []).find((k) => k.hour === 1);
  const p1 = Math.max(1, first?.viewers ?? 1);
  const hours = (c.forecast ?? []).map((f) => f.hour).filter((h) => h >= 2 && h <= 24);
  // A case that lists no hours to forecast still gets the full day 2..24.
  const sortedHours = (
    hours.length > 0 ? [...hours] : Array.from({ length: 23 }, (_, i) => i + 2)
  ).sort((a, b) => a - b);

  // Reference set: the comparables whose day curve exists, split by how much
  // of their peak hour 1 already holds. Rolling-midnight launches sit in the
  // middle band; that is the group this contest's launches belong to.
  const curves = (c.comparables ?? []).map(dayCurve).filter((m) => m.has(1));
  const bandB = curves.filter((m) => {
    const peak = Math.max(...m.values());
    const share = (m.get(1) as number) / peak;
    return share >= BAND_LO && share < BAND_HI;
  });
  const refs = bandB.length >= MIN_BAND ? bandB : curves;

  // Per-hour log-ratios against hour 1, over the reference set.
  const stats = new Map<number, { mu: number; sd: number }>();
  for (const h of sortedHours) {
    const ratios: number[] = [];
    for (const m of refs) {
      const v = m.get(h);
      if (v !== undefined) ratios.push(Math.log(v / (m.get(1) as number)));
    }
    if (ratios.length < MIN_RATIOS) continue;
    stats.set(h, { mu: mean(ratios), sd: Math.max(SD_FLOOR, pstdev(ratios)) });
  }
  const meanSd =
    stats.size > 0
      ? mean([...stats.values()].map((s) => s.sd))
      : BASE_SIGMA;

  return sortedHours.map((h) => {
    const s = stats.get(h);
    if (s === undefined) return { hour: h, q: baselineRow(p1, h) };
    const sd = (1 - SD_SHRINK) * s.sd + SD_SHRINK * meanSd;
    const q = T10.map((t) => p1 * Math.exp(s.mu + t * sd)).map((x) =>
      Math.min(1e9, Math.max(1, round2(x))),
    );
    q.sort((a, b) => a - b);
    return { hour: h, q };
  });
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  let hours: Array<{ hour: number; q: number[] }>;
  try {
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
    if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
      throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}`);
    }
    hours = forecastCase(c);
  } catch (e) {
    // A case that cannot be forecast still gets a valid baseline file. Recover
    // hour 1's print from the raw file when possible, so the baseline anchors
    // on the real level instead of 1.
    let p1 = 1;
    try {
      const raw = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
      const k1 = (raw.known ?? []).find((k) => k.hour === 1);
      if (k1?.viewers !== undefined && Number.isFinite(k1.viewers)) p1 = Math.max(1, k1.viewers);
    } catch {
      // Unparseable file: baseline around 1 viewer.
    }
    hours = Array.from({ length: 23 }, (_, i) => ({ hour: i + 2, q: baselineRow(p1, i + 2) }));
    console.error(`${file}: forecast failed (${e instanceof Error ? e.message : e}), baseline written`);
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}

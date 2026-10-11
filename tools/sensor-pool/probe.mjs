#!/usr/bin/env node
// Shelf-life probe: how old may a 5,i payload be before Disney's edge refuses it?
//
// Run 1 (control): fetch a fresh payload and call the sensor-gated, read-only
// guests endpoint. If the fresh control does not pass, the problem is
// configuration, eligibility or the session -- NOT payload age -- and the run
// stops rather than recording garbage.
//
// Run 2..n (ladder): payloads from the pool whose age has crossed the next
// untested threshold are presented the same way. Results append to a JSON log.
//
// Credentials stay on this machine: pass --swid/--token or paste when
// prompted. See tools/sensor-pool/README.md for where to find them.
//
//   node probe.mjs --pool sensor-pool/pool.jsonl \
//     [--swid ... --token ...] [--date 2026-10-12] \
//     [--facility 16767284] [--park 80007944] \
//     [--results results.json] [--max-tests 4] [--use-count-test] [--dry-run]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';

const GUESTS_URL =
  'https://disneyworld.disney.go.com/ea-vas/planning/api/v1/experiences/guest/guests';
const APP_ID = 'WDW-IOS-8.23.3';
// Hours. The lowest untested threshold a payload's age has crossed is what a
// run tests, oldest threshold first, so daily runs walk the curve outward.
const THRESHOLDS_H = [0.5, 1, 2, 4, 8, 24, 48, 96, 168, 336];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return true; // boolean flag
}

const poolFile = arg('pool', 'sensor-pool/pool.jsonl');
const resultsFile = arg('results', 'sensor-pool-results.json');
const maxTests = Number(arg('max-tests', 4));
const pace = Number(arg('pace', 20000));
const dry = arg('dry-run', false) === true;
const useCountTest = arg('use-count-test', false) === true;

let swid = arg('swid', undefined);
let token = arg('token', undefined);

function log(s) { process.stdout.write(s + '\n'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadPool() {
  if (!existsSync(poolFile)) {
    throw new Error(`pool file not found: ${poolFile} -- capture first (fetch.mjs, or dispatch the sensor-pool workflow)`);
  }
  const lines = readFileSync(poolFile, 'utf8').split('\n').filter(Boolean);
  const pool = lines.map((line, i) => {
    const rec = JSON.parse(line);
    return { ...rec, ref: `line${i + 1}` };
  });
  log(`pool: ${pool.length} payloads, ages ${(a => `${a.min}h..${a.max}h`)(range(pool))}`);
  return pool;
}
function range(pool) {
  const ages = pool.map(p => (Date.now() - p.t) / 36e5);
  return { min: Math.min(...ages).toFixed(1), max: Math.max(...ages).toFixed(1) };
}

async function prompt(what) {
  if (!process.stdin.isTTY) {
    throw new Error(`${what} missing: pass it with --${what === 'SWID' ? 'swid' : 'token'} or run from a terminal to paste it`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const field = what === 'SWID' ? 'swid' : 'accessToken';
  let answer;
  for (;;) {
    answer = (await rl.question(`${what}: `)).trim().replace(/^["']|["']$/g, '');
    // A DevTools object preview shows long strings truncated with an ellipsis;
    // copying from the preview therefore yields a short value containing a
    // non-ASCII character, which fetch would only reject much later, inside
    // the Authorization header. Fail here, with the remedy.
    if (/^[\x20-\x7E]*$/.test(answer)) break;
    console.log(
      `  that value contains a non-ASCII character -- it came from a truncated\n` +
      `  console preview. Copy the raw string instead; in the DevTools console run:\n` +
      `      copy(JSON.parse(localStorage.getItem('autoll6.auth')).${field})\n` +
      `  which places the exact value on your clipboard, then paste it here.`
    );
  }
  rl.close();
  return answer;
}

async function freshPayload() {
  const res = await fetch('https://bg1.joelface.com/sensor/data', {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`sensor endpoint returned ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  // Same envelope the provider handles: IV ‖ AES-256-GCM ciphertext ‖ tag.
  const d = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from('hFK/SpnRKEoKKGjDahJBaP70niDSIMZTJM5+xeBtn60', 'base64'),
    raw.subarray(0, 12)
  );
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('latin1');
}

async function guests(payload, { swid, token }, date, facilityId, parkId) {
  const res = await fetch(GUESTS_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: {
      'Accept-Language': 'en-US',
      Authorization: `BEARER ${token}`,
      'Content-Type': 'application/json',
      'x-user-id': swid,
      'x-app-id': APP_ID,
      'x-acf-sensor-data': payload,
      // The probe runs in Node, the app in a phone browser; match the class of
      // client the payload claims to be so the control is not refused on UA.
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    },
    body: JSON.stringify({ date, facilityId: facilityId ?? null, parkId }),
  });
  return { status: res.status, ok: res.ok };
}

async function main() {
  if (!dry && !swid) swid = await prompt('SWID');
  if (!dry && !token) token = await prompt('accessToken');

  const date = arg('date', new Date().toISOString().slice(0, 10));
  const facilityId = arg('facility', '16767284');
  const parkId = arg('park', '80007944');
  log(`target: guests ${date} facility=${facilityId} park=${parkId}${dry ? ' (DRY RUN)' : ''}`);

  const results = existsSync(resultsFile)
    ? JSON.parse(readFileSync(resultsFile, 'utf8'))
    : { runs: [], tests: [] };

  // --- control ---
  log('\ncontrol: fetching fresh payload...');
  const control = dry ? 'DRY' : await freshPayload();
  if (!dry) {
    const c = await guests(control, { swid, token }, date, facilityId, parkId);
    log(`control (age 0): HTTP ${c.status} ${c.ok ? 'PASS' : 'REFUSED'}`);
    results.runs.push({ iso: new Date().toISOString(), kind: 'control', status: c.status });
    if (c.status === 401) {
      writeFileSync(resultsFile, JSON.stringify(results, null, 2));
      throw new Error('session rejected (401): the token is dead -- sign in again and retry');
    }
    if (!c.ok) {
      writeFileSync(resultsFile, JSON.stringify(results, null, 2));
      throw new Error(
        `fresh payload refused (HTTP ${c.status}): this is eligibility/config/session, not payload age. ` +
        'Check the date has park admission on this account, the facility id, and the token; do not record ladder results.'
      );
    }
  } else {
    log('control (age 0): skipped in dry run');
  }

  // --- ladder ---
  const pool = await loadPool();
  const tested = new Set(results.tests.map(t => `${t.ref}@${t.threshold}h`));
  const now = Date.now();
  let tested_count = 0;

  for (const threshold of THRESHOLDS_H) {
    if (tested_count >= maxTests) break;
    const candidates = pool
      .map(p => ({ ...p, ageH: (now - p.t) / 36e5 }))
      .filter(p => p.ageH >= threshold && !tested.has(`${p.ref}@${threshold}h`))
      .sort((a, b) => b.ageH - a.ageH);
    const pick = candidates[0];
    if (!pick) continue;
    log(`\nladder ${threshold}h: testing ${pick.ref} (age ${pick.ageH.toFixed(1)}h)...`);
    if (dry) {
      log('  dry run: would send guests with this payload');
    } else {
      const r = await guests(pick.payload, { swid, token }, date, facilityId, parkId);
      const verdict = r.ok ? 'PASS' : r.status === 403 ? 'REFUSED' : `HTTP ${r.status}`;
      log(`  ${pick.ref} @ ${threshold}h: HTTP ${r.status} -> ${verdict}`);
      results.tests.push({
        iso: new Date().toISOString(),
        ref: pick.ref,
        capturedAt: new Date(pick.t).toISOString(),
        ageH: Number(pick.ageH.toFixed(2)),
        threshold,
        status: r.status,
        pass: r.ok,
      });
    }
    tested.add(`${pick.ref}@${threshold}h`);
    tested_count++;
    if (!dry) await sleep(pace);
  }

  // --- use-count sub-test: does payload #6+ of the same string still pass? ---
  if (useCountTest && !dry) {
    log('\nuse-count: sending the control payload 8 times, 15s apart...');
    const uses = [];
    for (let i = 1; i <= 8; i++) {
      const r = await guests(control, { swid, token }, date, facilityId, parkId);
      uses.push(r.status);
      log(`  use ${i}: HTTP ${r.status} ${r.ok ? 'PASS' : 'REFUSED'}`);
      if (r.status === 401) break;
      if (i < 8) await sleep(15000);
    }
    results.runs.push({ iso: new Date().toISOString(), kind: 'use-count', statuses: uses });
  }

  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  log(`\nresults written to ${resultsFile}`);
  const byT = {};
  for (const t of results.tests) {
    byT[t.threshold] = byT[t.threshold] || { pass: 0, fail: 0 };
    byT[t.threshold][t.pass ? 'pass' : 'fail']++;
  }
  log('ladder so far (threshold: pass/fail):');
  for (const t of Object.keys(byT).sort((a, b) => a - b)) {
    log(`  ${t}h: ${byT[t].pass}/${byT[t].pass + byT[t].fail}`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});

#!/usr/bin/env node
// Capture sensor payloads for the shelf-life experiment.
//
// Fetches payloads from the same endpoint AutoLL-6's provider uses and
// appends them, with capture timestamps, to a JSONL pool file. No Disney
// credentials are involved: this only talks to the payload service.
//
//   node fetch.mjs --out sensor-pool/pool.jsonl --count 5 [--gap 1500]
//
// Each line: {"iso","t","iv","bytes","payload"} where `payload` is the
// decrypted header value and `t` is the capture time (ms epoch). Age is
// measured from `t`.

import crypto from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

const ENDPOINT = 'https://bg1.joelface.com/sensor/data';
const KEY = Buffer.from('hFK/SpnRKEoKKGjDahJBaP70niDSIMZTJM5+xeBtn60', 'base64');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outFile = arg('out', 'sensor-pool/pool.jsonl');
const count = Number(arg('count', 5));
const gap = Number(arg('gap', 1500));

function decrypt(raw) {
  const iv = raw.subarray(0, 12);
  const ct = raw.subarray(12);
  const tag = ct.subarray(ct.length - 16);
  const body = ct.subarray(0, ct.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('latin1');
}

async function fetchOne() {
  const t = Date.now();
  const res = await fetch(ENDPOINT, { method: 'POST', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`sensor endpoint returned ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  return { t, iv: raw.subarray(0, 12).toString('hex'), payload: decrypt(raw) };
}

// Skip payloads already in the pool: identical decrypted bytes are the same
// specimen, and re-recording them would duplicate ladder cells.
let seen = new Set();
try {
  seen = new Set(
    readFileSync(outFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line).payload)
  );
} catch { /* first run */ }

let added = 0, skipped = 0;
for (let i = 0; i < count; i++) {
  if (i > 0) await new Promise(r => setTimeout(r, gap));
  const rec = await fetchOne();
  if (seen.has(rec.payload)) { skipped++; continue; }
  appendFileSync(
    outFile,
    JSON.stringify({ iso: new Date(rec.t).toISOString(), ...rec }) + '\n'
  );
  added++;
  console.log(`captured ${new Date(rec.t).toISOString()} payload ${rec.payload.length} chars`);
}
console.log(`done: ${added} captured, ${skipped} duplicates skipped, pool at ${outFile}`);

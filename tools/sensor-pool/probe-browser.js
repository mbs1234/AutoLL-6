/*!
 * Browser probe for the sensor payload shelf-life experiment.
 *
 * Paste this whole file into the DevTools console of a tab on
 * disneyworld.disney.go.com where AutoLL-6 has signed in. It runs in the same
 * environment production uses -- real browser TLS, the page's cookies, the
 * page's origin -- which is the point: the Node probe's control can be
 * refused on client fingerprint alone, and a result from this file is the
 * one that matches how the app actually behaves.
 *
 * Control first (a fresh payload must produce a business answer rather than
 * a gate refusal -- a 410 "too early" is a pass), then the age ladder, one
 * guests call per specimen, paced. The guests endpoint is read-only.
 * Nothing is recorded anywhere except this console and your clipboard.
 */
(async () => {
  // ---- configuration -------------------------------------------------
  const DATE = '2026-10-12';        // a date the party holds admission for
  const FACILITY_ID = '16767284';   // Seven Dwarfs Mine Train
  const PARK_ID = '80007944';       // Magic Kingdom
  const MAX_TESTS = 4;              // ladder cells per run
  const PACE_MS = 15000;            // between guests calls
  const USE_COUNT_TEST = false;     // true: send one fresh payload 8 times
  const TEST_3A = true;             // true: also fire one locally-composed
                                    // legacy 3,a payload (the format this
                                    // family owns outright)
  const THRESHOLDS_H = [0.5, 1, 2, 4, 8, 24, 48, 96, 168, 336];
  // ---------------------------------------------------------------------

  const GUESTS_URL =
    'https://disneyworld.disney.go.com/ea-vas/planning/api/v1/experiences/guest/guests';
  const SENSOR_URL = 'https://bg1.joelface.com/sensor/data';
  const SENSOR_KEY = 'hFK/SpnRKEoKKGjDahJBaP70niDSIMZTJM5+xeBtn60';
  const POOL_URL =
    'https://raw.githubusercontent.com/mbs1234/AutoLL-6/sensor-pool/sensor-pool/pool.jsonl';

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = s => console.log('%c' + s, 'font-weight:bold');

  const auth = JSON.parse(localStorage.getItem('autoll6.auth') ?? 'null');
  if (!auth?.swid || !auth?.accessToken) {
    console.error('No autoll6.auth in localStorage: sign in through AutoLL-6 on this page first.');
    return;
  }
  if (auth.expires && auth.expires < Date.now()) {
    console.error('The saved session expired at', new Date(auth.expires).toISOString(), '-- sign in again.');
    return;
  }

  async function freshPayload() {
    const res = await fetch(SENSOR_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      referrer: '', // the provider blanks this too
    });
    if (!res.ok) throw new Error('sensor endpoint returned ' + res.status);
    const raw = new Uint8Array(await res.arrayBuffer());
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(atob(SENSOR_KEY), c => c.charCodeAt(0)),
      'AES-GCM', false, ['decrypt']
    );
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    return new TextDecoder().decode(pt);
  }

  // Byte-for-byte the app's transport: no referrer, no cookies (credentials
  // omitted -- the family tested cookies and reverted them), no cache. A
  // refusal body is Disney speaking and gets printed, not swallowed.
  async function guests(payload) {
    const res = await fetch(GUESTS_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      referrer: '',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        'Accept-Language': 'en-US',
        Authorization: 'BEARER ' + auth.accessToken,
        'Content-Type': 'application/json',
        'x-user-id': auth.swid,
        'x-app-id': 'WDW-IOS-8.23.3',
        'x-acf-sensor-data': payload,
      },
      body: JSON.stringify({ date: DATE, facilityId: FACILITY_ID, parkId: PARK_ID }),
    });
    const ok = res.ok;
    let detail = '';
    if (!ok) {
      try { detail = (await res.text()).slice(0, 300); } catch {}
    }
    return { status: res.status, ok, detail };
  }

  log('loading pool from the sensor-pool branch...');
  const poolRes = await fetch(POOL_URL, { signal: AbortSignal.timeout(15000) });
  if (!poolRes.ok) throw new Error('pool fetch returned ' + poolRes.status);
  const poolBranch = (await poolRes.text()).split('\n').filter(Boolean).map(line => {
    const rec = JSON.parse(line);
    return { ...rec, ageH: (Date.now() - rec.t) / 36e5 };
  });

  // ---- control ----
  log('control: fetching fresh payload...');
  const control = await freshPayload();
  const c = await guests(control);
  if (c.detail) console.log('control body: ' + c.detail);
  // The gate and the business logic are layered: a bad sensor is refused 403
  // at the edge; a good sensor reaches business logic, whose answer (200,
  // 410 "too early", 400, ...) depends on windows and entitlements. So the
  // control does not need a booking window -- it needs the fresh payload to
  // produce ANY business answer rather than a gate refusal.
  if (c.status === 401) {
    log('control (age 0): HTTP 401 -- session dead. Sign in again through AutoLL-6.');
    return;
  }
  if (c.status === 403) {
    log('control (age 0): HTTP 403 REFUSED AT THE GATE.');
    console.error('A fresh payload was refused at the gate. That is new information about the' +
      ' gate itself (or this probe differs from the app in a way that matters) -- no ladder results recorded.');
    return;
  }
  log('control (age 0): HTTP ' + c.status + ' GATE PASS (business answer)');

  const results = [{ ref: 'control', ageH: 0, status: c.status, pass: true, gatePass: true }];
  window.__sensorResults = results; // inspectable anytime: window.__sensorResults

  // ---- stock the local pool: every run captures specimens it can age ----
  // These live in this page's localStorage, tagged 'local' (as opposed to
  // the Actions-captured ones on the sensor-pool branch). Identity checks
  // showed payloads are not client-bound, so a locally captured specimen is
  // representative -- and a fresh local one is what the low-threshold cells
  // need, because every branch specimen is already hours old. Available
  // anytime as: await __sensorCapture(2)
  const CAPTURES_KEY = 'autoll6.sensorCaptures';
  window.__sensorCapture = async (n = 2) => {
    const stored = JSON.parse(localStorage.getItem(CAPTURES_KEY) ?? '[]');
    const seen = new Set(stored.map(s => s.payload));
    let added = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) await sleep(1200);
      const payload = await freshPayload();
      if (seen.has(payload)) continue;
      stored.push({ t: Date.now(), payload });
      added++;
    }
    localStorage.setItem(CAPTURES_KEY, JSON.stringify(stored));
    console.log('captured ' + added + ' payloads; local pool: ' + stored.length);
    return stored.length;
  };
  await window.__sensorCapture(2);

  // ---- legacy 3,a: the composer this family owns outright ----
  // The dead format was a static device blob plus a literal random tail,
  // composed client-side -- no service, no expiry by construction. If Disney
  // still accepts it, sensor independence is already owned. The blob is the
  // one committed at docs/sensor-format/old-3a-static.txt; the tail mimics
  // the 1.5-3 KB of base64 randomness the old endpoint used to supply.
  if (TEST_3A) {
    // The full 349-char static prefix: version, platform, and TWO 172-char
    // device sections. The first retest composed only the first section --
    // a truncated device blob -- and its 403 said nothing about the format.
    // Full prefix is committed at docs/sensor-format/old-3a-prefix.txt.
    const LEGACY_PREFIX = '3,a,DG0oDh1QTz8ZsxkaARUg25tPZ6gOmXo+eZI1DD+MzwfWrCbxfeN+9CIj968tE97Z+Om4skjwd+9EBSTVoIRkqq55rsJQ4EluLRFkdJfCl16POdor+n+Q+93MmZgo8wr5SF7ui5sSkfAjDXx7r3saWsrtsjIrpHN8MrCUbD54Zkw=,oMEAZLj+cH+cmsrB8LIzz67nundr+PqAfjuLrbftCMiZe28Twn5ozrdusiri1j6r1suj1GK8jkPeIk4txUmPiN+/P+aMf56E9Auw4lTb/1G2j5/BuC6lEblNepgzzbYwyMbchk7HIdZ9Skaa3cgrUmI4vmbzw/r0dhuLjlhrC64=';
    const tailBytes = crypto.getRandomValues(new Uint8Array(2048));
    const tail = btoa(String.fromCharCode(...tailBytes));
    const legacy = LEGACY_PREFIX + '$' + tail + '$,,';
    await sleep(PACE_MS);
    log('legacy 3,a (locally composed, FULL prefix): testing...');
    const l = await guests(legacy);
    const alive = l.status !== 403 && l.status !== 401;
    log('  legacy 3,a: HTTP ' + l.status + (alive ? ' GATE PASS -- THE OWNED COMPOSER IS ALIVE' :
      l.status === 403 ? ' GATE FAIL -- format is dead (or the tail is service-issued)' : ''));
    if (l.detail) console.log('  body: ' + l.detail);
    results.push({ ref: 'legacy-3a', kind: 'legacy', ageH: 0, status: l.status, gatePass: alive });
  }

  // ---- ladder ----
  // Pool = branch specimens (Actions-captured) + local captures. Each test
  // goes to a specimen's FIRST use, and among candidates prefers the one
  // whose age sits CLOSEST ABOVE the threshold -- a run soon after a capture
  // therefore tests the interior of the cliff (is a 30-60 min-old payload
  // still accepted?), which is exactly what a prefetch burst needs to know.
  let done = 0;
  const localCaptures = JSON.parse(localStorage.getItem('autoll6.sensorCaptures') ?? '[]');
  const pool = [
    ...poolBranch.map(p => ({ ...p, origin: 'actions' })),
    ...localCaptures.map(p => ({ ...p, origin: 'local' })),
  ].map((p, i) => ({ ...p, ref: (p.origin === 'local' ? 'local' : 'branch') + i }));
  console.log('pool: ' + pool.length + ' payloads (' +
    localCaptures.length + ' local, ' + poolBranch.length + ' branch), ages ' +
    Math.min(...pool.map(p => p.ageH)).toFixed(1) + 'h..' + Math.max(...pool.map(p => p.ageH)).toFixed(1) + 'h');
  for (const threshold of THRESHOLDS_H) {
    if (done >= MAX_TESTS) break;
    // Spend each test on a specimen's FIRST use: a reused specimen confounds
    // age with use-count, and reuse-burn is exactly what the five-use
    // rotation hypothesis says to avoid.
    const pick = pool
      .filter(p => p.ageH >= threshold && !results.some(r => r.ref === p.ref))
      .sort((a, b) => (a.ageH - threshold) - (b.ageH - threshold) || b.ageH - a.ageH)[0];
    if (!pick) continue;
    await sleep(PACE_MS);
    log('ladder ' + threshold + 'h: testing ' + pick.ref + ' (' + pick.origin + ', age ' + pick.ageH.toFixed(1) + 'h)...');
    const r = await guests(pick.payload);
    if (r.status === 401) {
      log('  HTTP 401 -- session dead mid-ladder. Sign in again; nothing further recorded this run.');
      break;
    }
    const gateFail = r.status === 403;
    log('  ' + pick.ref + ' @ ' + threshold + 'h: HTTP ' + r.status +
      (gateFail ? ' GATE FAIL' : ' GATE PASS (business answer)'));
    if (r.detail) console.log('  body: ' + r.detail);
    results.push({ ref: pick.ref, capturedAt: new Date(pick.t).toISOString(), ageH: +pick.ageH.toFixed(2), threshold, status: r.status, gatePass: !gateFail });
    done++;
  }

  // ---- use-count sub-test ----
  if (USE_COUNT_TEST) {
    const uses = [];
    for (let i = 1; i <= 8; i++) {
      await sleep(i > 1 ? 15000 : 0);
      const r = await guests(control);
      uses.push(r.status);
      log('use-count use ' + i + ': HTTP ' + r.status + (r.ok ? ' PASS' : ' REFUSED'));
      if (r.status === 401) break;
    }
    results.push({ ref: 'control', kind: 'use-count', statuses: uses });
  }

  console.table(results.map(r => ({
    ref: r.ref, kind: r.kind ?? 'age', ageH: r.ageH ?? '-', threshold: r.threshold ?? '-', status: r.status ?? (r.statuses || []).join(','), gatePass: r.gatePass ?? '-',
  })));
  try { copy(JSON.stringify(results, null, 2)); console.log('Full results JSON copied to clipboard -- paste it back to the operator.'); } catch {}
})();

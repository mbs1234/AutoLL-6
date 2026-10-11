# Sensor payload shelf-life experiment

One question decides how independent this build's sensor path can become:

> **How old may a `5,i` payload be before Disney's edge refuses it?**

If payloads survive days, a pre-fetched pool breaks the live dependency on
`bg1.joelface.com` at booking time. If they die in minutes, pooling is dead
and the answer is a proxy. See `docs/SENSOR-FORMAT.md` for what the payload
is; this experiment measures only how long it stays accepted.

## Design

Two moving parts:

- **Capture** (`fetch.mjs`, automated daily by
  `.github/workflows/sensor-pool.yml`): fetch a few payloads and append them,
  with capture timestamps, to `sensor-pool/pool.jsonl` on the `sensor-pool`
  branch. No Disney credentials involved. Every day that passes ages the
  pool for free — captures made while nobody is watching are exactly the
  24 h/48 h/7 d specimens the ladder needs later.
- **Probe** (`probe.mjs`, run by hand): presents payloads to the sensor-gated
  **guests** endpoint — `POST …/experiences/guest/guests` — which is
  read-only (party eligibility) and refuses a bad sensor with `403`.

Every run is **control-first**: a fresh payload (age ≈ 0) must pass before
any aged payload is tested. The control exists because `403` on guests has
three possible causes — expired sensor, no park admission for the date, or a
dead session — and only the first is what this experiment measures:

| Control result | Meaning | Action |
| --- | --- | --- |
| `200` | setup is good; ages are trustworthy | proceed to ladder |
| `403` | eligibility/config, not age | fix date/facility; **nothing recorded** |
| `401` | session dead | sign in again; nothing recorded |

The ladder tests thresholds `[0.5h, 1h, 2h, 4h, 8h, 24h, 48h, 96h, 7d, 14d]`,
the oldest untested cell first, at most `--max-tests` per run, paced ≥20 s
apart. An optional `--use-count-test` sends one fresh payload 8 times to
check the five-use rotation assumption and whether Disney flags an identical
header value.

## Reading the result

Let `cliff` = the greatest age with a passing test.

| Cliff | Pooling verdict |
| --- | --- |
| ≥ 24 h | **Weekly pool wins.** A daily capture job and a pool of ~50 payloads make booking fully independent of the service's uptime. |
| 8–24 h | **Morning-of pool.** Refresh at the hotel each morning; drop time never touches the service. |
| 1–8 h | Pooling marginal; a caching proxy (R track) carries the weight. |
| < 1 h | **Pooling dead.** Live fetch or proxy only; the dual-mechanism (`3,a`) fallback becomes the independence story. |

## Running it

**Preferred: the browser probe** (`probe-browser.js`). The Node probe below
works, but its control can be refused for reasons that have nothing to do
with payload age: Akamai fingerprints the client (TLS handshake, HTTP
detail), and a Node `fetch` looks nothing like the browser the payload
claims to come from. The browser probe runs inside a tab on Disney's origin
-- the exact environment production uses -- and needs no credential
handling at all: it reads the session the build already signed in with.

1. Open the logged-in **disneyworld.disney.go.com** tab, open DevTools
   (see below), and open the whole of `probe-browser.js` into the console.
2. Edit the `DATE` at the top to a date the party holds admission for.
3. Run it. Control first; the ladder follows automatically. When it
   finishes it prints a table and copies the results JSON to your
   clipboard -- paste that back to the operator.

**The Node probe** (`probe.mjs`) remains for scripting and dry runs.

Find credentials (this machine only, never send them anywhere): on a
**logged-in** disneyworld.disney.go.com page in a browser where AutoLL-6 has
signed in, in DevTools:

```js
JSON.parse(localStorage.getItem('autoll6.auth')).swid        // SWID
JSON.parse(localStorage.getItem('autoll6.auth')).accessToken // token
```

The account must hold **valid park admission for the `--date` given** — the
guests endpoint is an eligibility check, and an ineligible date 403s no
matter how fresh the sensor is. Default date is today; default attraction is
Seven Dwarfs Mine Train (`16767284`, Magic Kingdom `80007944`).

```sh
# nothing sent to Disney; walks what a run would do
node tools/sensor-pool/probe.mjs --dry-run

# a run: control, then up to 4 ladder cells (prompts for SWID/token)
node tools/sensor-pool/probe.mjs

# once per run while the question is open: the use-count sub-test
node tools/sensor-pool/probe.mjs --use-count-test --max-tests 1
```

Results append to `sensor-pool-results.json`. Keep it out of commits if it
names dates you would rather not publish; the summary table at the end of
each run is safe to share.

## Fetch volume

Capture defaults are 5 payloads/day (cron) plus one fresh payload per probe
run — a fraction of what one autopilot park day consumes. If the service
ever rate-limits, this experiment is the first thing to throttle.

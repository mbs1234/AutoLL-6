# The `5,i` sensor payload format

Written 2026-10-10, from analysis of the payload served by
`POST https://bg1.joelface.com/sensor/data` — the endpoint
`src/api/sensor-data-provider.ts` decrypts for the `x-acf-sensor-data` header.
Samples and the fetch manifest this document was derived from live in
`docs/sensor-format/`. The analysis method is reproducible from them alone.

## Transport envelope

The response body is `12-byte random IV ‖ AES-256-GCM ciphertext ‖ 16-byte
tag`, decryptable with the public key in `sensor-data-provider.ts`. The key
ships in the bundle, so the envelope buys integrity only: a truncated body or
captive portal fails to decrypt instead of poisoning the header. Plaintext
lengths observed: 6,126–7,673 chars.

## Structure

After decryption the payload is plain text. Two delimiters, at two levels:

```text
5,i,<SEC2>,<SEC3>,5,22$$$<SEC5>$0&&&<UUID>&&&0&&&4.2.0
  │ │   │      │    │ │
  │ │   │      │    │ └─ SEC5: ~299 bytes decoded, MOSTLY STATIC
  │ │   │      │    └─── literal "5" — second version marker
  │ │   │      └──────── SEC3: ~4,700–5,100 bytes decoded, PER-REQUEST
  │ │   └─────────────── SEC2: 128 bytes decoded, STATIC
  │ └─────────────────── platform: "i" (AutoLL-3's dead format used "a";
  │                       the app identities are WDW-IOS-* and ANDROID)
  └───────────────────── format version: "5" (the dead format was "3")
```

Comma-separators inside the first `$`-block; `$`-blocks after it. `$$` between
`22` and SEC5 is two empty blocks — present in all nine samples, so it is
shape, not accident. SEC3 is a concatenation of independently padded base64
records (mid-stream `=` — Node's base64 decoder stops at the first one, which
truncates naive decodes to 128 bytes; strip `=` and the full ~5 KB decodes).
URL-encoding (`%2f` for `/`) appears inside the base64 text and must be undone
before decoding.

## What varies and what does not

Nine samples (eight back-to-back, one 65.5 seconds later, same IP, one day):

| Component | Behaviour |
| --- | --- |
| `5,i` header | static |
| SEC2 (128 B) | static — byte-identical across all samples |
| SEC3 (~5 KB) | unique every request; length varies 4,673–5,090 B |
| `5` marker | static |
| `22$$$` | static |
| SEC5 (~299 B) | nearly static: only 2/299 bytes changed across 65.5 s; 4 unique values across 9 requests |
| UUID | `14E09596-659F-4161-9BEE-63B741070905` — one value across 25 requests from one IP across a day |
| `0&&&0&&&4.2.0` trailer | static (`4.2.0` is presumably the generator's version) |

SEC2 is exactly 128 bytes — the same length as the dead `3,a` format's static
device blob (`docs/sensor-format/old-3a-static.txt`), but different bytes: the
emulated device rotated with the format change. The stable UUID is most
plausibly a per-client device identity the service keys on (source IP is the
only handle it has); whether every AutoLL-4 user shares one UUID is untested
and would be worth knowing.

## The finding that decides the build strategy

**SEC3 decodes to ~5 KB at entropy 7.96 bits/byte** — statistically
indistinguishable from encrypted or compressed data. Concretely:

- no printable ASCII strings anywhere in it;
- no 32- or 48-bit fields anywhere in it holding epoch-plausible values
  (scanned big- and little-endian, ±24 h window);
- no field of any width advanced by ~65 s between the pair of samples taken
  65.5 s apart.

SEC5 behaves the same at smaller scale (7.16 bits/byte where decoded).

So the per-request core of the `5,i` payload is **not locally rewritable**.
There are no visible timestamps to refresh, and no plaintext structure to
model. Whatever validation Disney's edge performs on this blob, the bytes we
would need to synthesize or modify are behind a transform we do not have and
cannot see past without the generator. The old `3,a` format was different in
kind: its variable part was literal server-provided randomness appended to a
static blob in plain text, which is why a client-side composer could produce
it at all. The `5,i` format moved that composition behind the service, and
moved the service's output from "static blob + random tail" to "opaque,
per-request, self-contained sensor object".

## Consequence for "own the generator"

Reverse-engineering the format to the point of generating payloads locally
would mean reconstructing an encrypted protocol from ciphertext alone, with no
plaintext oracle, no source, and an observed format rotation (3 → 5) inside a
year. That is not a maintenance project; it is open-ended research with a
failure mode (Disney rotates the format again) that erases the work. **The
recommendation is therefore against option G as originally framed.**

What the evidence leaves open, in order of cost:

1. **Shelf-life empiricism.** Nothing here proves payloads expire — SEC3's
   variability could be per-request entropy rather than embedded time. The
   test is behavioural, not cryptographic: present a 24 h-old payload (and a
   week-old one) to the sensor-gated guests endpoint and observe 403 vs 200.
   If old payloads pass, a pre-fetched pool becomes real independence; the
   pool size and refresh cadence fall out of the same experiment.
2. **A self-hosted caching proxy** (Cloudflare Worker) in front of the
   service, for outage tolerance — cheap, independent of the answer to (1).
3. **The dual-mechanism fallback**: keep the `3,a` composer (client-side,
   owned, already in AutoLL-3's history) as a manual fallback path. Its clock
   is limited — the format is abandoned upstream — but it is the only
   sensor path this family owns outright.

## Shelf-life findings (2026-10-11)

The browser probe (`tools/sensor-pool/probe-browser.js`) measured the
question this document left open:

- **A fresh payload passes the gate** from a real browser session
  (`410`, a business answer -- the booking window for the test date was
  closed, which is fine: business answers are gate passes).
- **Payloads die young.** Three distinct never-reused specimens at
  2.3-3.4 h of age all drew `403` (Akamai "Access Denied"), while age-0
  controls passed throughout. The cliff is somewhere in (0, 2.5 h].
- **The `3,a` tail is service-issued -- proven by controlled experiment.**
  A 2x2 under identical conditions (owned 349-char prefix, same endpoint,
  same session): desktop UA + live tail = `403`; desktop UA + local random
  tail = `403`; **iPhone UA + live tail = `410` gate pass**; iPhone UA +
  local random tail = `403`. Two independent requirements confirmed: the
  client must present a mobile identity (AutoLL-3 has never worked from a
  desktop browser -- SYNC.md -- and now the mechanism is visible), and the
  tail must be issued by the service; locally generated randomness fails
  even in an otherwise-valid mobile context. The tail is an encrypted or
  otherwise keyed token, not randomness the endpoint's name suggests.
- **Payloads are not client-bound.** Captures from different IPs
  (residential and GitHub Actions) carry the identical UUID and static
  device blob; the service emits one global emulated device.

Consequences: pooling is dead as an independence strategy (no payload
survives from a morning capture to an afternoon drop), and both live
mechanisms require a live component from the service -- issued payloads
for `5,i`, an issued tail for `3,a`. The `5,i` payload must be fetched
at or near booking time, which makes the service a hard dependency.
The available work is around it: a prefetch burst just before a booking
window (a 0.65h-old payload passed on 2026-10-11, so minutes-to-an-hour
staleness is safe), a service-alive canary in the daily capture, a
failover proxy for brief outages, and the browser probe as a pre-trip
gate check. Fully owning either mechanism would require reproducing a
service-issued, opaque token format -- research work with a guaranteed
expiry, since Disney rotates the formats.

The remaining open measurement is **tail shelf life**: if issued tails
outlive payloads, a stockpile of real tails plus the owned 349-char
prefix composes offline, and AutoLL-3's format regains practical
independence (inventory top-ups instead of live dependency). The
browser probe's tail ladder (`TAIL_LADDER`) measures this as captured
tails age.

## Reproducing this analysis

Decrypt with the provider's key (AES-256-GCM, IV = first 12 bytes, tag =
last 16), then: split on `$`, URL-decode each block, split the first block on
`,`, and base64-decode each section with `=` stripped rather than honoured.
Scans for structure: per-position variance across samples, entropy per
section, printable-string extraction, u32/u48 epoch-window and
time-advance searches over every byte offset, both endiannesses. Samples:
`docs/sensor-format/p00.txt` and `p-late.txt` (65.5 s apart) with
`manifest.json` (fetch times, IVs); `old-3a-static.txt` is the dead format's
static 128-byte device blob for comparison.

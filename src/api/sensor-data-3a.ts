/**
 * The 3,a sensor pool provider.
 *
 * Replaces the joelface bg1 fetcher with a local pool of 10,000 pre-generated
 * 3,a sensors (xvertile akamai-bmp-generator, pool A v3.3.4, synthetic
 * Samsung device fingerprints). Each sensor is stateless — no session, no
 * signal, no expiry. The pool is loaded lazily on first use and sensors are
 * served in random order to avoid fingerprint clustering.
 *
 * The pool file (`/3a-pool.json`) is a JSON array of 10,000 sensor strings.
 * It is 24 MB and is fetched once, then cached in memory for the lifetime of
 * the page. No refresh is needed — 3,a sensors do not expire.
 */

const POOL_URL = `${import.meta.env.BASE_URL}3a-pool.json`;

interface SensorDataModule {
  getSensorData(): Promise<string> | string;
  resetSensorData(): void;
}

let mod: SensorDataModule | undefined;
let loadPromise: Promise<void> | undefined;

/** The remaining indices, shuffled. Refilled when exhausted. */
let deck: number[] = [];
let pool: string[] = [];

function shuffle(n: number): number[] {
  const indices = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

async function ensureLoaded(): Promise<void> {
  if (mod) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const response = await fetch(POOL_URL);
    if (!response.ok) {
      throw new Error(`3,a pool fetch failed: ${response.status}`);
    }
    pool = (await response.json()) as string[];
    deck = shuffle(pool.length);
    mod = {
      getSensorData: () => {
        if (deck.length === 0) deck = shuffle(pool.length);
        return pool[deck.pop()!];
      },
      resetSensorData: () => {
        deck = shuffle(pool.length);
      },
    };
  })();

  return loadPromise;
}

export function getSensorData(): Promise<string> | string {
  const pending = ensureLoaded();
  if (pending) return pending.then(() => mod!.getSensorData());
  return mod!.getSensorData();
}

export function resetSensorData(): void {
  if (pool.length) deck = shuffle(pool.length);
}

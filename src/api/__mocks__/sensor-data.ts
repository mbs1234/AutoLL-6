/**
 * The Jest mock for the sensor data module.
 *
 * The production module (`sensor-data-3a.ts`) serves pre-generated `3,a`
 * sensors from an inline pool. Tests don't need real sensors — they need a
 * deterministic string and a no-op reset, so every suite that transitively
 * imports `@/api/sensor-data` resolves without touching the 2 MB pool.
 */
export function getSensorData(): string {
  return '3,a,mock-sensor-for-tests';
}

export function resetSensorData(): void {
  /* no-op */
}

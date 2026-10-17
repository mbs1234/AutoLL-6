/**
 * The sensor data entry point.
 *
 * AutoLL-6 uses the 3,a sensor pool (stateless synthetic-fingerprint sensors
 * from the xvertile generator) instead of the bg1/5,i joelface fetcher.
 * Everything else in the engine is unchanged.
 */
export { getSensorData, resetSensorData } from './sensor-data-3a';

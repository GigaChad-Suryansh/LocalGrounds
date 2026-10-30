/** A raw location sample as reported by a player's device. */
export interface LocationSample {
  lat: number;
  lng: number;
  /** Horizontal accuracy radius in metres (68% confidence, as reported by the Geolocation API). */
  accuracyM: number;
  /** Time the device took the sample, epoch ms. */
  timestampMs: number;
}

/**
 * What a client is allowed to send. There is deliberately no timestamp: the
 * server derives the sample time from its own clock minus the reported age
 * (age is measured on the device with a single clock, so skew can't matter).
 */
export interface LocationReport {
  lat: number;
  lng: number;
  accuracyM: number;
  /** How old the position was when the device sent it, ms. Defaults to 0. */
  ageMs?: number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Circle {
  center: LatLng;
  radiusM: number;
}

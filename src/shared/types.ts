/** A raw location sample as reported by a player's device. */
export interface LocationSample {
  lat: number;
  lng: number;
  /** Horizontal accuracy radius in metres (68% confidence, as reported by the Geolocation API). */
  accuracyM: number;
  /** Time the device took the sample, epoch ms. */
  timestampMs: number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Circle {
  center: LatLng;
  radiusM: number;
}

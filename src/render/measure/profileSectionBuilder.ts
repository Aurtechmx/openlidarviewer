/**
 * profileSectionBuilder.ts
 *
 * Accumulate the returns accepted by a profile corridor into compact typed
 * arrays, keeping each return's identity and only the attributes its own
 * source actually carries.
 *
 * The derived series reduces a corridor to one height per station. The
 * section keeps the returns themselves, so every accepted point has to stay
 * traceable to the source and index it came from, and an attribute that a
 * source does not carry has to stay absent rather than becoming zero. A
 * fabricated zero intensity is indistinguishable from a measured one.
 *
 * Presence is recorded per point, not per snapshot. A section can mix a
 * source that carries RGB with one that does not, so `channelPresence`
 * carries one bit per attribute per point and a consumer reads a channel
 * only where its bit is set.
 *
 * Storage grows by doubling and is copied out at `finish()`, so the
 * finished arrays are sized to the accepted count rather than to the
 * scanned count.
 */

/** The per-point attributes a section can carry through from a source. */
export type ProfileAttribute =
  | 'rgb'
  | 'intensity'
  | 'classification'
  | 'returnNumber'
  | 'returnCount'
  | 'pointSourceId'
  | 'gpsTime'
  | 'normals';

/** Bit position of each attribute inside `channelPresence`. */
export const PROFILE_ATTRIBUTE_BIT: Readonly<Record<ProfileAttribute, number>> = {
  rgb: 1 << 0,
  intensity: 1 << 1,
  classification: 1 << 2,
  returnNumber: 1 << 3,
  returnCount: 1 << 4,
  pointSourceId: 1 << 5,
  gpsTime: 1 << 6,
  normals: 1 << 7,
};

export const PROFILE_ATTRIBUTES: readonly ProfileAttribute[] = [
  'rgb',
  'intensity',
  'classification',
  'returnNumber',
  'returnCount',
  'pointSourceId',
  'gpsTime',
  'normals',
];

/**
 * The channels one source carries, aligned to that source's point index.
 *
 * A channel is absent when the source does not carry it. A channel whose
 * length disagrees with the source's point count is treated as absent, the
 * same rule `sampleProfile` applies to a misaligned classification array.
 */
export interface ProfileSourceChannels {
  readonly rgb?: Uint8Array;
  readonly intensity?: Uint16Array;
  readonly classification?: Uint8Array;
  readonly returnNumber?: Uint8Array;
  readonly returnCount?: Uint8Array;
  readonly pointSourceId?: Uint16Array;
  readonly gpsTime?: Float64Array;
  readonly normals?: Float32Array;
}

/** Accepted returns, as struct-of-arrays. All arrays share one index space. */
export interface ProfileSectionPoints {
  readonly count: number;
  readonly chainage: Float32Array;
  readonly height: Float32Array;
  readonly lateralOffset: Float32Array;
  readonly sourceSlot: Uint16Array;
  readonly pointIndex: Uint32Array;
  /** One bit per {@link ProfileAttribute}; see {@link PROFILE_ATTRIBUTE_BIT}. */
  readonly channelPresence: Uint8Array;
  readonly rgb?: Uint8Array;
  readonly intensity?: Uint16Array;
  readonly classification?: Uint8Array;
  readonly returnNumber?: Uint8Array;
  readonly returnCount?: Uint8Array;
  readonly pointSourceId?: Uint16Array;
  readonly gpsTime?: Float64Array;
  readonly normals?: Float32Array;
}

const INITIAL_CAPACITY = 1024;

function grow<T extends { length: number }>(
  arr: T,
  capacity: number,
  make: (n: number) => T,
  stride: number,
): T {
  const next = make(capacity * stride);
  (next as unknown as { set(a: T): void }).set(arr);
  return next;
}

/**
 * Collect accepted returns from one or more sources.
 *
 * Call {@link beginSource} before the points of each source, then
 * {@link push} per accepted return, then {@link finish} once.
 */
export class ProfileSectionBuilder {
  private _count = 0;
  private _capacity = INITIAL_CAPACITY;

  private _chainage = new Float32Array(INITIAL_CAPACITY);
  private _height = new Float32Array(INITIAL_CAPACITY);
  private _lateral = new Float32Array(INITIAL_CAPACITY);
  private _slot = new Uint16Array(INITIAL_CAPACITY);
  private _index = new Uint32Array(INITIAL_CAPACITY);
  private _presence = new Uint8Array(INITIAL_CAPACITY);

  private _rgb = new Uint8Array(INITIAL_CAPACITY * 3);
  private _intensity = new Uint16Array(INITIAL_CAPACITY);
  private _classification = new Uint8Array(INITIAL_CAPACITY);
  private _returnNumber = new Uint8Array(INITIAL_CAPACITY);
  private _returnCount = new Uint8Array(INITIAL_CAPACITY);
  private _pointSourceId = new Uint16Array(INITIAL_CAPACITY);
  private _gpsTime = new Float64Array(INITIAL_CAPACITY);
  private _normals = new Float32Array(INITIAL_CAPACITY * 3);

  /** Attributes seen on at least one source, so only those are emitted. */
  private _seen = 0;

  private _srcSlot = 0;
  private _srcChannels: ProfileSourceChannels | null = null;
  private _srcMask = 0;

  /**
   * Bind the source whose returns follow.
   *
   * `pointCount` is the source's own point count. A channel whose length
   * disagrees with it is dropped for that source, which keeps a misaligned
   * array from shifting every attribute by one index.
   */
  beginSource(slot: number, channels: ProfileSourceChannels | null, pointCount: number): void {
    this._srcSlot = slot;
    this._srcChannels = channels;
    let mask = 0;
    if (channels) {
      if (channels.rgb?.length === pointCount * 3) mask |= PROFILE_ATTRIBUTE_BIT.rgb;
      if (channels.intensity?.length === pointCount) mask |= PROFILE_ATTRIBUTE_BIT.intensity;
      if (channels.classification?.length === pointCount)
        mask |= PROFILE_ATTRIBUTE_BIT.classification;
      if (channels.returnNumber?.length === pointCount)
        mask |= PROFILE_ATTRIBUTE_BIT.returnNumber;
      if (channels.returnCount?.length === pointCount) mask |= PROFILE_ATTRIBUTE_BIT.returnCount;
      if (channels.pointSourceId?.length === pointCount)
        mask |= PROFILE_ATTRIBUTE_BIT.pointSourceId;
      if (channels.gpsTime?.length === pointCount) mask |= PROFILE_ATTRIBUTE_BIT.gpsTime;
      if (channels.normals?.length === pointCount * 3) mask |= PROFILE_ATTRIBUTE_BIT.normals;
    }
    this._srcMask = mask;
    this._seen |= mask;
  }

  /** Number of returns accepted so far. */
  get count(): number {
    return this._count;
  }

  private _reserve(): void {
    if (this._count < this._capacity) return;
    const next = this._capacity * 2;
    this._chainage = grow(this._chainage, next, (n) => new Float32Array(n), 1);
    this._height = grow(this._height, next, (n) => new Float32Array(n), 1);
    this._lateral = grow(this._lateral, next, (n) => new Float32Array(n), 1);
    this._slot = grow(this._slot, next, (n) => new Uint16Array(n), 1);
    this._index = grow(this._index, next, (n) => new Uint32Array(n), 1);
    this._presence = grow(this._presence, next, (n) => new Uint8Array(n), 1);
    this._rgb = grow(this._rgb, next, (n) => new Uint8Array(n), 3);
    this._intensity = grow(this._intensity, next, (n) => new Uint16Array(n), 1);
    this._classification = grow(this._classification, next, (n) => new Uint8Array(n), 1);
    this._returnNumber = grow(this._returnNumber, next, (n) => new Uint8Array(n), 1);
    this._returnCount = grow(this._returnCount, next, (n) => new Uint8Array(n), 1);
    this._pointSourceId = grow(this._pointSourceId, next, (n) => new Uint16Array(n), 1);
    this._gpsTime = grow(this._gpsTime, next, (n) => new Float64Array(n), 1);
    this._normals = grow(this._normals, next, (n) => new Float32Array(n), 3);
    this._capacity = next;
  }

  /**
   * Append one accepted return.
   *
   * `sourceIndex` is the point's index in the bound source, and it is what
   * every channel is read at, so an attribute can never be read from a
   * different point than the one being appended.
   */
  push(sourceIndex: number, chainage: number, height: number, lateralOffset: number): void {
    this._reserve();
    const i = this._count;
    this._chainage[i] = chainage;
    this._height[i] = height;
    this._lateral[i] = lateralOffset;
    this._slot[i] = this._srcSlot;
    this._index[i] = sourceIndex;
    this._presence[i] = this._srcMask;

    const c = this._srcChannels;
    if (c) {
      const m = this._srcMask;
      if (m & PROFILE_ATTRIBUTE_BIT.rgb) {
        this._rgb[i * 3] = c.rgb![sourceIndex * 3];
        this._rgb[i * 3 + 1] = c.rgb![sourceIndex * 3 + 1];
        this._rgb[i * 3 + 2] = c.rgb![sourceIndex * 3 + 2];
      }
      if (m & PROFILE_ATTRIBUTE_BIT.intensity) this._intensity[i] = c.intensity![sourceIndex];
      if (m & PROFILE_ATTRIBUTE_BIT.classification)
        this._classification[i] = c.classification![sourceIndex];
      if (m & PROFILE_ATTRIBUTE_BIT.returnNumber)
        this._returnNumber[i] = c.returnNumber![sourceIndex];
      if (m & PROFILE_ATTRIBUTE_BIT.returnCount)
        this._returnCount[i] = c.returnCount![sourceIndex];
      if (m & PROFILE_ATTRIBUTE_BIT.pointSourceId)
        this._pointSourceId[i] = c.pointSourceId![sourceIndex];
      if (m & PROFILE_ATTRIBUTE_BIT.gpsTime) this._gpsTime[i] = c.gpsTime![sourceIndex];
      if (m & PROFILE_ATTRIBUTE_BIT.normals) {
        this._normals[i * 3] = c.normals![sourceIndex * 3];
        this._normals[i * 3 + 1] = c.normals![sourceIndex * 3 + 1];
        this._normals[i * 3 + 2] = c.normals![sourceIndex * 3 + 2];
      }
    }
    this._count++;
  }

  /**
   * Copy out arrays sized to the accepted count.
   *
   * A channel is emitted only when some source carried it. A channel no
   * source carried is absent from the result rather than present and zero.
   */
  finish(): ProfileSectionPoints {
    const n = this._count;
    const seen = this._seen;
    const has = (a: ProfileAttribute): boolean => (seen & PROFILE_ATTRIBUTE_BIT[a]) !== 0;
    return {
      count: n,
      chainage: this._chainage.slice(0, n),
      height: this._height.slice(0, n),
      lateralOffset: this._lateral.slice(0, n),
      sourceSlot: this._slot.slice(0, n),
      pointIndex: this._index.slice(0, n),
      channelPresence: this._presence.slice(0, n),
      ...(has('rgb') ? { rgb: this._rgb.slice(0, n * 3) } : {}),
      ...(has('intensity') ? { intensity: this._intensity.slice(0, n) } : {}),
      ...(has('classification') ? { classification: this._classification.slice(0, n) } : {}),
      ...(has('returnNumber') ? { returnNumber: this._returnNumber.slice(0, n) } : {}),
      ...(has('returnCount') ? { returnCount: this._returnCount.slice(0, n) } : {}),
      ...(has('pointSourceId') ? { pointSourceId: this._pointSourceId.slice(0, n) } : {}),
      ...(has('gpsTime') ? { gpsTime: this._gpsTime.slice(0, n) } : {}),
      ...(has('normals') ? { normals: this._normals.slice(0, n * 3) } : {}),
    };
  }
}

/** True when point `i` carries attribute `a`. */
export function profileSectionHas(
  points: ProfileSectionPoints,
  i: number,
  a: ProfileAttribute,
): boolean {
  return (points.channelPresence[i]! & PROFILE_ATTRIBUTE_BIT[a]) !== 0;
}

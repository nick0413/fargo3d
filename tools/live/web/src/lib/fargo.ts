// FARGO3D live frame decoding and painting. Frame layout is contract v1 (80-byte header,
// planet block, then float32 fields). Painters are imperative on purpose: the frame never
// enters React state, it goes straight into a canvas context.

export type Planet = { x: number; y: number; m: number };

export type Frame = {
  flags: number; fid: number; dropped: number;
  nx: number; ny: number; nz: number; nfields: number;
  t: number; theta: number; omega: number; dt: number;
  planets: Planet[]; fields: Float32Array[]; payload: number;
};

export type Meta = {
  index_first: number | null; index_last: number | null;
  orbit_first: number | null; orbit_last: number | null;
  count: number; max_orbits: number; buffer_full: boolean;
  sim_stopped: boolean; sim_alive: boolean; producer: string; error?: string | null;
  recomputing?: boolean; rate?: number;
};

export type Range = { lo: number; hi: number; mode: 'log' | 'linear' };

export const RMIN = 0.4;
export const RMAX = 2.5;

export function parseFrame(buf: ArrayBuffer): Frame {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'FG3D') throw new Error('bad magic: ' + magic);
  const flags = dv.getUint16(6, true);
  const fid = dv.getUint32(8, true), dropped = dv.getUint32(12, true);
  const nx = dv.getUint32(16, true), ny = dv.getUint32(20, true), nz = dv.getUint32(24, true);
  const nfields = dv.getUint32(28, true);
  const t = dv.getFloat64(32, true), theta = dv.getFloat64(40, true);
  const omega = dv.getFloat64(48, true), dt = dv.getFloat64(56, true);
  const npl = dv.getUint32(64, true), payload = dv.getUint32(68, true);
  const planets: Planet[] = [];
  for (let p = 0; p < npl; p++) {
    const b = 80 + p * 56;
    planets.push({ x: dv.getFloat64(b, true), y: dv.getFloat64(b + 8, true), m: dv.getFloat64(b + 48, true) });
  }
  const off = 80 + npl * 56, ncell = nx * ny, fields: Float32Array[] = [];
  for (let f = 0; f < nfields; f++) fields.push(new Float32Array(buf, off + f * ncell * 4, ncell));
  return { flags, fid, dropped, nx, ny, nz, nfields, t, theta, omega, dt, planets, fields, payload };
}

const STOPS: number[][] = [
  [0, 3, 7], [22, 11, 57], [66, 10, 104], [106, 23, 110], [147, 38, 103],
  [188, 55, 84], [221, 81, 58], [243, 120, 25], [252, 165, 10], [252, 255, 164],
];

export function cmap(x: number): number[] {
  const t = Math.max(0, Math.min(0.9999, x)) * (STOPS.length - 1);
  const i = Math.floor(t), f = t - i, a = STOPS[i], b = STOPS[i + 1] || STOPS[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function percentileRange(values: Float32Array, tf: (v: number) => number) {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (!(v > 0)) continue;
    const l = tf(v);
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  if (!isFinite(lo) || hi <= lo) return { lo: 0, hi: 1 };
  const NB = 256, hist = new Uint32Array(NB), sc = (NB - 1) / (hi - lo);
  let n = 0;
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (!(v > 0)) continue;
    hist[Math.min(NB - 1, Math.floor((tf(v) - lo) * sc))]++;
    n++;
  }
  const pick = (q: number) => {
    let acc = 0, tgt = q * n;
    for (let b = 0; b < NB; b++) { acc += hist[b]; if (acc >= tgt) return lo + b / sc; }
    return hi;
  };
  // clip outer 0.1% so genuine peaks still reach the top of the ramp
  return { lo: pick(0.001), hi: pick(0.999) };
}

// ---- fast polar painter -------------------------------------------------------------------
// The polar lookup (hypot/atan2 per screen pixel) is precomputed once into a flat LUT and the
// colormap into a packed RGBA table. A paint then costs 4 gathers + a lerp per pixel, which is
// what makes 3-60 fps playback viable without a shader. The inertial view is that same painted
// image rotated by theta: a rotation about the centre maps (r, phi) -> (r, phi + theta) exactly.

type DiscLUT = {
  key: string;
  src: Int32Array;   // 4 source indices per sample: v00, v10, v01, v11
  wgt: Float32Array; // 2 weights per sample: fx, fy
  pix: Int32Array;   // byte offset into the ImageData buffer per sample
  n: number;
  img: ImageData;
};

let LUT: DiscLUT | null = null;
let CMBUF: Uint32Array | null = null;
let RANGE: { lo: number; hi: number } = { lo: 0, hi: 1 };
const OFF = document.createElement('canvas');

function colormapTable(): Uint32Array {
  if (CMBUF) return CMBUF;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = cmap(i / 255).map((v) => Math.round(v));
    t[i] = (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0];   // little-endian RGBA
  }
  CMBUF = t;
  return t;
}

function buildLUT(W: number, H: number, nx: number, ny: number): DiscLUT {
  const key = `${W}x${H}:${nx}x${ny}`;
  if (LUT && LUT.key === key) return LUT;
  const SCL = W / (2 * 2.62), CX = W / 2, CY = H / 2;
  const dphi = (2 * Math.PI) / nx, dr = (RMAX - RMIN) / ny;
  const cap = W * H;
  const src = new Int32Array(cap * 4);
  const wgt = new Float32Array(cap * 2);
  const pix = new Int32Array(cap);
  OFF.width = W; OFF.height = H;
  const img = OFF.getContext('2d')!.createImageData(W, H);
  let n = 0;
  for (let py = 0; py < H; py++) {
    const y = (CY - py - 0.5) / SCL;
    for (let pxi = 0; pxi < W; pxi++) {
      const x = (pxi - CX + 0.5) / SCL;
      const r = Math.hypot(x, y);
      if (r < RMIN || r > RMAX) continue;
      let phi = Math.atan2(y, x);
      phi = ((phi + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      const fi0 = (phi + Math.PI) / dphi - 0.5, fj0 = (r - RMIN) / dr - 0.5;
      const i0 = Math.floor(fi0), fx = fi0 - i0;
      let j0 = Math.floor(fj0); const fy = fj0 - j0;
      const ia = ((i0 % nx) + nx) % nx, ib = (ia + 1) % nx;
      j0 = Math.min(ny - 2, Math.max(0, j0));
      const jb = j0 + 1;
      const b0 = j0 * nx, b1 = jb * nx;
      src[n * 4] = b0 + ia; src[n * 4 + 1] = b0 + ib;
      src[n * 4 + 2] = b1 + ia; src[n * 4 + 3] = b1 + ib;
      wgt[n * 2] = fx; wgt[n * 2 + 1] = fy;
      pix[n] = (py * W + pxi) * 4;
      n++;
    }
  }
  LUT = { key, src, wgt, pix, n, img };
  return LUT;
}

export function paintDisc(
  ctx: CanvasRenderingContext2D, f: Frame,
  opts: { frame: 'rot' | 'inertial'; scale: 'log' | 'linear'; field: number; arrows: boolean; showGrid: boolean },
): Range {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const SCL = W / (2 * 2.62), CX = W / 2, CY = H / 2;
  const nx = f.nx, ny = f.ny;
  const data = f.fields[Math.min(opts.field, f.nfields - 1)];
  ctx.clearRect(0, 0, W, H);
  if (!data) return { lo: 0, hi: 1, mode: 'log' };

  const tf = opts.scale === 'log' ? (v: number) => Math.log10(v) : (v: number) => v;
  const lut = buildLUT(W, H, nx, ny);
  const cm = colormapTable();

  // percentile range over the actual samples
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < lut.n; k++) {
    const s = k * 4;
    const fx = lut.wgt[k * 2], fy = lut.wgt[k * 2 + 1];
    const v = (data[lut.src[s]] * (1 - fx) + data[lut.src[s + 1]] * fx) * (1 - fy)
            + (data[lut.src[s + 2]] * (1 - fx) + data[lut.src[s + 3]] * fx) * fy;
    if (!(v > 0)) continue;
    const l = tf(v);
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  if (!isFinite(lo) || hi <= lo) { lo = 0; hi = 1; }
  else {
    const NB = 256, hist = new Uint32Array(NB), sc = (NB - 1) / (hi - lo);
    for (let k = 0; k < lut.n; k++) {
      const s = k * 4;
      const fx = lut.wgt[k * 2], fy = lut.wgt[k * 2 + 1];
      const v = (data[lut.src[s]] * (1 - fx) + data[lut.src[s + 1]] * fx) * (1 - fy)
              + (data[lut.src[s + 2]] * (1 - fx) + data[lut.src[s + 3]] * fx) * fy;
      if (!(v > 0)) continue;
      hist[Math.min(NB - 1, Math.floor((tf(v) - lo) * sc))]++;
    }
    const pickQ = (q: number) => {
      let tot = 0;
      for (let b = 0; b < NB; b++) tot += hist[b];
      let acc = 0;
      const tgt = q * tot;
      for (let b = 0; b < NB; b++) { acc += hist[b]; if (acc >= tgt) return lo + b / sc; }
      return hi;
    };
    lo = pickQ(0.001); hi = pickQ(0.999);
  }
  const span = Math.max(1e-12, hi - lo);
  RANGE = { lo, hi };

  const px = new Uint32Array(lut.img.data.buffer);
  for (let k = 0; k < lut.n; k++) {
    const s = k * 4;
    const fx = lut.wgt[k * 2], fy = lut.wgt[k * 2 + 1];
    const v = (data[lut.src[s]] * (1 - fx) + data[lut.src[s + 1]] * fx) * (1 - fy)
            + (data[lut.src[s + 2]] * (1 - fx) + data[lut.src[s + 3]] * fx) * fy;
    let u = 0;
    if (v > 0) { u = (tf(v) - lo) / span; u = u < 0 ? 0 : u > 1 ? 1 : u; }
    px[lut.pix[k] >> 2] = cm[(u * 255) | 0];
  }
  const octx = OFF.getContext('2d')!;
  octx.putImageData(lut.img, 0, 0);

  // inertial view = rotate the rotating-frame image by theta about the centre
  if (opts.frame === 'inertial') {
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(-f.theta);
    ctx.translate(-CX, -CY);
    ctx.drawImage(OFF, 0, 0);
    ctx.restore();
  } else {
    ctx.drawImage(OFF, 0, 0);
  }

  const dth = opts.frame === 'inertial' ? f.theta : 0;
  const shift = ((dth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const dphi = (2 * Math.PI) / nx, dr = (RMAX - RMIN) / ny;

  if (opts.arrows && f.nfields >= 3) {
    const vx = f.fields[1], vy = f.fields[2], mean = new Float64Array(ny);
    for (let j = 0; j < ny; j++) {
      let s = 0;
      for (let i = 0; i < nx; i++) s += vx[j * nx + i];
      mean[j] = s / nx;
    }
    let vmax = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const m = Math.abs(vx[j * nx + i] - mean[j]);
      if (m > vmax) vmax = m;
    }
    vmax = Math.max(1e-12, vmax);
    ctx.strokeStyle = 'rgba(94,234,212,0.85)';
    ctx.lineWidth = 1;
    for (let j = 6; j < ny; j += 8) {
      const r = RMIN + (j + 0.5) * dr;
      for (let i = 0; i < nx; i += 12) {
        const phi = -Math.PI + (i + 0.5) * dphi + shift;
        const pr = vx[j * nx + i] - mean[j], pt = vy[j * nx + i];
        const scl = 34 / vmax;
        const x0 = CX + Math.cos(phi) * r * SCL, y0 = CY - Math.sin(phi) * r * SCL;
        const ux = Math.cos(phi) * pr - Math.sin(phi) * pt;
        const uy = Math.sin(phi) * pr + Math.cos(phi) * pt;
        let ax = ux * scl, ay = uy * scl;
        const alen = Math.hypot(ax, ay), cap = 16;
        if (alen > cap) { ax *= cap / alen; ay *= cap / alen; }
        const x1 = x0 + ax, y1 = y0 - ay;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        const nl = Math.hypot(ax, ay);
        if (nl > 3.5) {
          const ang = Math.atan2(-ay, ax), hl = Math.min(5, 1.4 + nl * 0.28), sp = 0.45;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - hl * Math.cos(ang - sp), y1 - hl * Math.sin(ang - sp));
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - hl * Math.cos(ang + sp), y1 - hl * Math.sin(ang + sp));
          ctx.stroke();
        }
      }
    }
  }

  for (const p of f.planets) {
    const c = Math.cos(dth), s = Math.sin(dth);
    const wx = c * p.x - s * p.y, wy = s * p.x + c * p.y;
    ctx.beginPath();
    ctx.arc(CX + wx * SCL, CY - wy * SCL, 5, 0, 2 * Math.PI);
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.strokeStyle = '#05070a';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  if (opts.showGrid) {
    ctx.strokeStyle = 'rgba(148,163,184,0.18)';
    ctx.lineWidth = 1;
    for (const rr of [0.5, 1.0, 1.5, 2.0, 2.5]) {
      ctx.beginPath();
      ctx.arc(CX, CY, rr * SCL, 0, 2 * Math.PI);
      ctx.stroke();
    }
  }

  return { lo, hi, mode: opts.scale };
}

export function paintCbar(ctx: CanvasRenderingContext2D, range: Range | null) {
  const w = ctx.canvas.width, h = ctx.canvas.height, y0 = 4, bh = 14;
  ctx.clearRect(0, 0, w, h);
  if (!range) return;
  const g = ctx.createLinearGradient(0, 0, w, 0);
  for (let i = 0; i <= 10; i++) {
    const k = cmap(i / 10).map((v) => Math.round(v));
    g.addColorStop(i / 10, `rgb(${k.join(',')})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, y0, w, bh);
  ctx.strokeStyle = 'rgba(148,163,184,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, y0 + 0.5, w - 1, bh - 1);
  const fmt = (x: number) => (range.mode === 'log' ? Math.pow(10, x).toExponential(2) : x.toPrecision(3));
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.textAlign = 'left';
  ctx.fillText('Σ ' + fmt(range.lo), 2, y0 + bh + 16);
  ctx.textAlign = 'center';
  ctx.fillText(range.mode === 'log' ? 'log scale' : 'linear scale', w / 2, y0 + bh + 16);
  ctx.textAlign = 'right';
  ctx.fillText(fmt(range.hi), w - 2, y0 + bh + 16);
  ctx.textAlign = 'left';
}

export function paintProfile(ctx: CanvasRenderingContext2D, f: Frame | null) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!f) return;
  const mL = 58, mR = 12, mT = 20, mB = 28;
  const iw = W - mL - mR, ih = H - mT - mB;
  const nx = f.nx, ny = f.ny, dens = f.fields[0];
  const prof = new Float64Array(ny);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < ny; j++) {
    let s = 0;
    for (let i = 0; i < nx; i++) s += dens[j * nx + i];
    prof[j] = s / nx;
    if (prof[j] > 0) {
      const l = Math.log10(prof[j]);
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
  }
  const sp = Math.max(1e-6, hi - lo);
  const xOf = (r: number) => mL + ((r - RMIN) / (RMAX - RMIN)) * iw;
  const yOf = (v: number) => mT + (1 - (Math.log10(Math.max(v, 1e-30)) - lo) / sp) * ih;

  ctx.strokeStyle = 'rgba(148,163,184,0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(mL, mT, iw, ih);

  ctx.strokeStyle = '#5eead4';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let j = 0; j < ny; j++) {
    const r = RMIN + ((j + 0.5) * (RMAX - RMIN)) / ny;
    const x = xOf(r), y = yOf(prof[j]);
    j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.strokeStyle = '#94a3b8';
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  for (const rr of [0.5, 1.0, 1.5, 2.0, 2.5]) {
    const x = xOf(rr);
    ctx.beginPath(); ctx.moveTo(x, mT + ih); ctx.lineTo(x, mT + ih + 4); ctx.stroke();
    ctx.fillText(rr.toFixed(1), x, mT + ih + 17);
  }
  ctx.textAlign = 'right';
  ctx.fillText(Math.pow(10, hi).toExponential(1), mL - 7, mT + 9);
  ctx.fillText(Math.pow(10, lo).toExponential(1), mL - 7, mT + ih);
  ctx.textAlign = 'center';
  ctx.fillText('radius  r  (code units)', mL + iw / 2, H - 4);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText('Σ(r)  azimuthal mean, log scale', mL, 13);
}

export function paintTimeline(ctx: CanvasRenderingContext2D, meta: Meta | null, playOrbit: number | null) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!meta || meta.max_orbits == null) return;
  const pad = 10, y0 = 26, bh = 18;
  const max = meta.max_orbits;
  const xOf = (o: number) => pad + (Math.max(0, Math.min(max, o)) / max) * (W - 2 * pad);
  ctx.strokeStyle = 'rgba(148,163,184,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad + 0.5, y0 + 0.5, W - 2 * pad - 1, bh - 1);

  if (meta.orbit_first != null && meta.orbit_last != null) {
    const a = xOf(meta.orbit_first), b = xOf(meta.orbit_last);
    ctx.fillStyle = 'rgba(52,211,153,0.22)';
    ctx.fillRect(a, y0, Math.max(1, b - a), bh);
    ctx.strokeStyle = 'rgba(52,211,153,0.85)';
    ctx.strokeRect(a + 0.5, y0 + 0.5, Math.max(1, b - a) - 1, bh - 1);
  }
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.textAlign = 'left';
  ctx.fillText(`orbit ${playOrbit != null ? playOrbit.toFixed(2) : '—'} / ${max.toFixed(0)}`, pad, 16);
  if (meta.orbit_first != null) {
    ctx.fillStyle = 'rgba(52,211,153,0.9)';
    ctx.fillText(`buffered ${meta.orbit_first.toFixed(1)} – ${meta.orbit_last!.toFixed(1)} orbits`, pad + 120, 16);
  }
  if (playOrbit != null) {
    const x = xOf(playOrbit);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y0 - 7);
    ctx.lineTo(x, y0 + bh + 7);
    ctx.stroke();
  }
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'left';
  ctx.fillText('0', pad, y0 + bh + 17);
  ctx.textAlign = 'right';
  ctx.fillText(max.toFixed(0), W - pad, y0 + bh + 17);
}

// ---- range + overlay (the WebGL path draws the field; this draws everything on top) ----------

export function computeRange(f: Frame, fieldIdx: number, scale: 'log' | 'linear'): Range {
  const data = f.fields[Math.min(fieldIdx, f.nfields - 1)]
  if (!data) return { lo: 0, hi: 1, mode: scale }
  const tf = scale === 'log' ? (v: number) => Math.log10(v) : (v: number) => v
  return { ...percentileRange(data, tf), mode: scale }
}

export function paintOverlay(
  ctx: CanvasRenderingContext2D, f: Frame,
  opts: { frame: 'rot' | 'inertial'; arrows: boolean; showGrid: boolean },
) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const SCL = W / (2 * 2.62), CX = W / 2, CY = H / 2;
  const nx = f.nx, ny = f.ny;
  const dth = opts.frame === 'inertial' ? f.theta : 0;
  const shift = ((dth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const dphi = (2 * Math.PI) / nx, dr = (RMAX - RMIN) / ny;
  ctx.clearRect(0, 0, W, H);

  if (opts.arrows && f.nfields >= 3) {
    const vx = f.fields[1], vy = f.fields[2], mean = new Float64Array(ny);
    for (let j = 0; j < ny; j++) {
      let s = 0;
      for (let i = 0; i < nx; i++) s += vx[j * nx + i];
      mean[j] = s / nx;
    }
    const mags = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) mags[j * nx + i] = Math.abs(vx[j * nx + i] - mean[j]);
    const sorted = Array.from(mags).sort((a, b) => a - b);
    const vmax = Math.max(1e-12, sorted[Math.floor(0.98 * sorted.length)]);
    ctx.strokeStyle = 'rgba(94,234,212,0.85)';
    ctx.lineWidth = 1;
    for (let j = 6; j < ny; j += 8) {
      const r = RMIN + (j + 0.5) * dr;
      for (let i = 0; i < nx; i += 12) {
        const phi = -Math.PI + (i + 0.5) * dphi + shift;
        const pr = vx[j * nx + i] - mean[j], pt = vy[j * nx + i];
        const scl = 34 / vmax;
        const x0 = CX + Math.cos(phi) * r * SCL, y0 = CY - Math.sin(phi) * r * SCL;
        const ux = Math.cos(phi) * pr - Math.sin(phi) * pt;
        const uy = Math.sin(phi) * pr + Math.cos(phi) * pt;
        let ax = ux * scl, ay = uy * scl;
        const alen = Math.hypot(ax, ay), cap = 16;
        if (alen > cap) { ax *= cap / alen; ay *= cap / alen; }
        const x1 = x0 + ax, y1 = y0 - ay;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        const nl = Math.hypot(ax, ay);
        if (nl > 3.5) {
          const ang = Math.atan2(-ay, ax), hl = Math.min(5, 1.4 + nl * 0.28), sp = 0.45;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - hl * Math.cos(ang - sp), y1 - hl * Math.sin(ang - sp));
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - hl * Math.cos(ang + sp), y1 - hl * Math.sin(ang + sp));
          ctx.stroke();
        }
      }
    }
  }

  if (opts.showGrid) {
    ctx.strokeStyle = 'rgba(148,163,184,0.20)';
    ctx.lineWidth = 1;
    for (const rr of [0.5, 1.0, 1.5, 2.0, 2.5]) {
      ctx.beginPath();
      ctx.arc(CX, CY, rr * SCL, 0, 2 * Math.PI);
      ctx.stroke();
    }
  }

  for (const p of f.planets) {
    const c = Math.cos(dth), s = Math.sin(dth);
    const wx = c * p.x - s * p.y, wy = s * p.x + c * p.y;
    ctx.beginPath();
    ctx.arc(CX + wx * SCL, CY - wy * SCL, 5, 0, 2 * Math.PI);
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.strokeStyle = '#05070a';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

export function radialProfile(f: Frame): { r: number; sigma: number; vres: number }[] {
  const nx = f.nx, ny = f.ny, d = f.fields[0];
  const out: { r: number; sigma: number; vres: number }[] = [];
  const vx = f.nfields >= 3 ? f.fields[1] : null;
  const vy = f.nfields >= 3 ? f.fields[2] : null;
  for (let j = 0; j < ny; j++) {
    let s = 0, sv = 0;
    for (let i = 0; i < nx; i++) {
      s += d[j * nx + i];
      if (vx && vy) sv += Math.hypot(vx[j * nx + i], vy[j * nx + i]);
    }
    const mean = s / nx;
    out.push({
      r: RMIN + ((j + 0.5) * (RMAX - RMIN)) / ny,
      sigma: mean,
      vres: vx && vy ? sv / nx - (() => { let t = 0; for (let i = 0; i < nx; i++) t += Math.hypot(vx[j * nx + i], vy[j * nx + i]); return t / nx; })() : 0,
    });
  }
  return out;
}

/* ================= FFT ================= */
function makeFFT(n) {
  const bits = Math.log2(n), rev = new Uint32Array(n), cs = new Float32Array(n / 2), sn = new Float32Array(n / 2);
  for (let i = 0; i < n; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  for (let k = 0; k < n / 2; k++) { cs[k] = Math.cos(2 * Math.PI * k / n); sn[k] = Math.sin(2 * Math.PI * k / n); }
  return function (re, im) {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) for (let j = 0; j < half; j++) {
        const k = j * step, a = i + j, b = a + half;
        const tr = re[b] * cs[k] + im[b] * sn[k], ti = -re[b] * sn[k] + im[b] * cs[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  };
}
function pct(arr, q) {
  const a = Array.from(arr).sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))];
}

/* ================= audio analysis (whole song, 60 fps, deterministic) ================= */
async function analyze(buf, onProg) {
  const sr = buf.sampleRate, hop = sr / FPS, N = 2048;
  const chL = buf.getChannelData(0), chR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : chL;
  const frames = Math.ceil(buf.duration * FPS) + 1;
  const fft = makeFFT(N), re = new Float32Array(N), im = new Float32Array(N), win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const binHz = sr / N;
  const bandBins = BANDS.map(c => {
    let lo = Math.max(1, Math.floor(c / Math.SQRT2 / binHz)), hi = Math.min(N / 2 - 1, Math.ceil(c * Math.SQRT2 / binHz));
    if (hi < lo) hi = lo; return [lo, hi];
  });
  const bLo = Math.max(1, Math.floor(40 / binHz)), bHi = Math.ceil(130 / binHz);
  const hLo = Math.floor(5000 / binHz), hHi = Math.min(N / 2 - 1, Math.ceil(14000 / binHz));

  const dbL = new Float32Array(frames), dbR = new Float32Array(frames), dbM = new Float32Array(frames);
  const bandDb = new Float32Array(frames * 10), bassE = new Float32Array(frames), hiDb = new Float32Array(frames);
  const len = chL.length;

  for (let f = 0; f < frames; f++) {
    const start = Math.round(f * hop) - N / 2;
    let sl = 0, sr2 = 0;
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      const l = (idx >= 0 && idx < len) ? chL[idx] : 0, r = (idx >= 0 && idx < len) ? chR[idx] : 0;
      sl += l * l; sr2 += r * r;
      re[i] = (l + r) * 0.5 * win[i]; im[i] = 0;
    }
    dbL[f] = 10 * Math.log10(sl / N + 1e-12); dbR[f] = 10 * Math.log10(sr2 / N + 1e-12);
    dbM[f] = Math.max(dbL[f], dbR[f]);
    fft(re, im);
    for (let b = 0; b < 10; b++) {
      let p = 0; const [lo, hi] = bandBins[b];
      for (let k = lo; k <= hi; k++) p += re[k] * re[k] + im[k] * im[k];
      bandDb[f * 10 + b] = 10 * Math.log10(p + 1e-12);
    }
    let be = 0; for (let k = bLo; k <= bHi; k++) be += re[k] * re[k] + im[k] * im[k];
    bassE[f] = be;
    let he = 0; for (let k = hLo; k <= hHi; k++) he += re[k] * re[k] + im[k] * im[k];
    hiDb[f] = 10 * Math.log10(he + 1e-12);
    if (f % 600 === 0) { onProg && onProg(f / frames * 0.85); await new Promise(r => setTimeout(r, 0)); }
  }

  // ---- normalisation (per song) ----
  const loud = Array.from(dbM).filter(v => v > -60);
  const ref = (loud.length ? pct(loud, 0.82) : -14) + 1;          // 0 VU sits just above the song's typical loud level
  const bandLo = [], bandHi = [];
  for (let b = 0; b < 10; b++) {
    const col = []; for (let f = 0; f < frames; f++) if (dbM[f] > -60) col.push(bandDb[f * 10 + b]);
    bandLo.push(col.length ? pct(col, 0.15) : -60); bandHi.push(col.length ? pct(col, 0.985) : 0);
  }
  const bassDb = bassE.map(v => 10 * Math.log10(v + 1e-12));
  const bassLoud = Array.from(bassDb).filter((v, i) => dbM[i] > -60);
  const bassLo = bassLoud.length ? pct(bassLoud, 0.2) : -60, bassHi = bassLoud.length ? pct(bassLoud, 0.98) : 0;
  const hiLoud = Array.from(hiDb).filter((v, i) => dbM[i] > -60);
  const hiLo = hiLoud.length ? pct(hiLoud, 0.2) : -60, hiHi = hiLoud.length ? pct(hiLoud, 0.98) : 0;
  const bassFloor = pct(bassE, 0.35);

  // ---- ballistics ----
  const A = {
    frames, ref,
    vuL: new Float32Array(frames), vuR: new Float32Array(frames),
    lampL: new Uint8Array(frames), lampR: new Uint8Array(frames),
    band: new Float32Array(frames * 10), peak: new Float32Array(frames * 10),
    cone: new Float32Array(frames), beat: new Uint8Array(frames), beatEnv: new Float32Array(frames),
    hi: new Float32Array(frames), level: new Float32Array(frames)
  };
  const K = 380, C = 30, sub = 4, dt = 1 / FPS / sub;
  let xl = 0, vl = 0, xr = 0, vr = 0, hl = 0, hr = 0;
  const bv = new Float32Array(10), pk = new Float32Array(10), hold = new Int16Array(10);
  let env = 0, bn = 0, hv = 0, since = 99, prevE = 0, avg = 0;
  const AVG_N = 43; let ring = new Float32Array(AVG_N), rsum = 0;

  for (let f = 0; f < frames; f++) {
    const silent = dbM[f] < -60;
    const tl = silent ? 0 : vuPos(dbL[f] - ref), tr = silent ? 0 : vuPos(dbR[f] - ref);
    for (let s = 0; s < sub; s++) {
      let a = K * (tl - xl) - C * vl; vl += a * dt; xl += vl * dt;
      a = K * (tr - xr) - C * vr; vr += a * dt; xr += vr * dt;
      if (xl < -0.03) { xl = -0.03; vl = 0; } if (xl > 1.07) { xl = 1.07; vl = -vl * 0.3; }
      if (xr < -0.03) { xr = -0.03; vr = 0; } if (xr > 1.07) { xr = 1.07; vr = -vr * 0.3; }
    }
    A.vuL[f] = xl; A.vuR[f] = xr;
    hl = (dbL[f] - ref > 1.5 && !silent) ? 9 : Math.max(0, hl - 1);
    hr = (dbR[f] - ref > 1.5 && !silent) ? 9 : Math.max(0, hr - 1);
    A.lampL[f] = hl > 0 ? 1 : 0; A.lampR[f] = hr > 0 ? 1 : 0;
    A.level[f] = clamp((xl + xr) / 2, 0, 1);

    for (let b = 0; b < 10; b++) {
      let raw = silent ? 0 : clamp((bandDb[f * 10 + b] - bandLo[b]) / Math.max(6, bandHi[b] - bandLo[b]), 0, 1);
      raw = Math.pow(raw, 1.35);
      bv[b] = raw > bv[b] ? bv[b] + (raw - bv[b]) * 0.75 : Math.max(raw, bv[b] - 0.032);
      if (bv[b] >= pk[b]) { pk[b] = bv[b]; hold[b] = 36; }
      else if (hold[b] > 0) hold[b]--;
      else pk[b] = Math.max(bv[b], pk[b] - 0.012);
      A.band[f * 10 + b] = bv[b]; A.peak[f * 10 + b] = pk[b];
    }

    // beat detection on the 40–130 Hz energy
    const E = bassE[f];
    const mean = f < AVG_N ? (rsum / Math.max(1, f)) : rsum / AVG_N;
    since++;
    let beat = 0;
    if (!silent && f > 4 && E > mean * 1.45 && E > bassFloor && E >= prevE && since >= 10) { beat = 1; since = 0; }
    rsum -= ring[f % AVG_N]; ring[f % AVG_N] = E; rsum += E; prevE = E;
    env = beat ? 1 : env * 0.86;
    A.beat[f] = beat; A.beatEnv[f] = env;
    const braw = silent ? 0 : clamp((bassDb[f] - bassLo) / Math.max(6, bassHi - bassLo), 0, 1);
    bn += (braw - bn) * 0.5;
    A.cone[f] = clamp(env * 0.65 + bn * bn * 0.35, 0, 1);
    const hraw = silent ? 0 : clamp((hiDb[f] - hiLo) / Math.max(6, hiHi - hiLo), 0, 1);
    hv = hraw > hv ? hv + (hraw - hv) * 0.6 : hv + (hraw - hv) * 0.15;
    A.hi[f] = hv;
  }
  onProg && onProg(1);
  return A;
}


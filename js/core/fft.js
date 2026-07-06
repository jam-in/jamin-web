// Iterative radix-2 complex FFT / IFFT for GCC-PHAT cross-correlation.
// Complex numbers are stored as interleaved [re0, im0, re1, im1, ...].

/** Next power of two >= n. */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Zero-pad a real signal to length `size` (power of two). */
export function padReal(signal, size) {
  const out = new Float32Array(size);
  out.set(signal.subarray(0, Math.min(signal.length, size)));
  return out;
}

/** In-place bit-reversal permutation on interleaved complex buffer. */
function bitReverse(data, n) {
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const a = i << 1;
      const b = j << 1;
      const tr = data[a];
      const ti = data[a + 1];
      data[a] = data[b];
      data[a + 1] = data[b + 1];
      data[b] = tr;
      data[b + 1] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }
}

/**
 * In-place radix-2 Cooley-Tukey FFT.
 * @param {Float32Array} data - interleaved complex, length 2*n
 * @param {boolean} inverse - true for IFFT (normalised)
 */
export function fft(data, inverse = false) {
  const n = data.length >> 1;
  if (n <= 1) return;

  bitReverse(data, n);

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let i = 0; i < n; i += size) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < half; j++) {
        const even = (i + j) << 1;
        const odd = (i + j + half) << 1;

        const tRe = curRe * data[odd] - curIm * data[odd + 1];
        const tIm = curRe * data[odd + 1] + curIm * data[odd];

        data[odd] = data[even] - tRe;
        data[odd + 1] = data[even + 1] - tIm;
        data[even] += tRe;
        data[even + 1] += tIm;

        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < data.length; i++) data[i] /= n;
  }
}

/** Pack a real signal into interleaved complex (imag = 0). */
export function realToComplex(real) {
  const out = new Float32Array(real.length << 1);
  for (let i = 0; i < real.length; i++) {
    out[i << 1] = real[i];
  }
  return out;
}

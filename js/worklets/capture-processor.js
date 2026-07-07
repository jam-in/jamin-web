// AudioWorklet: capture aligned mic (ch0) + reference (ch1), decimate to targetHz.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = options.processorOptions || {};
    this.targetHz = p.targetHz || 16000;
    this.decimate = Math.max(1, Math.round(sampleRate / this.targetHz));
    this.maxSamples = p.maxSamples || 16000 * 12; // ~12 s at 16 kHz

    this.micBuf = [];
    this.refBuf = [];
    this.ringMic = new Float32Array(this.maxSamples);
    this.ringRef = new Float32Array(this.maxSamples);
    this.ringWrite = 0;
    this.ringCount = 0;
    this.refEnergySum = 0;
    this.refEnergyCount = 0;
    this.refEnergyRms = 0;
    this.tick = 0;
    this.energyInterval = Math.round(sampleRate / 20); // ~20 Hz energy updates

    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.port.postMessage({
          type: "flush",
          mic: this.micBuf,
          ref: this.refBuf,
        });
        this.micBuf = [];
        this.refBuf = [];
      } else if (event.data?.type === "snapshot") {
        const len = this.ringCount;
        const mic = new Float32Array(len);
        const ref = new Float32Array(len);
        if (len > 0) {
          const start = this.ringCount < this.maxSamples
            ? 0
            : this.ringWrite;
          for (let i = 0; i < len; i++) {
            const idx = (start + i) % this.maxSamples;
            mic[i] = this.ringMic[idx];
            ref[i] = this.ringRef[idx];
          }
        }
        this.port.postMessage({
          type: "snapshot",
          mic,
          ref,
        });
      }
    };
  }

  pushRing(micSample, refSample) {
    this.ringMic[this.ringWrite] = micSample;
    this.ringRef[this.ringWrite] = refSample;
    this.ringWrite = (this.ringWrite + 1) % this.maxSamples;
    if (this.ringCount < this.maxSamples) this.ringCount++;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length < 2) return true;

    const mic = input[0];
    const ref = input[1];
    if (!mic || !ref) return true;

    for (let i = 0; i < mic.length; i += this.decimate) {
      const micSample = mic[i];
      const refSample = ref[i];

      // The rolling ring buffer and energy must track the WHOLE capture so
      // every 12 s window sees fresh, correctly-spaced audio.
      this.pushRing(micSample, refSample);
      this.refEnergySum += refSample * refSample;
      this.refEnergyCount++;

      // The linear micBuf/refBuf are capped (used by calibration + bleeding);
      // stop growing them past maxSamples, but do NOT abort the loop.
      if (this.micBuf.length < this.maxSamples) {
        this.micBuf.push(micSample);
        this.refBuf.push(refSample);
      }
    }

    this.tick += mic.length;
    if (this.tick >= this.energyInterval) {
      this.tick = 0;
      if (this.refEnergyCount > 0) {
        this.refEnergyRms = Math.sqrt(this.refEnergySum / this.refEnergyCount);
        this.port.postMessage({ type: "energy", rms: this.refEnergyRms });
        this.refEnergySum = 0;
        this.refEnergyCount = 0;
      }
    }

    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);

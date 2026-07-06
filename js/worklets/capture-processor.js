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
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length < 2) return true;

    const mic = input[0];
    const ref = input[1];
    if (!mic || !ref) return true;

    for (let i = 0; i < mic.length; i += this.decimate) {
      if (this.micBuf.length >= this.maxSamples) break;
      this.micBuf.push(mic[i]);
      this.refBuf.push(ref[i]);

      const r = ref[i];
      this.refEnergySum += r * r;
      this.refEnergyCount++;
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

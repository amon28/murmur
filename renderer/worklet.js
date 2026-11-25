// Passes microphone samples (16 kHz mono, the AudioContext resamples) to the page in 32 ms frames (512 samples, what the Silero speech detector reads).
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(512); this.n = 0 }
  process(inputs) {
    const ch = inputs[0]?.[0]
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0 }
    }
    return true
  }
}
registerProcessor('tap', Tap)

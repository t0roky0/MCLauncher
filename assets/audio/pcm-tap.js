// AudioWorklet: hands the main thread the voice that goes out, in 20 ms
// blocks (960 samples at 48 kHz), for the relay encoder (src/renderer/js/voice-relay.js).
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(960);
    this.fill = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.block[this.fill++] = ch[i];
        if (this.fill === this.block.length) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(960);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);

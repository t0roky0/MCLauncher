// Voice through the party relay — for friends whose networks won't let a
// direct WebRTC call through (carrier-grade NAT on both ends, mostly).
//
// Your processed voice is Opus-encoded (WebCodecs) only while your mic is
// open and goes over the party's own channel — AES-GCM sealed like every
// other party message — in ~80 ms packets. A friend's packets are decoded
// and played with a small jitter buffer. A few hundred ms slower than a
// direct call, but it always connects.

const RATE = 48000;
const FRAME = 960; // 20 ms
const BATCH = 4; // frames per packet: 80 ms
const OPUS = { codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: 24000 };

const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
const unb64 = (s) => {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

export function relaySupported() {
  return typeof AudioEncoder === 'function' && typeof AudioDecoder === 'function';
}

// Encodes what leaves the gate; `send(packet)` gets {s, f: [base64 opus frames]}.
export class RelaySender {
  constructor(ctx, source, send) {
    this.ctx = ctx;
    this.send = send;
    this.active = false;
    this.open = false;
    this.seq = 0;
    this.ts = 0;
    this.frames = [];
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        this.frames.push(b64(bytes));
        if (this.frames.length >= BATCH) this.flush();
      },
      error: () => {
        this.broken = true;
      },
    });
    this.encoder.configure(OPUS);
    this.ready = ctx.audioWorklet.addModule('mcl://app/assets/audio/pcm-tap.js').then(() => {
      if (this.closed) return;
      this.tap = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      // a node only runs while something pulls on it
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      source.connect(this.tap);
      this.tap.connect(this.sink).connect(ctx.destination);
      this.tap.port.onmessage = (e) => this.onBlock(e.data);
    });
  }

  onBlock(block) {
    if (!this.active || !this.open || this.broken || this.encoder.state !== 'configured') return;
    const data = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: FRAME, numberOfChannels: 1, timestamp: this.ts, data: block });
    this.ts += 20000;
    this.encoder.encode(data);
    data.close();
  }

  flush() {
    if (!this.frames.length) return;
    const f = this.frames;
    this.frames = [];
    this.send({ s: ++this.seq, f });
  }

  // anyone without a direct call to us? then we also speak through the relay
  setActive(on) {
    this.active = !!on;
  }

  // the mic gate: nothing is encoded or sent while it's shut
  setOpen(open) {
    if (this.open && !open) this.encoder.flush().then(() => this.flush()).catch(() => {});
    this.open = !!open;
  }

  close() {
    this.closed = true;
    try {
      if (this.tap) {
        this.tap.port.onmessage = null;
        this.tap.disconnect();
      }
      if (this.sink) this.sink.disconnect();
      if (this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      /* already gone */
    }
  }
}

// One friend's voice from the relay: decode, cushion, play; volume and level.
export class RelayPlayer {
  constructor(ctx, name) {
    this.ctx = ctx;
    this.name = name;
    this.next = 0;
    this.lastSeq = 0;
    this.lastAudio = 0;
    this.ts = 0;
    this.gain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.gain.connect(this.analyser);
    this.gain.connect(ctx.destination);
    this.decoder = new AudioDecoder({ output: (d) => this.play(d), error: () => this.reset() });
    this.decoder.configure(OPUS);
  }

  reset() {
    try {
      if (this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      /* closed */
    }
    this.decoder = new AudioDecoder({ output: (d) => this.play(d), error: () => this.reset() });
    this.decoder.configure(OPUS);
  }

  push({ s, f }) {
    if (!Array.isArray(f) || !Number.isFinite(s)) return;
    if (s <= this.lastSeq && this.lastSeq - s < 5000) return; // late or repeated
    this.lastSeq = s;
    for (const frame of f.slice(0, 10)) {
      if (typeof frame !== 'string' || frame.length > 800) continue;
      try {
        this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: this.ts, data: unb64(frame) }));
        this.ts += 20000;
      } catch {
        this.reset();
        return;
      }
    }
  }

  play(audio) {
    const n = audio.numberOfFrames;
    const buf = this.ctx.createBuffer(1, n, audio.sampleRate);
    audio.copyTo(buf.getChannelData(0), { planeIndex: 0, format: 'f32-planar' });
    audio.close();
    const now = this.ctx.currentTime;
    // a fresh start (or a stall): a 180 ms cushion against network jitter
    if (this.next < now + 0.02 || this.next > now + 1.2) this.next = now + 0.18;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(this.next);
    this.next += buf.duration;
    this.lastAudio = performance.now();
  }

  active() {
    return performance.now() - this.lastAudio < 8000;
  }

  setVolume(v) {
    this.gain.gain.value = v;
  }

  close() {
    try {
      if (this.decoder.state !== 'closed') this.decoder.close();
      this.gain.disconnect();
    } catch {
      /* gone */
    }
  }
}

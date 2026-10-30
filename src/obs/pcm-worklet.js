// Joue dans le flux OBS le son reçu morceau par morceau (son d'une fenêtre).
// Petite réserve régulière : assez pour absorber les irrégularités d'arrivée,
// assez courte pour rester calée sur l'image. Les deux horloges (Windows et
// celle du flux) dérivent lentement : la réserve est recadrée si besoin.
const CHANNELS = 2;
const TARGET = 0.08; // secondes de réserve visées
const MAX = 0.3; // au-delà, on rattrape en jetant le plus ancien

class PcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Réserve visée (secondes), éventuellement fixée par la page.
    this.target = (options && options.processorOptions && options.processorOptions.target) || TARGET;
    this.capacity = Math.round(sampleRate * 2) * CHANNELS;
    this.ring = new Float32Array(this.capacity);
    this.read = 0;
    this.filled = 0;
    this.started = false;
    this.port.onmessage = (event) => this.push(event.data);
  }

  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.ring[(this.read + this.filled) % this.capacity] = samples[i];
      if (this.filled < this.capacity) this.filled++;
      else this.read = (this.read + 1) % this.capacity;
    }
    const max = Math.round(sampleRate * Math.max(MAX, this.target * 2)) * CHANNELS;
    if (this.filled > max) {
      const drop = this.filled - Math.round(sampleRate * this.target) * CHANNELS;
      this.read = (this.read + drop) % this.capacity;
      this.filled -= drop;
    }
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    const frames = left.length;
    if (!this.started && this.filled >= Math.round(sampleRate * this.target) * CHANNELS) this.started = true;
    for (let i = 0; i < frames; i++) {
      if (this.started && this.filled >= CHANNELS) {
        left[i] = this.ring[this.read];
        right[i] = this.ring[(this.read + 1) % this.capacity];
        this.read = (this.read + CHANNELS) % this.capacity;
        this.filled -= CHANNELS;
      } else {
        // Réserve vide : silence, et on attend qu'elle se reconstitue.
        left[i] = 0;
        right[i] = 0;
        this.started = false;
      }
    }
    return true;
  }
}

registerProcessor("pcm-player", PcmPlayer);

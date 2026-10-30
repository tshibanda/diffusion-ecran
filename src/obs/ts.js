// Mise en paquets MPEG-TS (le format des directs télé et du streaming) pour la
// Source média d'OBS : chaque image H.264 et chaque morceau de son Opus est
// envoyé dès qu'il est encodé, sans attendre la fin d'un bloc (contrairement
// au MP4, qui arrive par à-coups d'une demi-seconde).
const PAT_PID = 0x0000;
const PMT_PID = 0x1000;
const VIDEO_PID = 0x0100;
const AUDIO_PID = 0x0101;
const PACKET = 188;
const PTS_WRAP = 2 ** 33;
// Le PCR (horloge du flux) précède un peu les images, comme l'exige la norme.
const PCR_LEAD = 0.3 * 90000;
// Délimiteur d'image H.264, conseillé en MPEG-TS.
const AUD = Buffer.from([0, 0, 0, 1, 0x09, 0xf0]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}

// Horodatage µs -> horloge 90 kHz sur 33 bits.
function to90k(microseconds) {
  return Math.round((microseconds * 9) / 100) % PTS_WRAP;
}

function writePts(buf, offset, pts) {
  const high = Math.floor(pts / 2 ** 30) & 0x07;
  const low = pts % 2 ** 30;
  buf[offset] = 0x20 | (high << 1) | 1;
  buf[offset + 1] = (low >>> 22) & 0xff;
  buf[offset + 2] = (((low >>> 15) & 0x7f) << 1) | 1;
  buf[offset + 3] = (low >>> 7) & 0xff;
  buf[offset + 4] = ((low & 0x7f) << 1) | 1;
}

function pcrField(pcr, randomAccess) {
  const base = ((pcr % PTS_WRAP) + PTS_WRAP) % PTS_WRAP;
  const field = Buffer.alloc(7);
  field[0] = 0x10 | (randomAccess ? 0x40 : 0);
  field[1] = Math.floor(base / 2 ** 25) & 0xff;
  field[2] = Math.floor(base / 2 ** 17) & 0xff;
  field[3] = Math.floor(base / 2 ** 9) & 0xff;
  field[4] = Math.floor(base / 2) & 0xff;
  field[5] = ((base % 2) << 7) | 0x7e;
  field[6] = 0;
  return field;
}

function pes(streamId, pts, payload, bounded) {
  const header = Buffer.alloc(14);
  header[2] = 1;
  header[3] = streamId;
  const length = 8 + payload.length;
  header.writeUInt16BE(bounded && length <= 0xffff ? length : 0, 4);
  header[6] = 0x84; // aligné sur le début de l'image
  header[7] = 0x80; // PTS seul (pas d'images B)
  header[8] = 5;
  writePts(header, 9, pts);
  return Buffer.concat([header, payload]);
}

function createTsMuxer() {
  const counters = {};
  const nextCounter = (pid) => (counters[pid] = ((counters[pid] ?? -1) + 1) & 0x0f);

  function packetize(pid, data, { pcr = null, randomAccess = false } = {}) {
    const packets = [];
    let offset = 0;
    let first = true;
    while (offset < data.length || first) {
      let af = first && pcr !== null ? pcrField(pcr, randomAccess) : null;
      let space = PACKET - 4 - (af ? 1 + af.length : 0);
      const remaining = data.length - offset;
      if (remaining < space) {
        // Dernier paquet : complété par du bourrage dans le champ d'adaptation.
        const stuffing = space - remaining;
        if (af) af = Buffer.concat([af, Buffer.alloc(stuffing, 0xff)]);
        else if (stuffing === 1) af = Buffer.alloc(0);
        else {
          af = Buffer.alloc(stuffing - 1, 0xff);
          af[0] = 0;
        }
        space = remaining;
      }
      const packet = Buffer.alloc(PACKET, 0xff);
      packet[0] = 0x47;
      packet[1] = (first ? 0x40 : 0) | ((pid >> 8) & 0x1f);
      packet[2] = pid & 0xff;
      packet[3] = (af ? 0x30 : 0x10) | nextCounter(pid);
      let p = 4;
      if (af) {
        packet[p++] = af.length;
        af.copy(packet, p);
        p += af.length;
      }
      data.copy(packet, p, offset, offset + space);
      offset += space;
      packets.push(packet);
      first = false;
    }
    return Buffer.concat(packets);
  }

  function section(pid, body) {
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return packetize(pid, Buffer.concat([Buffer.from([0]), body, crc]));
  }

  // Tables du programme : une piste H.264 et une piste Opus.
  function tables() {
    const pat = Buffer.from([0x00, 0xb0, 13, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff]);
    const opusDescriptors = [0x05, 0x04, 0x4f, 0x70, 0x75, 0x73, 0x7f, 0x02, 0x80, 0x02];
    const streams = [
      0x1b, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0x00,
      0x06, 0xe0 | (AUDIO_PID >> 8), AUDIO_PID & 0xff, 0xf0, opusDescriptors.length, ...opusDescriptors,
    ];
    const pmtLength = 9 + streams.length + 4;
    const pmt = Buffer.from([
      0x02, 0xb0 | (pmtLength >> 8), pmtLength & 0xff, 0x00, 0x01, 0xc1, 0x00, 0x00,
      0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0x00, ...streams,
    ]);
    return Buffer.concat([section(PAT_PID, pat), section(PMT_PID, pmt)]);
  }

  // Une image H.264 (Annex B, avec SPS/PPS sur les images clés).
  function video(timestampUs, data, key) {
    const pts = to90k(timestampUs);
    const payload = pes(0xe0, pts, Buffer.concat([AUD, Buffer.from(data)]), false);
    return packetize(VIDEO_PID, payload, { pcr: pts - PCR_LEAD, randomAccess: key });
  }

  // Un morceau de son Opus, précédé de l'en-tête de contrôle Opus-dans-TS.
  function audio(timestampUs, data) {
    const size = [];
    let n = data.length;
    while (n >= 255) {
      size.push(255);
      n -= 255;
    }
    size.push(n);
    const payload = Buffer.concat([Buffer.from([0x7f, 0xe0, ...size]), Buffer.from(data)]);
    return packetize(AUDIO_PID, pes(0xbd, to90k(timestampUs), payload, true));
  }

  return { tables, video, audio };
}

module.exports = { createTsMuxer };

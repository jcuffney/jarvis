import { Socket } from 'node:net';

interface AudioFormat {
  rate: number;
  width: number;
  channels: number;
}

/**
 * Minimal Wyoming-protocol TTS client (rhasspy/wyoming): events are a JSONL
 * header (optionally announcing data_length/payload_length byte blocks),
 * then data JSON, then payload bytes. synthesize → audio-start/-chunk/-stop.
 * Returns a complete WAV buffer.
 */
export function synthesizeWav(
  host: string,
  port: number,
  text: string,
  voice?: string,
  timeoutMs = 30_000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const pcmChunks: Buffer[] = [];
    let format: AudioFormat | null = null;
    let buffer = Buffer.alloc(0);
    let pending: { header: { type: string; data?: unknown }; dataLen: number; payloadLen: number } | null = null;

    const timer = setTimeout(() => finish(new Error('tts timeout')), timeoutMs);
    const finish = (err?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else if (!format || pcmChunks.length === 0) reject(new Error('tts returned no audio'));
      else resolve(pcmToWav(Buffer.concat(pcmChunks), format));
    };

    const handleEvent = (type: string, data: Record<string, unknown>, payload?: Buffer) => {
      if (type === 'audio-start') {
        format = {
          rate: Number(data.rate ?? 22050),
          width: Number(data.width ?? 2),
          channels: Number(data.channels ?? 1),
        };
      } else if (type === 'audio-chunk' && payload && payload.length > 0) {
        pcmChunks.push(payload);
      } else if (type === 'audio-stop') {
        finish();
      } else if (type === 'error') {
        finish(new Error(String(data.text ?? 'wyoming error')));
      }
    };

    const drain = () => {
      for (;;) {
        if (!pending) {
          const nl = buffer.indexOf(0x0a);
          if (nl === -1) return;
          const line = buffer.subarray(0, nl).toString('utf8');
          buffer = buffer.subarray(nl + 1);
          let header: { type: string; data?: unknown; data_length?: number; payload_length?: number };
          try {
            header = JSON.parse(line);
          } catch {
            continue;
          }
          pending = {
            header,
            dataLen: header.data_length ?? 0,
            payloadLen: header.payload_length ?? 0,
          };
        }
        const need = pending.dataLen + pending.payloadLen;
        if (buffer.length < need) return;
        const dataBytes = buffer.subarray(0, pending.dataLen);
        const payload = pending.payloadLen
          ? Buffer.from(buffer.subarray(pending.dataLen, need))
          : undefined;
        buffer = buffer.subarray(need);
        const data = pending.dataLen
          ? (JSON.parse(dataBytes.toString('utf8')) as Record<string, unknown>)
          : ((pending.header.data ?? {}) as Record<string, unknown>);
        const type = pending.header.type;
        pending = null;
        handleEvent(type, data, payload);
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        drain();
      } catch (err) {
        finish(err as Error);
      }
    });
    socket.on('error', (err) => finish(err));
    socket.on('close', () => {
      // Some servers close without an explicit audio-stop.
      if (format && pcmChunks.length > 0) finish();
    });
    socket.connect(port, host, () => {
      const event = {
        type: 'synthesize',
        data: { text, ...(voice ? { voice: { name: voice } } : {}) },
      };
      socket.write(`${JSON.stringify(event)}\n`);
    });
  });
}

function pcmToWav(pcm: Buffer, { rate, width, channels }: AudioFormat): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = rate * channels * width;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * width, 32);
  header.writeUInt16LE(width * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

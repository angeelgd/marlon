import { describe, expect, it } from "vitest";
import { encodeWav, resample, toBase64, toMono } from "../src/lib/wav";

describe("WAV", () => {
  it("cabecera PCM 16 bits mono 16 kHz", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]));
    const v = new DataView(wav.buffer);
    const str = (o: number) => String.fromCharCode(...wav.slice(o, o + 4));
    expect(str(0)).toBe("RIFF");
    expect(str(8)).toBe("WAVE");
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(8);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([0, 32767, -32768]);
    expect(wav.length).toBe(52);
  });

  it("mezcla a mono y remuestrea de 48 kHz a 16 kHz", () => {
    expect(Array.from(toMono([new Float32Array([1, 0]), new Float32Array([0, 1])]))).toEqual([0.5, 0.5]);
    const one = new Float32Array(48000).fill(0.25);
    const out = resample(one, 48000);
    expect(out.length).toBe(16000);
    expect(out[100]).toBeCloseTo(0.25);
  });

  it("base64 de buffers grandes sin desbordar la pila", () => {
    const big = new Uint8Array(200_000).fill(65);
    expect(toBase64(big).length).toBe(Math.ceil(200_000 / 3) * 4);
  });
});

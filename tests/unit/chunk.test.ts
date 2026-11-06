import { describe, expect, it } from 'vitest';
import { joinChunks, splitIntoChunks } from '../../src/shared/chunk';

const cps = (text: string) => Array.from(text).length;

describe('splitIntoChunks', () => {
  it('keeps short text as one chunk', () => {
    const chunks = splitIntoChunks('Hello world.', 100);
    expect(chunks).toEqual([{ text: 'Hello world.', joinAfter: '' }]);
  });

  it('preserves paragraph boundaries and reassembles exactly', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird.';
    const chunks = splitIntoChunks(text, 20);
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      'First paragraph.',
      'Second paragraph.',
      'Third.',
    ]);
    expect(
      joinChunks(
        chunks.map((chunk) => chunk.text),
        chunks,
      ),
    ).toBe(text);
  });

  it('splits oversized paragraphs at sentence boundaries without exceeding the limit', () => {
    const text =
      'The first sentence is short. The second sentence is a little longer. The third sentence closes it.';
    const chunks = splitIntoChunks(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(cps(chunk.text)).toBeLessThanOrEqual(40);
    }
    expect(
      joinChunks(
        chunks.map((chunk) => chunk.text),
        chunks,
      ),
    ).toBe(text);
  });

  it('hard-splits a single oversized sentence', () => {
    const text = 'a'.repeat(25);
    const chunks = splitIntoChunks(text, 10);
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      'a'.repeat(10),
      'a'.repeat(10),
      'a'.repeat(5),
    ]);
    expect(
      joinChunks(
        chunks.map((chunk) => chunk.text),
        chunks,
      ),
    ).toBe(text);
  });

  it('counts code points rather than UTF-16 units', () => {
    const text = '😀'.repeat(12);
    const chunks = splitIntoChunks(text, 5);
    expect(chunks.length).toBe(3);
    expect(chunks.every((chunk) => cps(chunk.text) <= 5)).toBe(true);
    expect(
      joinChunks(
        chunks.map((chunk) => chunk.text),
        chunks,
      ),
    ).toBe(text);
  });

  it('keeps Japanese punctuation attached to sentences', () => {
    const text = 'これは最初の文です。これは二番目の文です。これは三番目の文です。';
    const chunks = splitIntoChunks(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      joinChunks(
        chunks.map((chunk) => chunk.text),
        chunks,
      ),
    ).toBe(text);
  });

  it('rejects a non-positive limit', () => {
    expect(() => splitIntoChunks('x', 0)).toThrow();
  });
});

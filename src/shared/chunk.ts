export interface TextChunk {
  text: string;
  /** String appended after this chunk's translation when reassembling. */
  joinAfter: string;
}

const SENTENCE_END = /(?<=[.!?。！？])\s+/;

function hardSplit(text: string, maxChars: number): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += maxChars) {
    out.push(chars.slice(i, i + maxChars).join(''));
  }
  return out;
}

/**
 * Splits at paragraph boundaries first, then sentence boundaries, then hard cuts.
 * Never drops text; the caller joins translations with each chunk's joinAfter.
 */
export function splitIntoChunks(text: string, maxChars: number): TextChunk[] {
  if (maxChars < 1) throw new Error('maxChars must be positive');
  if (Array.from(text).length <= maxChars) return [{ text, joinAfter: '' }];

  const chunks: TextChunk[] = [];
  const paragraphs = text.split(/\n{2,}/);

  paragraphs.forEach((paragraph, pIndex) => {
    const isLastParagraph = pIndex === paragraphs.length - 1;
    const paragraphJoin = isLastParagraph ? '' : '\n\n';
    if (Array.from(paragraph).length <= maxChars) {
      if (paragraph.length > 0) chunks.push({ text: paragraph, joinAfter: paragraphJoin });
      return;
    }

    const sentences = paragraph.split(SENTENCE_END);
    let buffer = '';
    const flush = (joinAfter: string) => {
      if (buffer) {
        chunks.push({ text: buffer, joinAfter });
        buffer = '';
      }
    };

    sentences.forEach((sentence, sIndex) => {
      const isLastSentence = sIndex === sentences.length - 1;
      const join = isLastSentence ? paragraphJoin : ' ';
      if (Array.from(sentence).length > maxChars) {
        flush(' ');
        const parts = hardSplit(sentence, maxChars);
        parts.forEach((part, index) => {
          const joinAfter = index === parts.length - 1 ? join : '';
          chunks.push({ text: part, joinAfter });
        });
        return;
      }
      const candidate = buffer ? `${buffer} ${sentence}` : sentence;
      if (Array.from(candidate).length > maxChars) {
        flush(' ');
        buffer = sentence;
      } else {
        buffer = candidate;
      }
      if (isLastSentence) {
        flush(join);
      }
    });
    flush(paragraphJoin);
  });

  // Merge stray empty text but never merge across a hard limit.
  return chunks.filter((chunk) => chunk.text.length > 0);
}

export function joinChunks(translated: string[], chunks: TextChunk[]): string {
  return translated.map((value, index) => value + (chunks[index]?.joinAfter ?? '')).join('');
}

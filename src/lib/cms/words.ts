/**
 * How a short text is cut into words for Word reveal (Batch 15b).
 *
 * One rule, deterministic and the same in every language: **a word is a run of
 * characters that are not whitespace, and the whitespace between words is kept
 * exactly as it was.** Nothing is dropped, trimmed, collapsed, reordered or
 * added, so joining the parts back together gives the original string, byte
 * for byte — which is the test that proves the visible sentence cannot change.
 *
 * Why this is enough, and why nothing cleverer is here:
 *
 *   · **Arabic** is written with spaces between words, like English. Its
 *     letters join *within* a word, and punctuation (the Arabic comma, a
 *     question mark) is attached to the word it follows because there is no
 *     space between them — so a word here is the unit the script itself uses,
 *     and shaping never has to reach across a cut.
 *   · **Order is the DOM's.** The parts come back in the order they appear in
 *     the string, which is logical order. Right-to-left layout, and the
 *     placement of a Latin phrase inside an Arabic sentence, is the browser's
 *     job, and the renderer keeps the words as *inline* spans precisely so the
 *     bidirectional algorithm sees the same text it would see unsplit. Nothing
 *     here reverses anything.
 *   · **Numbers, marks and symbols** are characters like any other: `2024`,
 *     `—`, `&` and `%` are words when they stand alone and part of a word when
 *     they touch one.
 *   · **Whitespace** is whatever `\s` means in a Unicode regular expression —
 *     spaces, tabs, line breaks and the no-break space. A no-break space is kept
 *     as a no-break space, so it still forbids a line break where it did.
 *
 * No segmenter and no dictionary: `Intl.Segmenter` would split Arabic clitics
 * and Latin contractions differently in different engines, and a split that
 * depends on the browser is not deterministic. No dependency.
 */

export type WordPart = { word: string } | { space: string };

const WHITESPACE = /(\s+)/u;
const ONLY_WHITESPACE = /^\s+$/u;

/** The parts of a text, in order. Joining them gives the text back exactly. */
export function splitWords(text: string): WordPart[] {
  const parts: WordPart[] = [];
  for (const piece of text.split(WHITESPACE)) {
    if (!piece) continue;
    parts.push(ONLY_WHITESPACE.test(piece) ? { space: piece } : { word: piece });
  }
  return parts;
}

/** How many words a text has — the number the render limit is checked against. */
export const wordCount = (text: string): number =>
  splitWords(text).reduce((count, part) => ("word" in part ? count + 1 : count), 0);

/** The parts, joined. The identity `joinWords(splitWords(t)) === t` is what the tests hold. */
export const joinWords = (parts: readonly WordPart[]): string =>
  parts.map((part) => ("word" in part ? part.word : part.space)).join("");

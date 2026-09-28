import { unicodeNfcData } from "./unicode-nfc-data.js";

const decomposition = new Map(unicodeNfcData.decomposition);
const combining = new Map(unicodeNfcData.combining);
const composition = new Map(unicodeNfcData.composition);

function decompose(code: number, output: number[]): void {
  if (code >= 0xac00 && code < 0xd7a4) {
    const offset = code - 0xac00;
    output.push(
      0x1100 + Math.floor(offset / 588),
      0x1161 + Math.floor((offset % 588) / 28),
    );
    if (offset % 28 !== 0) output.push(0x11a7 + (offset % 28));
    return;
  }
  const parts = decomposition.get(code);
  if (parts) for (const part of parts) decompose(part, output);
  else output.push(code);
}

function composePair(starter: number, code: number): number | undefined {
  if (
    starter >= 0x1100 &&
    starter < 0x1113 &&
    code >= 0x1161 &&
    code < 0x1176
  ) {
    return 0xac00 + (starter - 0x1100) * 588 + (code - 0x1161) * 28;
  }
  if (
    starter >= 0xac00 &&
    starter < 0xd7a4 &&
    (starter - 0xac00) % 28 === 0 &&
    code > 0x11a7 &&
    code < 0x11c3
  ) {
    return starter + code - 0x11a7;
  }
  return composition.get(starter * 0x110000 + code);
}

/** Unicode 15 NFC; never delegates normalization to the host's ICU version. */
export function normalizeNfc15(value: string): string {
  // Printable ASCII is already NFC; no decomposition or composition is needed.
  if (!/[^\u0020-\u007e]/u.test(value)) return value;
  const decomposed: number[] = [];
  for (const character of value)
    decompose(character.codePointAt(0) ?? 0, decomposed);
  const ordered: number[] = [];
  let marks: number[] = [];
  const flush = (): void => {
    marks.sort((a, b) => (combining.get(a) ?? 0) - (combining.get(b) ?? 0));
    for (const mark of marks) ordered.push(mark);
    marks = [];
  };
  for (const code of decomposed) {
    if ((combining.get(code) ?? 0) === 0) {
      flush();
      ordered.push(code);
    } else marks.push(code);
  }
  flush();
  const result: number[] = [];
  let starter = -1;
  let previousClass = 0;
  for (const code of ordered) {
    const currentClass = combining.get(code) ?? 0;
    const composed =
      starter >= 0 && (previousClass === 0 || previousClass < currentClass)
        ? composePair(result[starter], code)
        : undefined;
    if (composed !== undefined) result[starter] = composed;
    else {
      if (currentClass === 0) starter = result.length;
      result.push(code);
      previousClass = currentClass;
    }
  }
  return result.map((code) => String.fromCodePoint(code)).join("");
}

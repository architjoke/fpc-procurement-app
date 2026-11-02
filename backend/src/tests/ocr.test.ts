import { describe, expect, it } from 'vitest';
import { isOcrResultUsable, parseOcrNumber, parseOcrText } from '../services/ocr.js';

describe('OCR value parsing', () => {
  it('parses a clean number, a kg suffix, and decimal commas', () => {
    expect(parseOcrNumber('1250')).toBe(1250);
    expect(parseOcrNumber('1250 kg')).toBe(1250);
    expect(parseOcrNumber('12,5 kg')).toBe(12.5);
    expect(parseOcrText('1250')).toEqual({ parsedWeight: 1250 });
    expect(parseOcrText('12,5%')).toEqual({ parsedMoisture: 12.5 });
    expect(parseOcrText('Gross weight: 1250 kg\nMoisture: 12,5%')).toEqual({
      parsedWeight: 1250,
      parsedMoisture: 12.5,
    });
  });

  it('corrects common OCR character substitutions and ignores garbage input', () => {
    expect(parseOcrNumber('12O,5 kg')).toBe(120.5);
    expect(parseOcrNumber('not a measurement')).toBeUndefined();
    expect(parseOcrText('garbled content')).toEqual({});
    expect(parseOcrText('Moisture: 145%')).toEqual({});
  });

  it('requires sufficient confidence and at least one valid parsed reading', () => {
    expect(isOcrResultUsable(0.6, { parsedWeight: 100 })).toBe(true);
    expect(isOcrResultUsable(0.59, { parsedWeight: 100 })).toBe(false);
    expect(isOcrResultUsable(0.95, {})).toBe(false);
    expect(isOcrResultUsable(Number.NaN, { parsedMoisture: 12 })).toBe(false);
    expect(isOcrResultUsable(1.1, { parsedWeight: 100 })).toBe(false);
  });
});

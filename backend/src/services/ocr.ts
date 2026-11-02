import axios from 'axios';

export interface OcrProviderResult {
  rawText: string;
  parsedWeight?: number;
  parsedMoisture?: number;
  confidence: number;
}

export interface OcrProvider {
  parse(imageBuffer: Buffer): Promise<OcrProviderResult>;
}

const getImageType = (buffer: Buffer): { mimeType: string; extension: string } => {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (buffer.toString('ascii', 0, 3) === 'GIF') {
    return { mimeType: 'image/gif', extension: 'gif' };
  }
  return { mimeType: 'image/webp', extension: 'webp' };
};

export class OcrSpaceProvider implements OcrProvider {
  constructor(private readonly apiKey: string | undefined) {}

  async parse(imageBuffer: Buffer): Promise<OcrProviderResult> {
    if (!this.apiKey) {
      throw new Error('OCR_SPACE_API_KEY is not configured.');
    }

    const form = new FormData();
    form.append('apikey', this.apiKey);
    form.append('language', 'eng');
    form.append('isOverlayRequired', 'false');
    form.append('OCREngine', '2');
    const imageType = getImageType(imageBuffer);
    form.append(
      'file',
      new Blob([Uint8Array.from(imageBuffer)], { type: imageType.mimeType }),
      `upload.${imageType.extension}`,
    );

    try {
      const response = await axios.post('https://api.ocr.space/parse/image', form, {
        timeout: 20_000,
      });
      const parsed = response.data?.ParsedResults?.[0];
      if (response.data?.IsErroredOnProcessing || !parsed) {
        throw new Error('OCR.space could not process the uploaded image.');
      }

      const rawText = typeof parsed.ParsedText === 'string' ? parsed.ParsedText : '';
      return {
        rawText,
        confidence: response.data?.OCRExitCode === 1 && rawText.trim() ? 0.9 : 0.3,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'OCR.space could not process the uploaded image.'
      ) {
        throw error;
      }
      if (axios.isAxiosError(error)) {
        throw new Error('OCR.space service is unavailable.');
      }
      throw error;
    }
  }
}

export class MockOcrProvider implements OcrProvider {
  constructor(
    private readonly result: OcrProviderResult = { rawText: '', confidence: 0 },
    private readonly failure?: Error,
  ) {}

  async parse(_imageBuffer: Buffer): Promise<OcrProviderResult> {
    if (this.failure) {
      throw this.failure;
    }
    return this.result;
  }
}

export const createOcrProvider = (): OcrProvider =>
  process.env.OCR_PROVIDER === 'mock'
    ? new MockOcrProvider(
        {
          rawText: process.env.OCR_MOCK_TEXT ?? '',
          confidence: Number(process.env.OCR_MOCK_CONFIDENCE ?? 0),
        },
        process.env.OCR_MOCK_FAIL === 'true'
          ? new Error('Configured mock OCR failure.')
          : undefined,
      )
    : new OcrSpaceProvider(process.env.OCR_SPACE_API_KEY);

const numericPattern = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/;

export const parseOcrNumber = (rawValue: string): number | undefined => {
  const candidate = rawValue
    .trim()
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/(?:kilograms?|kgs?|kg|percent|pct|%)/gi, '')
    .replace(/\s/g, '');
  if (!numericPattern.test(candidate)) {
    return undefined;
  }

  const normalized =
    candidate.includes(',') && !candidate.includes('.')
      ? candidate.replace(',', '.')
      : candidate.replace(/,/g, '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
};

const findNumber = (line: string, expression: RegExp): number | undefined => {
  const match = expression.exec(line);
  return match?.[1] !== undefined ? parseOcrNumber(match[1]) : undefined;
};

export const parseOcrText = (
  rawText: string,
): { parsedWeight?: number; parsedMoisture?: number } => {
  let parsedWeight: number | undefined;
  let parsedMoisture: number | undefined;

  for (const line of rawText.split(/\r?\n/)) {
    if (parsedWeight === undefined) {
      parsedWeight =
        findNumber(line, /([0-9OoIl|]+(?:[.,][0-9OoIl|]+)?)\s*(?:kg|kgs|kilograms?)\b/i) ??
        findNumber(
          line,
          /(?:gross\s*)?(?:weight|wt)\s*[:= -]?\s*([0-9OoIl|]+(?:[.,][0-9OoIl|]+)?)/i,
        ) ??
        (/^[\s0-9OoIl|.,+-]+$/.test(line) ? parseOcrNumber(line) : undefined);
    }
    if (parsedMoisture === undefined) {
      parsedMoisture =
        findNumber(line, /([0-9OoIl|]+(?:[.,][0-9OoIl|]+)?)\s*%/) ??
        findNumber(line, /moisture\s*[:= -]?\s*([0-9OoIl|]+(?:[.,][0-9OoIl|]+)?)/i);
    }
  }

  return {
    ...(parsedWeight !== undefined && parsedWeight > 0 ? { parsedWeight } : {}),
    ...(parsedMoisture !== undefined && parsedMoisture >= 0 && parsedMoisture <= 100
      ? { parsedMoisture }
      : {}),
  };
};

export const isOcrResultUsable = (
  confidence: number,
  parsedValues: { parsedWeight?: number; parsedMoisture?: number },
  minimumConfidence = 0.6,
): boolean =>
  Number.isFinite(confidence) &&
  confidence <= 1 &&
  confidence >= minimumConfidence &&
  ((parsedValues.parsedWeight !== undefined &&
    Number.isFinite(parsedValues.parsedWeight) &&
    parsedValues.parsedWeight > 0) ||
    (parsedValues.parsedMoisture !== undefined &&
      Number.isFinite(parsedValues.parsedMoisture) &&
      parsedValues.parsedMoisture >= 0 &&
      parsedValues.parsedMoisture <= 100));

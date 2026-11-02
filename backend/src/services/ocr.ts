import axios from 'axios';
import type { Express } from 'express';

export interface OcrResult {
  weight: number | null;
  moisture: number | null;
  confidence: number;
  rawText: string;
  source: 'ocr.space' | 'fallback';
}

export interface OcrProvider {
  parseImage(file: Express.Multer.File): Promise<OcrResult>;
}

export class OcrSpaceProvider implements OcrProvider {
  constructor(private readonly apiKey: string | undefined) {}

  async parseImage(file: Express.Multer.File): Promise<OcrResult> {
    const apiKey = this.apiKey;
    if (!apiKey || !file?.buffer?.length) {
      return {
        weight: null,
        moisture: null,
        confidence: 0,
        rawText: 'OCR API key missing or no image provided.',
        source: 'fallback',
      };
    }

    try {
      const form = new FormData();
      const imageBuffer = Uint8Array.from(file.buffer);
      form.append('apikey', apiKey);
      form.append('language', 'eng');
      form.append('isOverlayRequired', 'false');
      form.append('OCREngine', '2');
      form.append(
        'file',
        new Blob([imageBuffer], { type: file.mimetype || 'image/jpeg' }),
        file.originalname || 'upload.jpg',
      );

      const response = await axios.post('https://api.ocr.space/parse/image', form, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      const parsed = response.data?.ParsedResults?.[0];
      const text = parsed?.ParsedText ?? 'No OCR text returned';
      const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*kg/i)].map((match) => Number(match[1]));
      const moistureMatches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/i)].map((match) =>
        Number(match[1]),
      );

      return {
        weight: matches[0] ?? null,
        moisture: moistureMatches[0] ?? null,
        confidence: parsed?.OCRExitCode === 1 ? 0.92 : 0.3,
        rawText: text,
        source: 'ocr.space',
      };
    } catch {
      return {
        weight: null,
        moisture: null,
        confidence: 0,
        rawText: 'OCR service unavailable. Enter values manually.',
        source: 'fallback',
      };
    }
  }
}

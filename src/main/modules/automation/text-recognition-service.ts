import type { AutomationCapturedFrame, AutomationOcrEngine, OcrTextItem, TextMatch } from './capability-contracts';

export type TextLocateRequest = {
  readonly text: string;
  readonly match: 'contains' | 'exact';
  readonly minScore: number;
};

export type TextDiagnosticMatch = TextMatch & {
  readonly matched: boolean;
  readonly textSimilarity: number;
};

export const AUTHORING_MIN_TEXT_SIMILARITY = .25;

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function editSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(current[rightIndex - 1] + 1, previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1));
    }
    previous.splice(0, previous.length, ...current);
  }
  return Math.max(0, 1 - previous[right.length] / Math.max(left.length, right.length));
}

function textSimilarity(text: string, query: string): number {
  if (text === query) return 1;
  if (text.includes(query) || query.includes(text)) return Math.min(text.length, query.length) / Math.max(text.length, query.length);
  return editSimilarity(text, query);
}

function toTextMatch(frame: AutomationCapturedFrame, item: OcrTextItem): TextMatch {
  const xs = item.box.map((point) => point[0]); const ys = item.box.map((point) => point[1]);
  const left = Math.min(...xs); const top = Math.min(...ys); const right = Math.max(...xs); const bottom = Math.max(...ys);
  return { text: item.text, x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top), score: item.score, frameGeometry: frame.geometry };
}

/** Browser-independent OCR semantics: locating text and reading values are distinct operations. */
export class AutomationTextRecognitionService {
  constructor(private readonly recognizer: AutomationOcrEngine) {}

  recognize(frame: AutomationCapturedFrame, signal: AbortSignal): Promise<OcrTextItem[]> {
    return this.recognizer.recognize(frame, signal);
  }

  async locate(frame: AutomationCapturedFrame, request: TextLocateRequest, signal: AbortSignal): Promise<TextMatch | null> {
    const items = await this.recognize(frame, signal);
    return this.locateRecognized(frame, items, request);
  }

  locateRecognized(
    frame: AutomationCapturedFrame,
    items: readonly OcrTextItem[],
    request: TextLocateRequest,
  ): TextMatch | null {
    const query = normalized(request.text);
    const candidates = items.filter((item) => {
      if (item.score < request.minScore) return false;
      const text = normalized(item.text);
      return request.match === 'exact' ? text === query : text.includes(query);
    });
    const best = candidates.sort((a, b) => b.score - a.score)[0];
    return best ? toTextMatch(frame, best) : null;
  }

  /** Closest OCR observation for authoring feedback, including a below-condition candidate. */
  locateBestRecognized(frame: AutomationCapturedFrame, items: readonly OcrTextItem[], request: TextLocateRequest): TextDiagnosticMatch | null {
    const query = normalized(request.text);
    const ranked = items.map((item) => {
      const text = normalized(item.text); const similarity = textSimilarity(text, query);
      const matched = item.score >= request.minScore && (request.match === 'exact' ? text === query : text.includes(query));
      return { item, similarity, matched };
    }).sort((left, right) => right.similarity - left.similarity || right.item.score - left.item.score);
    const best = ranked.find((candidate) => candidate.matched || candidate.similarity >= AUTHORING_MIN_TEXT_SIMILARITY);
    return best ? { ...toTextMatch(frame, best.item), matched: best.matched, textSimilarity: best.similarity } : null;
  }

  async readText(frame: AutomationCapturedFrame, signal: AbortSignal): Promise<string> {
    const items = await this.recognize(frame, signal);
    return items.map((item) => item.text.trim()).filter(Boolean).join(' ');
  }

  async readNumber(frame: AutomationCapturedFrame, signal: AbortSignal): Promise<number> {
    const text = await this.readText(frame, signal);
    const candidate = text.replace(/[,，\s]/g, '').match(/[-+]?\d+(?:\.\d+)?/u)?.[0];
    if (!candidate) throw new Error(`OCR result does not contain a number: ${text}`);
    const value = Number(candidate);
    if (!Number.isFinite(value)) throw new Error(`OCR number is not finite: ${candidate}`);
    return value;
  }
}

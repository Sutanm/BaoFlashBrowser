export type AutomationCaptureRect = { x: number; y: number; width: number; height: number };

export function previewRectToSource(
  rect: AutomationCaptureRect,
  preview: { width: number; height: number },
  source: { width: number; height: number },
): AutomationCaptureRect {
  if (preview.width <= 0 || preview.height <= 0 || source.width <= 0 || source.height <= 0) throw new Error('capture dimensions must be positive');
  if (rect.x < 0 || rect.y < 0 || rect.width < 2 || rect.height < 2 || rect.x + rect.width > preview.width || rect.y + rect.height > preview.height) {
    throw new Error('selected asset rectangle is outside the captured frame');
  }
  const scaleX = source.width / preview.width;
  const scaleY = source.height / preview.height;
  const x = Math.max(0, Math.floor(rect.x * scaleX));
  const y = Math.max(0, Math.floor(rect.y * scaleY));
  return {
    x, y,
    width: Math.min(source.width - x, Math.max(1, Math.ceil(rect.width * scaleX))),
    height: Math.min(source.height - y, Math.max(1, Math.ceil(rect.height * scaleY))),
  };
}

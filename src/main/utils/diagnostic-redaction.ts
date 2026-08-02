export function redactDiagnosticText(input: string, privatePaths: string[] = []): string {
  let output = input;
  for (const privatePath of privatePaths.filter(Boolean).sort((a, b) => b.length - a.length)) {
    output = output.split(privatePath).join('<PRIVATE_PATH>');
    output = output.split(privatePath.replace(/\\/g, '/')).join('<PRIVATE_PATH>');
  }

  output = output.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return '<REDACTED_URL>';
    }
  });
  output = output.replace(/((?:password|passwd|token|secret|authorization|cookie)\s*[:=]\s*)[^\s,;]+/gi, '$1<REDACTED>');
  return output;
}

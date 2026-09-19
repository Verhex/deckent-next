export function redactSensitive(value: string): string {
  return value.replace(/\b(?:sk-(?:ant-)?[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/(:\/\/[^:/?#\s]+:)[^@\s]+(@)/g, '$1[REDACTED]$2')
    .replace(/((?:[\w-]*(?:password|passwd|token|secret|api[_-]?key|private[_-]?key))["']?\s*(?:=|:|\s)\s*)["']?[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[REDACTED]');
}

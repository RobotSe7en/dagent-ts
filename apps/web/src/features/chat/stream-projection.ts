import type { RunEvent } from 'dagent-ai';

export function projectStreamedContent(content: string, event: RunEvent): string {
  if (event.type === 'token' && event.channel === 'content') return content + event.content;
  if (event.type === 'validation-finished' && event.willRetry) return '';
  if (event.type === 'run-completed' && event.outcome !== 'awaiting-review') return '';
  return content;
}

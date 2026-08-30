import type { DesktopRequest, DesktopResult } from '../shared/contracts.js';

export async function invoke<T>(request: DesktopRequest): Promise<T> {
  const result = (await window.dagentDesktop.invoke(request)) as DesktopResult<T>;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

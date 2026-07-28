export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

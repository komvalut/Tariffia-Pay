export function safeErrorMetadata(error: unknown): { errorName: string; errorCode?: string } {
  if (typeof error !== 'object' || error === null) return { errorName: 'UnknownError' };
  const value = error as { name?: unknown; code?: unknown };
  const errorName = typeof value.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.name)
    ? value.name
    : 'UnknownError';
  const errorCode = typeof value.code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(value.code)
    ? value.code
    : undefined;
  return { errorName, ...(errorCode ? { errorCode } : {}) };
}

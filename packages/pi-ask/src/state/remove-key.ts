/**
 * Remove a computed key from a record.
 *
 * `delete record[key]` is the obvious form, but the repo's ESLint config bans
 * it (`no-dynamic-delete`) so that every removal is visible as a named helper
 * rather than an operator that behaves differently on a proxy.
 */
export function removeKey<K extends string>(
  record: Partial<Record<K, unknown>>,
  key: K,
): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the one place the operator stays.
  delete record[key];
}

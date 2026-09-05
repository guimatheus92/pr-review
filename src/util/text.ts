/** Strip control characters before echoing third-party strings (pack files, provider payloads) to the terminal. */
export function printable(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, '');
}

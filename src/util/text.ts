/** Strip control characters before echoing third-party strings (pack files, provider payloads) to the terminal. */
export function printable(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, '');
}

const RUNTIME_SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{24,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\b[A-Za-z0-9]{75}AZDO[A-Za-z0-9]{5}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

const SENSITIVE_FIELD_SUFFIXES = [
  'authorization',
  'password',
  'passwd',
  'pwd',
  'clientsecret',
  'apikey',
  'accesstoken',
  'authtoken',
  'refreshtoken',
  'privatekey',
  'accountkey',
  'sharedaccesskey',
  'secretaccesskey',
  'accesskeyid',
  'subscriptionkey',
  'signature',
  'connectionstring',
  'setcookie',
  'cookie',
  'credential',
  'credentials',
  'secret',
  'token',
] as const;

const SENSITIVE_EXACT_FIELDS = new Set(['sig', 'signature']);
const KEY_TOKEN = String.raw`(?:[A-Za-z0-9_$.-]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4})){1,128}`;
const JSON_STRING_ASSIGNMENT_RE = new RegExp(
  `(["'])(${KEY_TOKEN})\\1(\\s*:\\s*)(["'])(?:\\\\.|(?!\\4)[\\s\\S])*?(?:\\4|$)`,
  'g',
);
const QUOTED_ASSIGNMENT_RE = /\b([A-Za-z_$][A-Za-z0-9_$.-]{0,127})(\s*[=:]\s*)(["'])(?:\\.|(?!\3)[\s\S])*?(?:\3|$)/g;
const UNQUOTED_ASSIGNMENT_RE = /\b([A-Za-z_$][A-Za-z0-9_$.-]{0,127})(\s*[=:]\s*)(?!["']|\[REDACTED\])([^\s,;]+)/g;
const ESCAPED_JSON_ASSIGNMENT_RE = new RegExp(
  `(\\\\")(${KEY_TOKEN})(\\\\")(\\s*:\\s*)(\\\\")([\\s\\S]*?)(?=\\\\"(?:[,}])|[\\r\\n]|$)`,
  'g',
);
const MAX_EMBEDDED_JSON_DEPTH = 16;
const MAX_EMBEDDED_JSON_CHARS = 1_048_576;
const PEM_BLOCK_HEADER_RE = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----/gi;

interface RedactionMetrics {
  pemHeaderSearches: number;
  pemFooterSearches: number;
  urlProtocolSearches: number;
  urlSchemeCharacters: number;
  urlAuthorityCharacters: number;
}

function redactPrivateKeyBlocks(value: string, metrics?: RedactionMetrics): string {
  let cursor = 0;
  let redacted = '';
  while (cursor < value.length) {
    if (metrics) metrics.pemHeaderSearches++;
    PEM_BLOCK_HEADER_RE.lastIndex = cursor;
    const header = PEM_BLOCK_HEADER_RE.exec(value);
    if (!header) return redacted + value.slice(cursor);
    redacted += value.slice(cursor, header.index) + '[REDACTED]';
    const footer = `-----END ${header[1]}-----`;
    if (metrics) metrics.pemFooterSearches++;
    const footerIndex = value.indexOf(footer, header.index + header[0].length);
    if (footerIndex < 0) return redacted;
    cursor = footerIndex + footer.length;
  }
  return redacted;
}

function redactUrlCredentials(value: string, metrics?: RedactionMetrics): string {
  let cursor = 0;
  let searchFrom = 0;
  let redacted = '';
  while (searchFrom < value.length) {
    if (metrics) metrics.urlProtocolSearches++;
    const protocol = value.indexOf('://', searchFrom);
    if (protocol < 0) break;
    let schemeStart = protocol;
    while (schemeStart > 0 && /[A-Za-z0-9+.-]/.test(value[schemeStart - 1]!)) {
      schemeStart--;
      if (metrics) metrics.urlSchemeCharacters++;
    }
    if (schemeStart === protocol || !/[A-Za-z]/.test(value[schemeStart]!)) {
      searchFrom = protocol + 3;
      continue;
    }
    const authorityStart = protocol + 3;
    let authorityEnd = authorityStart;
    while (authorityEnd < value.length && !/[\s/?#]/.test(value[authorityEnd]!)) {
      authorityEnd++;
      if (metrics) metrics.urlAuthorityCharacters++;
    }
    const at = value.lastIndexOf('@', authorityEnd - 1);
    const colon = value.indexOf(':', authorityStart);
    if (at >= authorityStart && colon >= authorityStart && colon < at) {
      redacted += value.slice(cursor, colon + 1) + '[REDACTED]';
      cursor = at;
    }
    searchFrom = Math.max(authorityEnd, protocol + 3);
  }
  return redacted + value.slice(cursor);
}

function decodeKeyToken(value: string): { decoded: string; unresolved: boolean } {
  let decoded = value;
  for (let pass = 0; pass < 16; pass++) {
    const next = decoded.replace(/\\u([0-9A-Fa-f]{4})|\\(["\\/bfnrt])/g, (_match, hex: string | undefined, escaped: string | undefined) => {
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      const controls: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      return controls[escaped ?? ''] ?? escaped ?? '';
    });
    if (next === decoded) return { decoded, unresolved: false };
    decoded = next;
  }
  return { decoded, unresolved: /\\(?:u[0-9A-Fa-f]{4}|["\\/bfnrt])/.test(decoded) };
}

function isSensitiveFieldName(value: string): boolean {
  const decoded = decodeKeyToken(value);
  if (decoded.unresolved) return true;
  const normalized = decoded.decoded
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase();
  return normalized.length > 0 && (
    SENSITIVE_EXACT_FIELDS.has(normalized) ||
    SENSITIVE_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function redactJsonValue(value: unknown, depth: number): { value: unknown; changed: boolean } {
  if (depth >= MAX_EMBEDDED_JSON_DEPTH) {
    const jsonLikeString = typeof value === 'string' && /^[{[]/.test(value.trim());
    return jsonLikeString || (value !== null && typeof value === 'object')
      ? { value: '[REDACTED]', changed: true }
      : { value, changed: false };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0 || !/^[{[]/.test(trimmed)) {
      return { value, changed: false };
    }
    if (trimmed.length > MAX_EMBEDDED_JSON_CHARS) return { value: '[REDACTED]', changed: true };
    try {
      const nested = redactJsonValue(JSON.parse(trimmed) as unknown, depth + 1);
      if (!nested.changed) return { value, changed: false };
      return { value: JSON.stringify(nested.value), changed: true };
    } catch {
      return { value, changed: false };
    }
  }
  if (Array.isArray(value)) {
    let changed = false;
    const redacted = value.map((entry) => {
      const nested = redactJsonValue(entry, depth + 1);
      changed ||= nested.changed;
      return nested.value;
    });
    return { value: changed ? redacted : value, changed };
  }
  if (!value || typeof value !== 'object') return { value, changed: false };
  let changed = false;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveFieldName(key)) {
      redacted[key] = '[REDACTED]';
      changed = entry !== '[REDACTED]' || changed;
      continue;
    }
    const nested = redactJsonValue(entry, depth + 1);
    redacted[key] = nested.value;
    changed ||= nested.changed;
  }
  return { value: changed ? redacted : value, changed };
}

function redactJsonText(value: string): string {
  try {
    const redacted = redactJsonValue(JSON.parse(value) as unknown, 0);
    return redacted.changed ? JSON.stringify(redacted.value) : value;
  } catch {
    return value.replace(/[^\r\n]+/g, (line) => {
      try {
        const redacted = redactJsonValue(JSON.parse(line) as unknown, 0);
        return redacted.changed ? JSON.stringify(redacted.value) : line;
      } catch {
        return line;
      }
    });
  }
}

/** Mask likely credential material without truncating or flattening the surrounding text. */
function redactRuntimeSecretsInternal(value: string, metrics?: RedactionMetrics): string {
  // Preserve CR/LF/TAB for the structured failure envelope, but remove other
  // controls before matching so `client\0Secret` cannot rejoin after redaction.
  let sanitized = redactPrivateKeyBlocks(
    redactJsonText(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')),
    metrics,
  )
    .replace(JSON_STRING_ASSIGNMENT_RE, (match, quote: string, key: string, separator: string, valueQuote: string) =>
      isSensitiveFieldName(key) ? `${quote}${key}${quote}${separator}${valueQuote}[REDACTED]${valueQuote}` : match)
    .replace(QUOTED_ASSIGNMENT_RE, (match, key: string, separator: string, quote: string) =>
      isSensitiveFieldName(key) ? `${key}${separator}${quote}[REDACTED]${quote}` : match)
    .replace(
      ESCAPED_JSON_ASSIGNMENT_RE,
      (match, openKey: string, key: string, closeKey: string, separator: string, openValue: string) =>
        isSensitiveFieldName(key)
          ? `${openKey}${key}${closeKey}${separator}${openValue}[REDACTED]`
          : match,
    )
    .replace(
      /\bAuthorization\s*([:=])\s*(?!\[REDACTED\])[^\r\n,;]+/gi,
      'Authorization$1[REDACTED]',
    );
  for (const pattern of RUNTIME_SECRET_PATTERNS) sanitized = sanitized.replace(pattern, '[REDACTED]');
  return redactUrlCredentials(sanitized, metrics)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
    .replace(/([?&](?:sig|signature)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(UNQUOTED_ASSIGNMENT_RE, (match, key: string, separator: string) =>
      isSensitiveFieldName(key) ? `${key}${separator}[REDACTED]` : match);
}

/** Mask likely credential material without truncating the surrounding text. */
export function redactRuntimeSecrets(value: string): string {
  return redactRuntimeSecretsInternal(value);
}

/** Deterministic scanner-work evidence for algorithmic regression tests. */
export function redactRuntimeSecretsWithMetrics(value: string): {
  value: string;
  metrics: Readonly<RedactionMetrics>;
} {
  const metrics: RedactionMetrics = {
    pemHeaderSearches: 0,
    pemFooterSearches: 0,
    urlProtocolSearches: 0,
    urlSchemeCharacters: 0,
    urlAuthorityCharacters: 0,
  };
  return { value: redactRuntimeSecretsInternal(value, metrics), metrics };
}

/** Preserve an actionable runtime signature while masking likely credential material. */
export function safeRuntimeDiagnostic(value: string, maxLength = 1_000): string | undefined {
  const sanitized = printable(redactRuntimeSecrets(value)).replace(/\s+/g, ' ').trim();
  return sanitized ? sanitized.slice(0, maxLength) : undefined;
}

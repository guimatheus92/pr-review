const DEFAULT_PR = {
  provider: 'github',
  url: 'https://github.com/pr-review/eval/pull/1',
  owner: 'pr-review',
  repo: 'eval',
  number: 1,
};

function decodeGitQuotedPath(raw) {
  const bytes = [];
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === '\\') {
      const escaped = raw[++index];
      if (escaped === undefined) throw new Error('unterminated escape in quoted diff path');
      if (/[0-7]/.test(escaped)) {
        let octal = escaped;
        while (octal.length < 3 && /[0-7]/.test(raw[index + 1] ?? '')) octal += raw[++index];
        bytes.push(Number.parseInt(octal, 8));
      } else if (Object.hasOwn(escapes, escaped)) {
        bytes.push(escapes[escaped]);
      } else {
        bytes.push(...Buffer.from(escaped, 'utf8'));
      }
      continue;
    }
    const codePoint = raw.codePointAt(index);
    const value = String.fromCodePoint(codePoint);
    bytes.push(...Buffer.from(value, 'utf8'));
    if (codePoint > 0xffff) index++;
  }
  return Buffer.from(bytes).toString('utf8');
}

function readQuotedToken(input, start) {
  let raw = '';
  for (let index = start + 1; index < input.length; index++) {
    const char = input[index];
    if (char === '"') return { value: decodeGitQuotedPath(raw), end: index + 1 };
    if (char === '\\') {
      raw += char;
      if (index + 1 >= input.length) break;
      raw += input[++index];
    } else {
      raw += char;
    }
  }
  throw new Error('unterminated quoted path in `diff --git` header');
}

function parseDiffHeader(header) {
  let previousPath;
  let path;
  if (header.startsWith('"')) {
    const previous = readQuotedToken(header, 0);
    let next = previous.end;
    while (header[next] === ' ') next++;
    if (header[next] !== '"') throw new Error('invalid quoted `diff --git` header');
    const current = readQuotedToken(header, next);
    if (header.slice(current.end).trim()) throw new Error('unexpected suffix in `diff --git` header');
    previousPath = previous.value;
    path = current.value;
  } else {
    const match = header.match(/^a\/(.+?) b\/(.+)$/);
    if (!match) throw new Error('invalid `diff --git` header');
    previousPath = `a/${match[1]}`;
    path = `b/${match[2]}`;
  }
  if (!previousPath.startsWith('a/') || !path.startsWith('b/')) throw new Error('diff paths must use a/ and b/ prefixes');
  const decoded = { previousPath: previousPath.slice(2), path: path.slice(2) };
  if (/[\u0000-\u001f\u007f]/.test(decoded.previousPath) || /[\u0000-\u001f\u007f]/.test(decoded.path)) {
    throw new Error('diff path contains control characters');
  }
  return decoded;
}

export function gatherFromPatch(patchText, overrides = {}) {
  const files = [];
  const fileRe = /^diff --git (.+)$/gm;
  const starts = [];
  let match;
  while ((match = fileRe.exec(patchText)) !== null) {
    starts.push({ ...parseDiffHeader(match[1]), index: match.index });
  }
  if (starts.length === 0) throw new Error('diff has no `diff --git` headers');

  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    const chunk = patchText.slice(start.index, starts[index + 1]?.index ?? patchText.length);
    const hunkStart = chunk.indexOf('@@');
    const patch = hunkStart === -1 ? chunk : chunk.slice(hunkStart);
    const additions = (patch.match(/^\+(?!\+\+)/gm) ?? []).length;
    const deletions = (patch.match(/^-(?!--)/gm) ?? []).length;
    let status = 'modified';
    if (/\nnew file mode /.test(chunk)) {
      status = 'added';
    } else if (/\ndeleted file mode /.test(chunk)) {
      status = 'deleted';
    } else if (/\nrename from /.test(chunk)) {
      status = 'renamed';
    }
    files.push({
      path: start.path,
      ...(status === 'renamed' ? { previousPath: start.previousPath } : {}),
      status,
      additions,
      deletions,
      patch: patch.trimEnd(),
    });
  }

  const now = new Date().toISOString();
  const pr = { ...DEFAULT_PR, ...(overrides.pr ?? {}) };
  return {
    pr,
    metadata: {
      title: overrides.title ?? 'Eval fixture PR',
      description: overrides.description ?? 'Synthetic PR generated from a fixture diff.',
      author: overrides.author ?? 'eval-harness',
      headSha: overrides.headSha ?? 'e'.repeat(40),
      baseSha: overrides.baseSha ?? 'b'.repeat(40),
      baseBranch: overrides.baseBranch ?? 'main',
      headBranch: overrides.headBranch ?? 'eval-fixture',
      labels: [],
      linkedItems: [],
      createdAt: now,
      updatedAt: now,
      isDraft: true,
      state: 'open',
    },
    changedFiles: files,
    existingComments: [],
    gatheredAt: now,
  };
}
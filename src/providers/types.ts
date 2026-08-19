import type { ChangedFile, ExistingComment, Finding, PrMetadata, PrRef, Provider } from '../types.js';

export interface BatchComment {
  path: string;
  line: number;
  body: string;
}

export interface PrProvider {
  readonly name: Provider;
  /**
   * Resolve auth in this (foreground) process and return env var(s) that let a
   * child process skip the CLI/keyring fallbacks (used by the --detach
   * pre-flight). Throws when no credential is available. `ref` is required so
   * auth is host-scoped by construction — an optional ref would let a caller
   * silently resolve a github.com token for an enterprise host.
   */
  authEnv(ref: PrRef): Record<string, string>;
  parseUrl(url: string): PrRef | null;
  fetchMetadata(ref: PrRef): Promise<PrMetadata>;
  fetchChangedFiles(ref: PrRef): Promise<ChangedFile[]>;
  fetchFullDiff(ref: PrRef): Promise<string>;
  /**
   * Existing comments on the PR. `since`, when given, asks the provider to
   * return only comments created/updated at or after it: the reconciliation
   * read-backs care only about the current run, and pulling a long-lived PR's
   * whole comment history on every failed write competes for the same rate
   * limit as the retry it exists to make safe. Providers that cannot filter
   * server-side may ignore it — callers filter client-side regardless.
   */
  fetchExistingComments(ref: PrRef, since?: Date): Promise<ExistingComment[]>;
  /**
   * Post ONE inline comment. Like `postBatchComments`, makes a single attempt
   * and throws: creating a comment is not idempotent, so a 5xx or timeout that
   * arrives after the server committed it must not be re-issued blind. runPost
   * retries only after reconciling against the PR.
   *
   * headSha avoids a per-finding PR re-fetch; providers fall back to fetching
   * it once when absent.
   */
  postLineComment(ref: PrRef, finding: Finding, headSha?: string): Promise<{ id: string } | null>;
  /**
   * Post many inline comments in one API call (one review). Optional —
   * providers without a batch endpoint omit it and the poster falls back to
   * per-comment posting. Makes ONE attempt and throws on failure: retrying a
   * non-idempotent write is only safe after reconciling against the PR, which
   * the caller does and the provider cannot.
   *
   * Returns ONLY when every comment landed. Any shortfall must throw — a
   * partial count would strand the difference in neither the posted tally nor
   * the retry set, silently breaking `posted + errors === attempted`.
   */
  postBatchComments?(ref: PrRef, headSha: string, comments: BatchComment[]): Promise<{ posted: number }>;
  /**
   * Is this error worth another attempt? Exposes each provider's existing
   * transient-error predicate so the poster can decide whether to re-issue a
   * write, instead of guessing from an opaque Error.
   *
   * Required, not optional: `postLineComment` and `postBatchComments` make one
   * attempt by contract, so a provider that cannot classify its own errors
   * would silently get no retry at all. The compiler enforces here what the
   * add-provider checklist would otherwise have to remember.
   */
  isTransientError(err: Error): boolean;
}

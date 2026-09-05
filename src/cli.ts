import { Command } from 'commander';
import { runGather } from './commands/gather.js';
import { runReview } from './commands/review.js';
import { runPost } from './commands/post.js';
import { runInit } from './commands/init.js';
import { runConfigureQuick, runConfigureInteractive } from './commands/configure.js';
import { showCacheInfo, clearCacheCommand } from './commands/cache.js';
import { pluginsList, pluginsDoctor } from './commands/plugins.js';
import { showConfig } from './commands/config.js';
import { readFileSync } from 'node:fs';
import { RUNTIME_CHOICES, type RuntimeChoice } from './dispatch/runtime.js';
import type { GatherOutput, ReviewerOutput, Severity } from './types.js';

// Injected by scripts/bundle.mjs from package.json; dev runs via tsx see the fallback.
declare const __PR_REVIEW_VERSION__: string | undefined;

/** Grace period before a failing command stops waiting for stragglers. */
const FATAL_EXIT_GRACE_MS = 3000;

/**
 * Exit a failed command without either of the two traps a bare `process.exit()`
 * or a bare `process.exitCode` falls into.
 *
 * `process.exit()` aborts the process on Windows when undici's keep-alive handle
 * is still closing — `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
 * src\win\async.c` — turning a clean exit 2 into exit 127 and a C-level crash
 * message. Both `review` and `post` reach their catch straight after a live
 * provider read, so both hit it.
 *
 * Plain `process.exitCode` avoids that but waits for every ref'd handle, and the
 * pipeline can leave one behind: if the review throws after the Codex sibling was
 * spawned, that child and its 15-minute SIGKILL timer are never awaited, so the
 * CLI would sit there for a quarter of an hour — and, worse, a detached run's
 * `run.pid` stays alive, so `status` keeps reporting `running` instead of the
 * failure it already wrote to error.txt.
 *
 * So: set the code, let the loop drain normally (the fast, clean path), and keep
 * an unref'd backstop that forces the exit if something is still holding on. By
 * then the socket that caused the assertion is long closed.
 */
function fatalExit(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), FATAL_EXIT_GRACE_MS).unref();
}

const program = new Command();

program
  .name('pr-review')
  .description('Generic, plugin-based PR review for GitHub, Azure DevOps, and GitLab via Copilot CLI or Claude Code')
  .version(typeof __PR_REVIEW_VERSION__ === 'string' ? __PR_REVIEW_VERSION__ : '0.0.0-dev');

program
  .command('gather <pr-url>')
  .description('Fetch PR metadata, diff, files, and existing comments; write to a JSON file (default: ~/.pr-review/runs/...)')
  .option('--out <path>', 'Where to write the gather JSON (default goes under ~/.pr-review/runs/)')
  .option('--no-cache', 'Bypass the gather cache')
  .action(async (prUrl: string, opts: { out?: string; cache: boolean }) => {
    try {
      let outPath = opts.out;
      if (!outPath) {
        const { ensureRunDir } = await import('./util/tmp.js');
        const { resolvePr } = await import('./providers/index.js');
        const { ref } = resolvePr(prUrl);
        outPath = `${ensureRunDir(ref)}/pr-review-gather.json`;
      }
      await runGather({ prUrl, outPath, useCache: opts.cache });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('review <pr-url>')
  .description('Run the full review pipeline in parallel; print/post findings')
  .option('--dry-run', 'Preview findings without posting comments (posting is the default)', false)
  .option('--publish', '(deprecated: posting is now the default; use --dry-run to preview)', false)
  .option('--skip <names>', 'Comma-separated pass names to skip (full pack/skill or bare skill name; also: verifier, codex)')
  .option('--reviewer <path...>', 'Include a specific .md file as a reviewer (repeatable)')
  .option('--reviewers-dir <path...>', 'Include a directory of reviewer .md files (repeatable)')
  .option('--skill <path...>', 'Include a specific .md skill; its applyTo/paths scope still applies (repeatable)')
  .option('--force-skill <path...>', 'Include a .md skill file, or every rule the loader recognizes under a directory, in every pass regardless of scope, relevance or rule trust (repeatable; the only bypass, per run)')
  .option('--skills-dir <path...>', 'Include a directory of skill .md files, selected like a repo skill dir: targeting and relevance apply, PR-changed files are skipped (repeatable)')
  .option('--plugin <name...>', 'Named plugin to include (resolves from node_modules)')
  .option('--plugin-dir <path...>', 'Packaged plugin directory (has plugin.yaml)')
  .option('--no-autodiscover', 'Disable scanning the standard skill dirs (.claude/.copilot/.github/.agents under skills/, repo + home)')
  .option('--dedupe-mode <mode>', "Dedupe mode: strict | loose | off", 'strict')
  .option('--default-model <model>', 'Default model for reviewers without an explicit one')
  .option('--copilot <path>', 'Path to the copilot CLI binary (implies --runtime copilot unless --runtime is given)')
  .option('--no-cache', 'Bypass gather cache')
  .option('--no-companion-warning', 'Suppress the companion-plugin install warning')
  .option(
    '--no-companions',
    'Skip auto-invoking installed companion plugin agents (pr-review-toolkit) for this run',
  )
  .option('--context-only', 'Prepare pr-context.md + the pass files, print the stack + pass table, and exit', false)
  .option('--lang <code>', 'Language for finding titles/bodies (e.g. pt-BR, es)')
  .option('--fail-on <severity>', 'Exit 1 when any finding at/above this severity survives dedupe (critical|high|medium|low|nit)')
  .option('--runtime <name>', 'Agent CLI hosting the session: copilot | claude | auto (probe PATH)', undefined)
  .option('--no-codex', 'Never run the Codex second-opinion reviewer, even when the codex CLI is installed')
  .option('--resume <run-id>', 'Resume a prior run: reuse its reviewer outputs on disk, skip dispatch, then dedupe + post')
  .option('--detach', 'Start the review in the background, print a run-id, and return immediately (poll with `status <run-id>`)', false)
  .option('--force-post', 'Re-post even if this run already recorded a successful post (bypasses the posted.marker idempotency guard)', false)
  .option('--run-dir <path>', 'Internal: use this exact run dir (set by --detach)')
  .option('--from-gather <path>', 'Internal (eval harness): read the gather JSON from a file instead of the provider APIs; requires --dry-run')
  .action(
    async (
      prUrl: string,
      opts: {
        dryRun: boolean;
        publish: boolean;
        skip?: string;
        reviewer?: string[];
        reviewersDir?: string[];
        skill?: string[];
        forceSkill?: string[];
        skillsDir?: string[];
        plugin?: string[];
        pluginDir?: string[];
        autodiscover: boolean;
        dedupeMode: 'strict' | 'loose' | 'off';
        defaultModel?: string;
        copilot: string;
        cache: boolean;
        companionWarning: boolean;
        companions: boolean;
        contextOnly: boolean;
        lang?: string;
        failOn?: string;
        runtime?: string;
        codex: boolean;
        resume?: string;
        detach: boolean;
        forcePost: boolean;
        runDir?: string;
        fromGather?: string;
      },
    ) => {
      try {
        const skip = opts.skip?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
        if (opts.runtime && !(RUNTIME_CHOICES as string[]).includes(opts.runtime)) {
          console.error(`--runtime must be one of: ${RUNTIME_CHOICES.join(', ')}`);
          process.exit(2);
        }
        let failOn: Severity | undefined;
        if (opts.failOn) {
          const norm = opts.failOn.toUpperCase();
          const allowed: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NIT'];
          if (!(allowed as string[]).includes(norm)) {
            console.error(`--fail-on must be one of: ${allowed.join(', ').toLowerCase()}`);
            process.exit(2);
          }
          failOn = norm as Severity;
        }
        // Background mode: spawn a detached child that runs the review, and
        // return a run-id the caller can poll. Resume/context-only are already
        // fast/foreground, so --detach is a no-op for them.
        if (opts.detach && !opts.resume && !opts.contextOnly) {
          const { detachReview } = await import('./commands/detach.js');
          const { runId, outDir } = detachReview(prUrl, process.argv.slice(2));
          process.stdout.write(
            `Review started in the background (this can take ~6–10 min).\n` +
              `  run-id: ${runId}\n  dir:    ${outDir}\n\n` +
              `Poll for progress and the final summary:\n  pr-review status ${runId}\n`,
          );
          return;
        }
        const { summary, exitCode } = await runReview({
          prUrl,
          skip,
          reviewers: opts.reviewer,
          reviewersDirs: opts.reviewersDir,
          skills: opts.skill,
          forceSkills: opts.forceSkill,
          skillsDirs: opts.skillsDir,
          plugins: opts.plugin,
          pluginDirs: opts.pluginDir,
          dryRun: opts.dryRun,
          publish: !opts.dryRun && !opts.contextOnly,
          copilotBinary: opts.copilot,
          useCache: opts.cache,
          autodiscover: opts.autodiscover,
          dedupeMode: opts.dedupeMode,
          defaultModel: opts.defaultModel,
          noCompanionWarning: !opts.companionWarning,
          withCompanions: opts.companions,
          contextOnly: opts.contextOnly,
          language: opts.lang,
          failOn,
          runtime: opts.runtime as RuntimeChoice | undefined,
          withCodex: opts.codex ? undefined : false,
          resumeRunId: opts.resume,
          runDir: opts.runDir,
          forcePost: opts.forcePost,
          fromGather: opts.fromGather,
        });
        process.stdout.write(summary + '\n');
        if (exitCode !== 0) process.exitCode = exitCode;
      } catch (err) {
        // Detached child (--run-dir set): persist the failure so `status` can
        // say why — the parent is long gone and stdout goes to detached.log.
        if (opts.runDir && !(err as { preserveRunState?: boolean }).preserveRunState) {
          try {
            const { writeFileSync } = await import('node:fs');
            const { join } = await import('node:path');
            const { ERROR_FILE } = await import('./util/tmp.js');
            writeFileSync(join(opts.runDir, ERROR_FILE), ((err as Error).stack ?? String(err)) + '\n');
          } catch {
            // best-effort: the real error is about to be printed and exit(2)'d
          }
        }
        console.error((err as Error).message);
        fatalExit(2);
      }
    },
  );

program
  .command('post <pr-url>')
  .description('Post pre-computed findings (from a JSON file) as line comments')
  .requiredOption('--findings <path>', 'Path to a findings.json file produced by `review`')
  .option('--dry-run', 'Show what would be posted without posting (posting is the default)', false)
  .option('--publish', '(deprecated: posting is now the default; use --dry-run to preview)', false)
  .action(async (prUrl: string, opts: { findings: string; dryRun: boolean; publish: boolean }) => {
    try {
      const raw = JSON.parse(readFileSync(opts.findings, 'utf8')) as { reviewers?: Array<{ reviewer: string; model: string; findings: ReviewerOutput['findings'] }>; finalFindings?: ReviewerOutput['findings'] } | Array<{ reviewer: string; model: string; findings: ReviewerOutput['findings'] }>;
      let outputs: ReviewerOutput[];
      if (Array.isArray(raw)) {
        outputs = raw.map((r) => ({
          reviewerName: r.reviewer,
          model: r.model,
          findings: r.findings,
          rawOutput: '',
          durationMs: 0,
          exitCode: 0,
        }));
      } else if (raw.finalFindings) {
        outputs = [
          {
            reviewerName: 'merged',
            model: '(multi)',
            findings: raw.finalFindings,
            rawOutput: '',
            durationMs: 0,
            exitCode: 0,
          },
        ];
      } else {
        outputs = (raw.reviewers ?? []).map((r) => ({
          reviewerName: r.reviewer,
          model: r.model,
          findings: r.findings,
          rawOutput: '',
          durationMs: 0,
          exitCode: 0,
        }));
      }
      // Line snapping needs the diff; without it, findings citing lines
      // outside the diff 422 on the batch and burn retries per comment.
      let gather: GatherOutput | undefined;
      try {
        gather = await runGather({ prUrl });
      } catch (err) {
        process.stderr.write(
          `[post] gather failed (${(err as Error).message.split('\n')[0]}); posting without line snapping\n`,
        );
      }
      await runPost({ prUrl, outputs, publish: !opts.dryRun, gather });
    } catch (err) {
      console.error((err as Error).message);
      fatalExit(1);
    }
  });

program
  .command('status <run-id>')
  .description('Show a background review’s live progress, or its summary once done (poll target for --detach). Exit: 0 done, 20 running, 21 interrupted (resume it), 22 failed, 1 missing.')
  .action(async (runId: string) => {
    try {
      const { runStatus, statusExitCode } = await import('./commands/status.js');
      const r = runStatus(runId);
      process.stdout.write(r.text + '\n');
      if (r.state === 'done') {
        const { RUNS_ROOT } = await import('./util/tmp.js');
        const { join } = await import('node:path');
        // stderr, so stdout stays the verbatim summary. Agents polling through
        // a truncating channel (background notifications) re-read this file.
        process.stderr.write(`summary file: ${join(RUNS_ROOT, runId, 'pr-review-summary.md')}\n`);
      }
      process.exit(statusExitCode(r.state));
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('verify [run-id]')
  .description(
    'Audit a finished run against INVARIANTS.md: one PASS/FAIL/SKIP row per invariant, from the run artifacts plus a live read of the PR. Read-only. Exit: 0 clean, 2 any FAIL.',
  )
  .option('--pr <url>', 'Audit the most recent run for this PR instead of naming a run-id')
  .option('--offline', 'Skip the live PR read-back; every invariant that needs it reports SKIP', false)
  .option('--json', 'Emit the rows as JSON for CI', false)
  .option('--home <path>', 'Internal: treat this directory as HOME when locating runs and control state')
  .action(async (runId: string | undefined, opts: { pr?: string; offline: boolean; json: boolean; home?: string }) => {
    try {
      const { runVerify } = await import('./commands/verify.js');
      const exitCode = await runVerify({
        runId,
        prUrl: opts.pr,
        offline: opts.offline,
        json: opts.json,
        home: opts.home,
      });
      if (exitCode !== 0) process.exitCode = exitCode;
    } catch (err) {
      console.error((err as Error).message);
      // Reads a live provider like `review` and `post` do, so it inherits the
      // Windows keep-alive-handle trap that a bare process.exit() falls into.
      fatalExit(1);
    }
  });

program
  .command('init')
  .description('Scaffold a starter review skill (.claude/skills/team-rules.md) in the current repo')
  .option('--force', 'Overwrite existing files', false)
  .option('--with-config', 'Also write a starter .pr-review.yaml', false)
  .action((opts: { force: boolean; withConfig: boolean }) => {
    try {
      const result = runInit({ force: opts.force, withConfig: opts.withConfig });
      for (const d of result.createdDirs) console.error(`created ${d}`);
      for (const f of result.createdFiles) console.error(`created ${f}`);
      for (const f of result.skippedFiles) console.error(`skipped (exists) ${f}`);
      console.error('\nEdit .claude/skills/team-rules.md to add your team conventions.');
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('configure [path]')
  .description('Write ~/.pr-review/config.yaml. With a path, adds it to extra_skills_dirs (selected like repo skill dirs); without, runs interactive prompts.')
  .option('--force', 'Overwrite existing entries', false)
  .action(async (path: string | undefined, opts: { force: boolean }) => {
    try {
      if (path) {
        runConfigureQuick(path, { force: opts.force });
      } else {
        await runConfigureInteractive();
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

const plugins = program.command('plugins').description('Inspect installed reviewers, skills, and companion plugins');
plugins
  .command('list')
  .description('List every reviewer and skill that would be loaded for the current cwd')
  .option('--reviewers-dir <path...>', 'Extra reviewer directories to include')
  .option('--skills-dir <path...>', 'Extra skill directories to include (selected, not forced)')
  .action(async (opts: { reviewersDir?: string[]; skillsDir?: string[] }) => {
    try {
      await pluginsList(opts);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
plugins
  .command('doctor')
  .description('Check for missing companion plugins (pr-review-toolkit, code-review)')
  .option('--copilot <path>', 'Path to the copilot binary', 'copilot')
  .action(async (opts: { copilot: string }) => {
    try {
      await pluginsDoctor(opts.copilot);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

const packs = program.command('packs').description('Manage the external skill packs that supply the review passes');
packs
  .command('list')
  .description('Show configured packs: on-disk state, skill counts, commit, freshness')
  .action(async () => {
    try {
      const { packsList } = await import('./commands/packs.js');
      packsList();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
packs
  .command('sync')
  .description('Clone or pull every configured pack and refresh the Linguist language data')
  .action(async () => {
    try {
      const { packsSync } = await import('./commands/packs.js');
      process.exitCode = await packsSync();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
packs
  .command('add <source>')
  .description('Add a pack (owner/repo, git URL, or local path) to the global config and clone it')
  .action(async (source: string) => {
    try {
      const { packsAdd } = await import('./commands/packs.js');
      process.exitCode = packsAdd(source);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
packs
  .command('suggest <args...>')
  .description('Search skills.sh for skills matching stack tags (or the stack of a PR URL). Suggest-only — never installs.')
  .action(async (args: string[]) => {
    try {
      const { packsSuggest } = await import('./commands/packs.js');
      let tags = args;
      if (args.length === 1 && /^https?:\/\//.test(args[0]!)) {
        const { loadLinguist } = await import('./stack/linguist.js');
        const { detectStack } = await import('./stack/detect.js');
        const gather = await runGather({ prUrl: args[0]!, useCache: true });
        const linguist = await loadLinguist({});
        const stack = detectStack(
          gather.changedFiles.filter((f) => !f.excluded),
          { linguist, cwd: process.cwd(), pr: gather.pr },
        );
        // Query languages + ecosystems, not every dependency — a query per dep would spam the API.
        const deps = new Set(stack.dependencies);
        tags = stack.tags.filter((t) => !deps.has(t)).slice(0, 8);
        if (tags.length === 0) {
          console.error('no stack tags detected for that PR — pass tags explicitly (e.g. `packs suggest python django`)');
          process.exit(1);
        }
      }
      process.exitCode = await packsSuggest(tags);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Environment preflight: runtimes, codex, companions, provider auth, effective config')
  .action(async () => {
    try {
      const { runDoctor } = await import('./commands/doctor.js');
      process.exitCode = await runDoctor();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
  });

const config = program.command('config').description('Inspect the effective configuration');
config
  .command('show')
  .description('Print the merged effective config + source of each setting')
  .action(() => {
    try {
      showConfig();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

const cache = program.command('cache').description('Manage the local cache');
cache
  .command('info')
  .description('Print cache location and size')
  .action(() => showCacheInfo());
cache
  .command('clear')
  .description('Clear cache entries')
  .option('--pr <url>', 'Clear cache only for one PR')
  .option('--all', 'Clear all caches', false)
  .action((opts: { pr?: string; all: boolean }) => {
    try {
      clearCacheCommand({ prUrl: opts.pr, all: opts.all });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});

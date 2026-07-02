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
import type { ReviewerOutput, Severity } from './types.js';

const program = new Command();

program
  .name('pr-review')
  .description('Generic, plugin-based PR review for GitHub and Azure DevOps via Copilot CLI')
  .version('0.1.0');

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
        const { detectProvider } = await import('./providers/index.js');
        const provider = detectProvider(prUrl);
        const ref = provider.parseUrl(prUrl);
        outPath = `${ensureRunDir(ref ?? undefined)}/pr-review-gather.json`;
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
  .option('--dry-run', 'Do not post comments (default unless --publish given)', false)
  .option('--publish', 'Post findings as line comments on the PR', false)
  .option('--skip <names>', 'Comma-separated reviewer names to skip')
  .option('--reviewer <path...>', 'Include a specific .md file as a reviewer (repeatable)')
  .option('--reviewers-dir <path...>', 'Include a directory of reviewer .md files (repeatable)')
  .option('--skill <path...>', 'Include a specific .md file as a skill (repeatable)')
  .option('--skills-dir <path...>', 'Include a directory of skill .md files (repeatable)')
  .option('--plugin <name...>', 'Named plugin to include (resolves from node_modules)')
  .option('--plugin-dir <path...>', 'Packaged plugin directory (has plugin.yaml)')
  .option('--no-autodiscover', 'Disable scanning .pr-review/ conventional paths')
  .option('--dedupe-mode <mode>', "Dedupe mode: strict | loose | off", 'strict')
  .option('--default-model <model>', 'Default model for reviewers without an explicit one')
  .option('--copilot <path>', 'Path to the runtime CLI binary (copilot or claude)')
  .option('--no-cache', 'Bypass gather cache')
  .option('--no-response-cache', 'Bypass per-reviewer response cache')
  .option('--no-companion-warning', 'Suppress the companion-plugin install warning')
  .option(
    '--no-companions',
    'Skip auto-invoking installed companion plugin agents (pr-review-toolkit) for this run',
  )
  .option('--context-only', 'Prepare pr-context.md + per-reviewer skills files, print the skill routing, and exit', false)
  .option('--lang <code>', 'Language for finding titles/bodies (e.g. pt-BR, es)')
  .option('--fail-on <severity>', 'Exit 1 when any finding at/above this severity survives dedupe (critical|high|medium|low|nit)')
  .option('--runtime <name>', 'Agent CLI hosting the session: copilot | claude | auto (probe PATH)', undefined)
  .option('--no-codex', 'Never run the Codex second-opinion reviewer, even when the codex CLI is installed')
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
        skillsDir?: string[];
        plugin?: string[];
        pluginDir?: string[];
        autodiscover: boolean;
        dedupeMode: 'strict' | 'loose' | 'off';
        defaultModel?: string;
        copilot: string;
        cache: boolean;
        responseCache: boolean;
        companionWarning: boolean;
        companions: boolean;
        contextOnly: boolean;
        lang?: string;
        failOn?: string;
        runtime?: string;
        codex: boolean;
      },
    ) => {
      try {
        const skip = opts.skip?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
        if (opts.runtime && !['copilot', 'claude', 'auto'].includes(opts.runtime)) {
          console.error(`--runtime must be one of: copilot, claude, auto`);
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
        const { summary, exitCode } = await runReview({
          prUrl,
          skip,
          reviewers: opts.reviewer,
          reviewersDirs: opts.reviewersDir,
          skills: opts.skill,
          skillsDirs: opts.skillsDir,
          plugins: opts.plugin,
          pluginDirs: opts.pluginDir,
          dryRun: opts.dryRun || !opts.publish,
          publish: opts.publish,
          copilotBinary: opts.copilot,
          useCache: opts.cache,
          useResponseCache: opts.responseCache,
          autodiscover: opts.autodiscover,
          dedupeMode: opts.dedupeMode,
          defaultModel: opts.defaultModel,
          noCompanionWarning: !opts.companionWarning,
          withCompanions: opts.companions,
          contextOnly: opts.contextOnly,
          language: opts.lang,
          failOn,
          runtime: opts.runtime as 'copilot' | 'claude' | 'auto' | undefined,
          withCodex: opts.codex ? undefined : false,
        });
        process.stdout.write(summary + '\n');
        if (exitCode !== 0) process.exitCode = exitCode;
      } catch (err) {
        console.error((err as Error).message);
        process.exit(2);
      }
    },
  );

program
  .command('post <pr-url>')
  .description('Post pre-computed findings (from a JSON file) as line comments')
  .requiredOption('--findings <path>', 'Path to a findings.json file produced by `review`')
  .option('--dry-run', 'Show what would be posted without posting', false)
  .option('--publish', 'Actually post the comments', false)
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
      await runPost({ prUrl, outputs, publish: opts.publish && !opts.dryRun });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Scaffold .pr-review/skills/ in the current repo')
  .option('--force', 'Overwrite existing files', false)
  .option('--with-config', 'Also write a starter .pr-review.yaml', false)
  .action((opts: { force: boolean; withConfig: boolean }) => {
    try {
      const result = runInit({ force: opts.force, withConfig: opts.withConfig });
      for (const d of result.createdDirs) console.error(`created ${d}`);
      for (const f of result.createdFiles) console.error(`created ${f}`);
      for (const f of result.skippedFiles) console.error(`skipped (exists) ${f}`);
      if (result.detectedStack) {
        console.error(`detected stack: ${result.detectedStack}`);
      } else {
        console.error('no primary stack detected — starter skill uses empty applies_to');
      }
      console.error('\nEdit .pr-review/skills/team-rules.md to add your team conventions.');
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('configure [path]')
  .description('Write ~/.pr-review/config.yaml. With a path, adds it to extra_reviewers_dirs; without, runs interactive prompts.')
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
  .option('--skills-dir <path...>', 'Extra skill directories to include')
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

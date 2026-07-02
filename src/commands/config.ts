import { loadConfig } from '../config.js';

export function showConfig(): void {
  const { config, sources } = loadConfig();
  console.log('Effective configuration:');
  console.log(JSON.stringify(config, null, 2));
  console.log('\nSources merged (lowest precedence first):');
  for (const [layer, where] of Object.entries(sources)) {
    console.log(`  ${layer}: ${where}`);
  }
}

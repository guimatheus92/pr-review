export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  appliesTo?: string[];
  reviewers?: PluginReviewerEntry[];
  skills?: PluginSkillEntry[];
}

export interface PluginReviewerEntry {
  id: string;
  prompt: string;
  model?: string;
  outputFormat?: 'json' | 'markdown';
  skipWhenNoMatch?: boolean;
  appliesTo?: string[];
}

export interface PluginSkillEntry {
  id: string;
  path: string;
  appliesTo?: string[];
  injectInto?: string[];
}

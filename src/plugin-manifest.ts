import { readFile, readdir, stat } from 'fs/promises';
import { join, dirname, resolve, normalize, sep } from 'path';

/**
 * Check if a path is contained within a base directory.
 * Prevents path traversal attacks via `..` segments or absolute paths.
 */
function isContainedIn(targetPath: string, basePath: string): boolean {
  const normalizedBase = normalize(resolve(basePath));
  const normalizedTarget = normalize(resolve(targetPath));
  return normalizedTarget.startsWith(normalizedBase + sep) || normalizedTarget === normalizedBase;
}

/**
 * Validate that a relative path follows Claude Code conventions.
 * Paths must start with './' per the plugin manifest spec.
 */
function isValidRelativePath(path: string): boolean {
  return path.startsWith('./');
}

/**
 * Plugin manifest types
 */
interface PluginManifestEntry {
  source?: string | { source: string; repo?: string };
  skills?: string | string[];
  /** Optional name for grouping skills (e.g., "document-skills") */
  name?: string;
}

interface MarketplaceManifest {
  metadata?: { pluginRoot?: string };
  plugins?: PluginManifestEntry[];
}

interface PluginManifest {
  skills?: string | string[];
  name?: string;
}

async function hasSkillMd(skillDir: string): Promise<boolean> {
  try {
    return (await stat(join(skillDir, 'SKILL.md'))).isFile();
  } catch {
    return false;
  }
}

/**
 * Extract skill search directories from plugin manifests.
 * Handles both marketplace.json (multi-plugin) and plugin.json (single plugin).
 * Only resolves local paths - remote sources are skipped.
 *
 * Returns directories that CONTAIN skills (to be searched for child SKILL.md files).
 * For explicit skill paths in manifests, adds the parent directory so the
 * existing discovery loop finds them.
 */
export async function getPluginSkillPaths(basePath: string): Promise<string[]> {
  const searchDirs: string[] = [];

  // Helper: add skill paths for a plugin at a given base path
  // Only adds paths that are contained within basePath (security: prevents traversal)
  const addPluginSkillPaths = (pluginBase: string, skills?: string | string[]) => {
    // Validate pluginBase itself is contained
    if (!isContainedIn(pluginBase, basePath)) return;

    if (Array.isArray(skills) && skills.length > 0) {
      // Plugin explicitly declares skill paths - add parent dirs so existing loop finds them
      for (const skillPath of skills) {
        // Validate skill path starts with './' (per Claude Code convention)
        if (!isValidRelativePath(skillPath)) continue;

        const skillDir = dirname(join(pluginBase, skillPath));
        if (isContainedIn(skillDir, basePath)) {
          searchDirs.push(skillDir);
        }
      }
    } else if (typeof skills === 'string') {
      // Some plugin manifests declare a directory containing skills instead
      // of enumerating every skill directory.
      if (isValidRelativePath(skills)) {
        const skillContainerDir = join(pluginBase, skills);
        if (isContainedIn(skillContainerDir, basePath)) {
          searchDirs.push(skillContainerDir);
        }
      }
    }
    // Always add conventional skills/ directory for discovery
    // (deduplication happens via seenNames in discoverSkills)
    searchDirs.push(join(pluginBase, 'skills'));
  };

  // Try marketplace.json (multi-plugin catalog)
  try {
    const content = await readFile(join(basePath, '.claude-plugin/marketplace.json'), 'utf-8');
    const manifest: MarketplaceManifest = JSON.parse(content);
    const pluginRoot = manifest.metadata?.pluginRoot;

    // Validate pluginRoot starts with './' if provided (per Claude Code convention)
    const validPluginRoot = pluginRoot === undefined || isValidRelativePath(pluginRoot);

    if (validPluginRoot) {
      for (const plugin of manifest.plugins ?? []) {
        // Skip remote sources (object with source/repo) - only handle local string paths
        if (typeof plugin.source !== 'string' && plugin.source !== undefined) continue;

        // Validate source starts with './' if provided (per Claude Code convention)
        if (plugin.source !== undefined && !isValidRelativePath(plugin.source)) continue;

        const pluginBase = join(basePath, pluginRoot ?? '', plugin.source ?? '');
        addPluginSkillPaths(pluginBase, plugin.skills);
      }
    }
  } catch {
    // File doesn't exist or invalid JSON
  }

  // Try plugin.json (single plugin at root)
  try {
    const content = await readFile(join(basePath, '.claude-plugin/plugin.json'), 'utf-8');
    const manifest: PluginManifest = JSON.parse(content);
    addPluginSkillPaths(basePath, manifest.skills);
  } catch {
    // File doesn't exist or invalid JSON
  }

  return searchDirs;
}

/**
 * Get a map of skill directory paths to plugin names from plugin manifests.
 * This allows grouping skills by their parent plugin.
 *
 * Returns Map<AbsolutePath, PluginName>
 */
export async function getPluginGroupings(basePath: string): Promise<Map<string, string>> {
  const groupings = new Map<string, string>();

  const addSkillDirectoryGrouping = async (skillDir: string, pluginName: string) => {
    if (!isContainedIn(skillDir, basePath)) return;
    if (await hasSkillMd(skillDir)) {
      groupings.set(resolve(skillDir), pluginName);
    }
  };

  const addSkillContainerGroupings = async (skillContainerDir: string, pluginName: string) => {
    if (!isContainedIn(skillContainerDir, basePath)) return;

    try {
      const entries = await readdir(skillContainerDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const childDir = join(skillContainerDir, entry.name);
        if (!isContainedIn(childDir, basePath)) continue;

        if (await hasSkillMd(childDir)) {
          groupings.set(resolve(childDir), pluginName);
          continue;
        }

        // Match discoverSkills' catalog behavior for layouts like
        // skills/<category>/<skill>/SKILL.md.
        try {
          const grandEntries = await readdir(childDir, { withFileTypes: true });
          for (const grandEntry of grandEntries) {
            if (!grandEntry.isDirectory()) continue;
            await addSkillDirectoryGrouping(join(childDir, grandEntry.name), pluginName);
          }
        } catch {
          // Child dir unreadable; skip silently.
        }
      }
    } catch {
      // Directory doesn't exist or is unreadable.
    }
  };

  const addPluginGroupings = async (
    pluginBase: string,
    pluginName: string,
    skills?: string | string[]
  ) => {
    if (!isContainedIn(pluginBase, basePath)) return;

    if (Array.isArray(skills) && skills.length > 0) {
      for (const skillPath of skills) {
        // Validate skill path starts with './' (per Claude Code convention)
        if (!isValidRelativePath(skillPath)) continue;

        const skillDir = join(pluginBase, skillPath);
        if (isContainedIn(skillDir, basePath)) {
          groupings.set(resolve(skillDir), pluginName);
        }
      }
      return;
    }

    if (typeof skills === 'string') {
      if (!isValidRelativePath(skills)) return;
      await addSkillContainerGroupings(join(pluginBase, skills), pluginName);
      return;
    }

    await addSkillContainerGroupings(join(pluginBase, 'skills'), pluginName);
  };

  // Try marketplace.json (multi-plugin catalog)
  try {
    const content = await readFile(join(basePath, '.claude-plugin/marketplace.json'), 'utf-8');
    const manifest: MarketplaceManifest = JSON.parse(content);
    const pluginRoot = manifest.metadata?.pluginRoot;

    // Validate pluginRoot starts with './' if provided (per Claude Code convention)
    const validPluginRoot = pluginRoot === undefined || isValidRelativePath(pluginRoot);

    if (validPluginRoot) {
      for (const plugin of manifest.plugins ?? []) {
        if (!plugin.name) continue;

        // Skip remote sources (object with source/repo) - only handle local string paths
        if (typeof plugin.source !== 'string' && plugin.source !== undefined) continue;

        // Validate source starts with './' if provided (per Claude Code convention)
        if (plugin.source !== undefined && !isValidRelativePath(plugin.source)) continue;

        const pluginBase = join(basePath, pluginRoot ?? '', plugin.source ?? '');

        // Validate pluginBase itself is contained
        if (!isContainedIn(pluginBase, basePath)) continue;

        await addPluginGroupings(pluginBase, plugin.name, plugin.skills);
      }
    }
  } catch {
    // File doesn't exist or invalid JSON
  }

  // Try plugin.json (single plugin at root)
  try {
    const content = await readFile(join(basePath, '.claude-plugin/plugin.json'), 'utf-8');
    const manifest: PluginManifest = JSON.parse(content);
    if (manifest.name) {
      await addPluginGroupings(basePath, manifest.name, manifest.skills);
    }
  } catch {
    // File doesn't exist or invalid JSON
  }

  return groupings;
}

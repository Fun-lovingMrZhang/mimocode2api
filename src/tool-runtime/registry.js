import {
  EXTERNAL_TOOL_PREFIX,
  TOOL_RISK_LEVELS,
  TOOL_SIDE_EFFECTS,
  normalizeRiskLevel,
  normalizeSideEffect
} from './contracts.js';

function normalizeDescription(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeParameters(parameters) {
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    return parameters;
  }
  return { type: 'object', properties: {} };
}

function inferSideEffect(tool = {}) {
  const declared = tool?.x_proxy_side_effect || tool?.function?.x_proxy_side_effect;
  if (declared) return normalizeSideEffect(declared, TOOL_SIDE_EFFECTS.NONE);

  const name = String(tool?.function?.name || '').toLowerCase();
  if (/^(get|list|search|find|read|fetch|lookup)/.test(name)) return TOOL_SIDE_EFFECTS.READ;
  if (/^(create|update|set|post|write|send)/.test(name)) return TOOL_SIDE_EFFECTS.WRITE;
  if (/^(delete|remove|destroy)/.test(name)) return TOOL_SIDE_EFFECTS.DELETE;
  return TOOL_SIDE_EFFECTS.NONE;
}

function inferRiskLevel(tool = {}, sideEffect = TOOL_SIDE_EFFECTS.NONE) {
  const declared = tool?.x_proxy_risk_level || tool?.function?.x_proxy_risk_level;
  if (declared) return normalizeRiskLevel(declared, TOOL_RISK_LEVELS.LOW);
  if (sideEffect === TOOL_SIDE_EFFECTS.DELETE || sideEffect === TOOL_SIDE_EFFECTS.PAYMENT) {
    return TOOL_RISK_LEVELS.CRITICAL;
  }
  if (sideEffect === TOOL_SIDE_EFFECTS.WRITE || sideEffect === TOOL_SIDE_EFFECTS.EXTERNAL_NOTIFICATION) {
    return TOOL_RISK_LEVELS.MEDIUM;
  }
  return TOOL_RISK_LEVELS.LOW;
}

function inferRequiresConfirmation(tool = {}, sideEffect = TOOL_SIDE_EFFECTS.NONE, riskLevel = TOOL_RISK_LEVELS.LOW) {
  if (typeof tool?.x_proxy_requires_confirmation === 'boolean') {
    return tool.x_proxy_requires_confirmation;
  }
  if (typeof tool?.function?.x_proxy_requires_confirmation === 'boolean') {
    return tool.function.x_proxy_requires_confirmation;
  }
  return sideEffect === TOOL_SIDE_EFFECTS.WRITE || riskLevel === TOOL_RISK_LEVELS.HIGH || riskLevel === TOOL_RISK_LEVELS.CRITICAL;
}

export function buildExternalToolRegistry(tools, options = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const prefix = options.prefix || EXTERNAL_TOOL_PREFIX;
  const registry = [];
  const seenNamespaced = new Set();

  tools.forEach((tool, index) => {
    if (tool?.type !== 'function' || !tool?.function?.name) return;
    const originalName = String(tool.function.name).trim();
    if (!originalName) return;

    let namespacedName = `${prefix}${originalName}`;
    let counter = 2;
    while (seenNamespaced.has(namespacedName)) {
      namespacedName = `${prefix}${originalName}_${counter}`;
      counter += 1;
    }
    seenNamespaced.add(namespacedName);

    const sideEffect = inferSideEffect(tool);
    const riskLevel = inferRiskLevel(tool, sideEffect);
    registry.push({
      id: `external_tool_${index + 1}`,
      originalName,
      namespacedName,
      description: normalizeDescription(tool.function.description),
      parameters: normalizeParameters(tool.function.parameters),
      sideEffect,
      riskLevel,
      requiresConfirmation: inferRequiresConfirmation(tool, sideEffect, riskLevel),
      enabled: tool?.function?.enabled !== false,
      sourceTool: tool
    });
  });

  return registry;
}

// Common alias mapping — models may use their own built-in tool names
// (Bash, bash, Grep, etc.) instead of the external tool names provided
// in the system prompt. Map these to the registered external tools.
const TOOL_NAME_ALIASES = {
  // terminal/shell
  'bash': 'terminal', 'shell': 'terminal', 'sh': 'terminal', 'cmd': 'terminal',
  'execute_bash': 'terminal', 'run_command': 'terminal', 'command': 'terminal',
  // file operations
  'cat': 'read_file', 'read': 'read_file', 'view': 'read_file', 'open_file': 'read_file',
  'grep': 'search_files', 'rg': 'search_files', 'find': 'search_files', 'glob': 'search_files',
  'ls': 'search_files', 'list': 'search_files', 'list_files': 'search_files',
  'write': 'write_file', 'create_file': 'write_file', 'edit': 'patch', 'edit_file': 'patch', 'sed': 'patch',
  // web
  'web_search': 'web_search', 'search': 'web_search', 'web_fetch': 'web_extract',
  'fetch': 'web_extract', 'curl': 'terminal', 'webfetch': 'web_extract', 'websearch': 'web_search',
  // misc — case-insensitive variants
  'Read': 'read_file', 'TodoWrite': 'todo', 'TodoRead': 'todo', 'TodoUpdate': 'todo', 'Todo': 'todo',
  'TodoDelete': 'todo', 'TodoList': 'todo',
};

export function findExternalToolByName(registry, name) {
  if (!name || !Array.isArray(registry)) return null;
  const normalized = name.trim();
  // 1. Exact match (namespaced or original)
  let tool = registry.find((t) => t.namespacedName === normalized || t.originalName === normalized) || null;
  if (tool) return tool;
  // 2. Strip external__ prefix and try again
  const stripped = normalized.replace(/^external__/, '');
  if (stripped !== normalized) {
    tool = registry.find((t) => t.originalName === stripped) || null;
    if (tool) return tool;
  }
  // 3. Case-insensitive match
  const lower = normalized.toLowerCase();
  tool = registry.find((t) => t.originalName.toLowerCase() === lower || t.namespacedName.toLowerCase() === lower) || null;
  if (tool) return tool;
  // 4. Alias lookup
  const aliased = TOOL_NAME_ALIASES[lower];
  if (aliased) {
    tool = registry.find((t) => t.originalName === aliased || t.originalName.toLowerCase() === aliased.toLowerCase()) || null;
    if (tool) return tool;
  }
  return null;
}

/**
 * Find a tool by matching its parameter names against a set of known param names.
 * Used when the model outputs <tool_input> format which has no tool name,
 * only parameter tags like <command>, <path>, etc.
 *
 * Strategy: score each tool by how many of the given paramNames appear in its
 * schema properties. Return the tool with the highest score (must be > 0).
 */
export function findToolByParamNames(registry, paramNames = []) {
  if (!Array.isArray(registry) || registry.length === 0 || !Array.isArray(paramNames) || paramNames.length === 0) return null;
  let bestTool = null;
  let bestScore = 0;
  for (const tool of registry) {
    const props = tool?.parameters?.properties;
    if (!props || typeof props !== 'object') continue;
    const toolParams = Object.keys(props).map(k => k.toLowerCase());
    let score = 0;
    for (const pn of paramNames) {
      const lower = pn.toLowerCase();
      // Exact param name match = 2 points, partial match = 1 point
      if (toolParams.includes(lower)) score += 2;
      else if (toolParams.some(tp => tp.includes(lower) || lower.includes(tp))) score += 1;
    }
    // Bonus: if ALL param names match, strongly prefer this tool
    if (score >= paramNames.length * 2 && paramNames.length > 0) score += 5;
    if (score > bestScore) {
      bestScore = score;
      bestTool = tool;
    }
  }
  return bestScore > 0 ? bestTool : null;
}

export function createRegistryIndex(registry) {
  const byOriginalName = new Map();
  const byNamespacedName = new Map();
  (registry || []).forEach((tool) => {
    byOriginalName.set(tool.originalName, tool);
    byNamespacedName.set(tool.namespacedName, tool);
  });
  return { byOriginalName, byNamespacedName };
}

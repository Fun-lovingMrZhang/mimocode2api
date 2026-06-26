import { EXTERNAL_TOOL_PREFIX } from './contracts.js';
import { findExternalToolByName } from './registry.js';

export function normalizeExternalToolChoice(toolChoice, registry) {
  if (!toolChoice || !Array.isArray(registry) || registry.length === 0) {
    return { mode: 'auto', requiredTool: null };
  }
  if (toolChoice === 'auto' || toolChoice === 'none') {
    return { mode: toolChoice, requiredTool: null };
  }
  if (toolChoice === 'required') {
    return { mode: 'required', requiredTool: null };
  }
  const requestedName = toolChoice?.function?.name;
  if (toolChoice?.type === 'function' && requestedName) {
    const mappedTool = findExternalToolByName(registry, requestedName);
    return {
      mode: 'required',
      requiredTool: mappedTool?.namespacedName || `${EXTERNAL_TOOL_PREFIX}${requestedName}`
    };
  }
  return { mode: 'auto', requiredTool: null };
}

export function buildExternalToolsPrompt(registry, toolChoice = null) {
  if (!Array.isArray(registry) || registry.length === 0) return '';
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
  const choiceInstructions = [];
  if (normalizedChoice.mode === 'required') {
    if (normalizedChoice.requiredTool) {
      choiceInstructions.push(`Tool use is REQUIRED for this turn. You MUST call ${normalizedChoice.requiredTool} before giving any final answer.`);
    } else {
      choiceInstructions.push('Tool use is REQUIRED for this turn. You MUST call an external tool before giving any final answer.');
    }
  } else if (normalizedChoice.mode === 'none') {
    choiceInstructions.push('Tool use is disabled for this turn. Do not emit <function_calls>.');
  }

  // Build a concise example from the first tool to make the format concrete.
  const firstTool = registry[0];
  const exampleName = firstTool?.namespacedName || 'external__tool';
  const exampleArgs = firstTool?.parameters?.properties
    ? Object.entries(firstTool.parameters.properties).slice(0, 1).map(([k]) => `"${k}":"value"`).join(',')
    : '';

  return [
    'You have access to external tools. To call a tool, output a <function_calls> block in your reply.',
    'The block must contain a JSON array. Example:',
    `<function_calls>[{"name":"${exampleName}","arguments":{${exampleArgs}}}]</function_calls>`,
    'Rules:',
    '- Output the <function_calls> block directly in your text reply (not in reasoning).',
    '- Use the exact tool names and parameter names from the list below.',
    '- You may write a brief explanation before the block.',
    '- After the tool result is provided as TOOL_RESULT, continue the conversation normally.',
    ...choiceInstructions,
    `Available tools: ${JSON.stringify(registry.map((tool) => ({
      name: tool.namespacedName,
      description: tool.description,
      parameters: tool.parameters
    })))}`
  ].join('\n');
}

export function buildToolExposure(registry, toolChoice = null) {
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
  const exposedTools = Array.isArray(registry) ? registry.filter((tool) => tool.enabled !== false) : [];
  return {
    tools: exposedTools,
    toolChoice: normalizedChoice,
    prompt: buildExternalToolsPrompt(exposedTools, toolChoice)
  };
}

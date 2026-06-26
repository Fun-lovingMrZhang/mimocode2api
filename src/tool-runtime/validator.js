import { VALIDATION_STATUSES, createValidationError } from './contracts.js';
import { findExternalToolByName } from './registry.js';

// Common parameter name aliases — models often use these instead of the
// schema-defined names. Map them to the canonical names.
const PARAM_NAME_ALIASES = {
  // file operations
  'file_path': 'path',
  'filepath': 'path',
  'filename': 'path',
  'file': 'path',
  // terminal
  'cmd': 'command',
  'shell_command': 'command',
  'exec': 'command',
  // search
  'search_query': 'query',
  'q': 'query',
  'keyword': 'query',
  'search': 'query',
  // content
  'text': 'content',
  'body': 'content',
  'data': 'content',
  // misc
  'directory': 'path',
  'dir': 'path',
  'folder': 'path',
  'url_to_fetch': 'url',
  'link': 'url',
};

/**
 * Auto-correct parameter names that don't match the schema but have
 * common aliases. Mutates `args` in-place to use canonical names.
 */
function autoCorrectParamNames(args, schema = {}) {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return;
  const schemaKeys = Object.keys(properties).map(k => k.toLowerCase());

  Object.keys(args).forEach((key) => {
    // If the key already exists in the schema, leave it
    if (key in properties) return;

    const lower = key.toLowerCase();
    // Check if any schema key matches case-insensitively
    const caseInsensitiveMatch = Object.keys(properties).find(sk => sk.toLowerCase() === lower);
    if (caseInsensitiveMatch) {
      args[caseInsensitiveMatch] = args[key];
      delete args[key];
      return;
    }

    // Check alias map
    const aliased = PARAM_NAME_ALIASES[lower];
    if (aliased && aliased in properties) {
      args[aliased] = args[key];
      delete args[key];
      return;
    }

    // Fuzzy match: if the key contains a schema key as a substring or vice versa
    const fuzzyMatch = schemaKeys.find(sk => sk.length > 2 && (sk.includes(lower) || lower.includes(sk)));
    if (fuzzyMatch) {
      const originalKey = Object.keys(properties).find(ok => ok.toLowerCase() === fuzzyMatch);
      if (originalKey && !(originalKey in args)) {
        args[originalKey] = args[key];
        delete args[key];
      }
    }
  });
}

function safeParseJsonObject(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: {} };
  }
  if (typeof raw === 'object') {
    return Array.isArray(raw)
      ? { ok: false, error: 'arguments must be a JSON object' }
      : { ok: true, value: raw };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'arguments must be a JSON string or object' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'arguments must decode to a JSON object' };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function validateAgainstSchema(args, schema = {}) {
  const errors = [];
  const normalizedSchema = schema && typeof schema === 'object' ? schema : {};
  const properties = normalizedSchema.properties && typeof normalizedSchema.properties === 'object'
    ? normalizedSchema.properties
    : {};
  const required = Array.isArray(normalizedSchema.required) ? normalizedSchema.required : [];

  required.forEach((key) => {
    if (!(key in args) || args[key] === undefined || args[key] === null || args[key] === '') {
      errors.push(createValidationError('missing_required_field', `Missing required field: ${key}`, [key]));
    }
  });

  Object.entries(properties).forEach(([key, definition]) => {
      if (!(key in args) || args[key] === undefined || args[key] === null) return;
      const value = args[key];
      const expectedType = definition?.type;

      // Auto-coercion: models frequently emit numbers and booleans as strings.
      // Repair in-place so downstream code receives the correct JS type.
      if (expectedType === 'integer' && typeof value === 'string') {
          const parsed = Number(value);
          if (Number.isInteger(parsed)) { args[key] = parsed; }
          else { errors.push(createValidationError('invalid_type', `Field ${key} must be an integer`, [key])); return; }
      }
      if (expectedType === 'number' && typeof value === 'string') {
          const parsed = Number(value);
          if (!Number.isNaN(parsed)) { args[key] = parsed; }
          else { errors.push(createValidationError('invalid_type', `Field ${key} must be a number`, [key])); return; }
      }
      if (expectedType === 'boolean' && typeof value === 'string') {
          const lower = value.toLowerCase();
          if (lower === 'true' || lower === '1') { args[key] = true; }
          else if (lower === 'false' || lower === '0') { args[key] = false; }
          else { errors.push(createValidationError('invalid_type', `Field ${key} must be a boolean`, [key])); return; }
      }

      const coercedValue = args[key];
      if (expectedType === 'string' && typeof coercedValue !== 'string') {
          errors.push(createValidationError('invalid_type', `Field ${key} must be a string`, [key]));
      }
      if (expectedType === 'number' && typeof coercedValue !== 'number') {
          errors.push(createValidationError('invalid_type', `Field ${key} must be a number`, [key]));
      }
      if (expectedType === 'integer' && !Number.isInteger(coercedValue)) {
          errors.push(createValidationError('invalid_type', `Field ${key} must be an integer`, [key]));
      }
      if (expectedType === 'boolean' && typeof coercedValue !== 'boolean') {
          errors.push(createValidationError('invalid_type', `Field ${key} must be a boolean`, [key]));
      }
      if (expectedType === 'object' && (!coercedValue || typeof coercedValue !== 'object' || Array.isArray(coercedValue))) {
          errors.push(createValidationError('invalid_type', `Field ${key} must be an object`, [key]));
      }
      if (Array.isArray(definition?.enum) && !definition.enum.includes(coercedValue)) {
          errors.push(createValidationError('invalid_enum', `Field ${key} must be one of: ${definition.enum.join(', ')}`, [key]));
      }
  });

  return errors;
}

export function validateToolCall(parsedCall, registry) {
  const tool = findExternalToolByName(registry, parsedCall?.function?.name);
  if (!tool) {
    return {
      status: VALIDATION_STATUSES.REJECTED,
      errors: [createValidationError('unknown_tool', `Unknown external tool: ${parsedCall?.function?.name || 'unknown'}`)],
      tool: null
    };
  }

  const parsedArgs = safeParseJsonObject(parsedCall?.function?.arguments);
  if (!parsedArgs.ok) {
    return {
      status: VALIDATION_STATUSES.REPAIRABLE,
      errors: [createValidationError('invalid_arguments_json', `Invalid JSON arguments for ${tool.originalName}: ${parsedArgs.error}`)],
      tool
    };
  }

  // Auto-correct parameter names (file_path→path, cmd→command, etc.)
  // Models frequently use wrong but semantically correct parameter names.
  autoCorrectParamNames(parsedArgs.value, tool.parameters);

  const schemaErrors = validateAgainstSchema(parsedArgs.value, tool.parameters);
  if (schemaErrors.length > 0) {
    return {
      status: VALIDATION_STATUSES.REJECTED,
      errors: schemaErrors,
      tool
    };
  }

  return {
    status: VALIDATION_STATUSES.VALID,
    normalizedArguments: parsedArgs.value,
    tool
  };
}

export function validateToolCalls(parsedCalls, registry) {
  if (!Array.isArray(parsedCalls) || parsedCalls.length === 0) {
    return { validCalls: [], invalidCalls: [] };
  }

  const validCalls = [];
  const invalidCalls = [];
  parsedCalls.forEach((call) => {
    const validation = validateToolCall(call, registry);
    if (validation.status === VALIDATION_STATUSES.VALID) {
      validCalls.push({
        ...call,
        validatedArguments: validation.normalizedArguments,
        function: {
          ...call.function,
          arguments: JSON.stringify(validation.normalizedArguments)
        },
        tool: validation.tool,
        validation
      });
      return;
    }
    invalidCalls.push({
      call,
      validation
    });
  });

  return { validCalls, invalidCalls };
}

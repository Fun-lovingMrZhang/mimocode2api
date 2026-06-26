import { findExternalToolByName, findToolByParamNames } from './registry.js';

// ─── Flexible tag matching ───
// Models may output <function_calls>, <function_call>, <tool_call>, <tool_use>, etc.
// Also <function=name> and <parameter=name> (self-closing XML style).
const OPEN_TAG_RE = /<function_calls?>|<tool_calls?>|<tool_use[s]?>|<function(?:\s[^>]*)?>|<function_call\s+name=|<invoke\s+name=|<tool_name>|<tool_input>|<function_name>/;
const CLOSE_TAG_RE = /<\/function_calls?>|<\/tool_calls?>|<\/tool_use[s]?>|<\/function>|<\/invoke>|<\/tool_name>|<\/parameters>|<\/tool_input>|<\/function_name>|\/>/;
// Some models use <tool_name>...</tool_name><tool_arguments>...</tool_arguments>
// Others use <function_name>...</function_name><parameters>...</parameters>
const TOOL_NAME_RE = /<tool_name>\s*([\s\S]*?)\s*<\/tool_name>/g;
const TOOL_ARGS_RE = /<tool_arguments>\s*([\s\S]*?)\s*<\/tool_arguments>/g;
// Some models use <invoke name="..."> or <call name="...">
const INVOKE_RE = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/g;
// <function_name> variant (same structure as <tool_name>)
const FUNC_NAME_RE = /<function_name>\s*([\s\S]*?)\s*<\/function_name>/g;

// Non-global versions for single-match use inside extractCallsFromBlock
const TOOL_NAME_SINGLE = /<tool_name>\s*([\s\S]*?)\s*<\/tool_name>/;
const TOOL_ARGS_SINGLE = /<tool_arguments>\s*([\s\S]*?)\s*<\/tool_arguments>/;
const INVOKE_SINGLE = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/;

function matchOpenTag(text) {
    const m = text.match(OPEN_TAG_RE);
    return m ? { index: m.index, length: m[0].length } : null;
}

function matchCloseTag(text, from) {
    const slice = text.slice(from);
    const m = slice.match(CLOSE_TAG_RE);
    return m ? { index: from + m.index, length: m[0].length } : null;
}

// ─── Strip markup from final text ───
export function stripFunctionCallMarkup(text, trim = true) {
    if (!text) return text;
    let cleaned = text;
    // Remove standard blocks
    cleaned = cleaned.replace(/<function_calls?>[\s\S]*?<\/function_calls?>/g, '');
    cleaned = cleaned.replace(/<tool_calls?>[\s\S]*?<\/tool_calls?>/g, '');
    cleaned = cleaned.replace(/<tool_use[s]?>[\s\S]*?<\/tool_use[s]?>/g, '');
    // Remove <function=name>...</function> blocks
    cleaned = cleaned.replace(/<function\s*=\s*[^>]+>[\s\S]*?<\/function>/g, '');
    // Remove <invoke name="...">...</invoke> blocks
    cleaned = cleaned.replace(/<invoke\s+name=[^>]+>[\s\S]*?<\/invoke>/g, '');
    // Remove <function_call name="..." arguments=... /> self-closing tags
    cleaned = cleaned.replace(/<function_call\s+name\s*=\s*["'][^"']+["']\s+arguments\s*=\s*.+?\/?>/g, '');
    // Remove <parameters>...</parameters> blocks
    cleaned = cleaned.replace(/<parameters>[\s\S]*?<\/parameters>/g, '');
    // Remove loose tags
    cleaned = cleaned.replace(/<\/?function_calls?>/g, '');
    cleaned = cleaned.replace(/<\/?tool_calls?>/g, '');
    cleaned = cleaned.replace(/<\/?tool_use[s]?>/g, '');
    cleaned = cleaned.replace(/<\/?function>/g, '');
    cleaned = cleaned.replace(/<\/?function\s*=\s*[^>]*>/g, '');
    cleaned = cleaned.replace(/<\/?invoke\s+name=[^>]*>/g, '');
    // Remove tool_name/tool_arguments pairs
    cleaned = cleaned.replace(/<tool_name>[\s\S]*?<\/tool_name>/g, '');
    cleaned = cleaned.replace(/<tool_arguments>[\s\S]*?<\/tool_arguments>/g, '');
    // Remove <function_name>...</function_name> (variant of <tool_name>)
    cleaned = cleaned.replace(/<function_name>[\s\S]*?<\/function_name>/g, '');
    // Remove <tool_input>...</tool_input> blocks (model variant with no tool name)
    cleaned = cleaned.replace(/<tool_input>[\s\S]*?<\/tool_input>/g, '');
    cleaned = cleaned.replace(/<\/?tool_input>/g, '');
    // Remove <parameter=name>...</parameter> leftovers
    cleaned = cleaned.replace(/<parameter\s*=\s*[^>]+>[\s\S]*?<\/parameter>/g, '');
    cleaned = cleaned.replace(/<\/?parameter\s*=\s*[^>]*>/g, '');
    // Remove <param name="...">value</param> leftovers
    cleaned = cleaned.replace(/<param(?:eter)?\s+name\s*=\s*["'][^"']+["']\s*>[\s\S]*?<\/param(?:eter)?>/g, '');
    cleaned = cleaned.replace(/<\/?param(?:eter)?\s+name\s*=\s*["'][^"']*["']\s*>/g, '');
    // Remove <arg name="...">...</arg> leftovers
    cleaned = cleaned.replace(/<arg\s+name=[^>]+>[\s\S]*?<\/arg>/g, '');
    cleaned = cleaned.replace(/<\/?arg\s+name=[^>]*>/g, '');
    // Remove <param_name>/<param_value> leftovers
    cleaned = cleaned.replace(/<param_name>[\s\S]*?<\/param_name>/g, '');
    cleaned = cleaned.replace(/<param_value>[\s\S]*?<\/param_value>/g, '');
    cleaned = cleaned.replace(/<\/?param_name>/g, '');
    cleaned = cleaned.replace(/<\/?param_value>/g, '');
    return trim ? cleaned.trim() : cleaned;
}

// ─── Parse raw tool calls from text (flexible format) ───
// Additional regex for <function_call name="..." arguments={json} /> self-closing format
// Uses a greedy match for arguments, stopping at the LAST /> or > on the line
const FUNC_CALL_ATTR_RE = /<function_call\s+name\s*=\s*["']([^"']+)["']\s+arguments\s*=\s*(.+?)\s*\/>\s*$/gm;
// <parameters>{json}</parameters> — model variant of <tool_arguments>
const PARAMETERS_RE = /<parameters>\s*([\s\S]*?)\s*<\/parameters>/g;
const PARAMETERS_SINGLE = /<parameters>\s*([\s\S]*?)\s*<\/parameters>/;

function extractCallsFromBlock(content) {
    const calls = [];

    // Try JSON parse first (standard function_calls format)
    try {
        const parsed = JSON.parse(content);
        const rawCalls = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.tool_calls)
                ? parsed.tool_calls
                : [parsed];
        rawCalls.forEach((rc) => {
            const name = rc?.function?.name || rc?.name;
            const args = rc?.function?.arguments ?? rc?.arguments ?? {};
            if (name) {
                calls.push({
                    name,
                    arguments: typeof args === 'string' ? args : JSON.stringify(args)
                });
            }
        });
    } catch {
        // Not valid JSON — try structured XML formats

        // <function_call name="..." arguments={json} /> self-closing format
        for (const fm of content.matchAll(FUNC_CALL_ATTR_RE)) {
            const name = fm[1].trim();
            const rawArgs = fm[2].trim();
            let args = '{}';
            // arguments might be a JSON object, a JSON string, or malformed
            try {
                const parsed = JSON.parse(rawArgs);
                args = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
            } catch {
                // Try extracting just the JSON object part
                const jsonMatch = rawArgs.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    try {
                        const parsed = JSON.parse(jsonMatch[0]);
                        args = JSON.stringify(parsed);
                    } catch {
                        args = jsonMatch[0];
                    }
                } else {
                    args = rawArgs;
                }
            }
            if (name) calls.push({ name, arguments: args });
        }

        // <tool_name>...</tool_name> with <tool_arguments> OR <parameters>
        const nameMatch = content.match(TOOL_NAME_SINGLE);
        if (nameMatch) {
            const name = nameMatch[1].trim();
            let args = '{}';
            // Try <tool_arguments> first, then <parameters> as fallback
            let argsMatch = content.match(TOOL_ARGS_SINGLE);
            if (!argsMatch) argsMatch = content.match(PARAMETERS_SINGLE);
            if (argsMatch) {
                const rawArgs = argsMatch[1].trim();
                try {
                    args = JSON.stringify(JSON.parse(rawArgs));
                } catch {
                    // Not JSON — try XML tag formats
                    const argObj = {};
                    [...rawArgs.matchAll(/<([a-zA-Z_][a-zA-Z0-9_]*)>\s*([\s\S]*?)\s*<\/\1>/g)].forEach((am) => {
                        argObj[am[1]] = am[2].trim();
                    });
                    [...rawArgs.matchAll(/<param(?:eter)?\s+name\s*=\s*["']([^"']+)["']\s*>\s*([\s\S]*?)\s*<\/param(?:eter)?>/g)].forEach((am) => {
                        argObj[am[1]] = am[2].trim();
                    });
                    [...rawArgs.matchAll(/<arg\s+name\s*=\s*["']([^"']+)["']\s*>\s*([\s\S]*?)\s*<\/arg>/g)].forEach((am) => {
                        argObj[am[1]] = am[2].trim();
                    });
                    args = Object.keys(argObj).length > 0 ? JSON.stringify(argObj) : rawArgs;
                }
            }
            calls.push({ name, arguments: args });
        }

        // <invoke name="..."> format — with proper <arg> tag handling
        const invokeMatch = content.match(INVOKE_SINGLE);
        if (invokeMatch) {
            const name = invokeMatch[1].trim();
            const body = invokeMatch[2] || '';
            let args = '{}';
            // First try JSON.parse (for <invoke name="...">{json}</invoke> format)
            try {
                args = JSON.stringify(JSON.parse(body.trim()));
            } catch {
                // JSON parse failed — check for <arg name="...">value</arg> tags
                const argMatches = [...body.matchAll(/<arg\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/arg>/g)];
                if (argMatches.length > 0) {
                    const argObj = {};
                    argMatches.forEach((am) => {
                        argObj[am[1].trim()] = am[2].trim();
                    });
                    args = JSON.stringify(argObj);
                }
            }
            calls.push({ name, arguments: args });
        }
    }

    return calls;
}

export function parseToolCallsFromText(...chunks) {
    const matches = [];
    chunks.forEach((chunk) => {
        if (!chunk || typeof chunk !== 'string') return;

        // Pattern 1: Standard <function_calls>...</function_calls> (and variants)
        const blockRegex = /<function_calls?>([\s\S]*?)<\/function_calls?>/g;
        const toolCallRegex = /<tool_calls?>([\s\S]*?)<\/tool_calls?>/g;
        const toolUseRegex = /<tool_use[s]?>[\s\S]*?<\/tool_use[s]?>/g;

        for (const re of [blockRegex, toolCallRegex]) {
            for (const block of chunk.matchAll(re)) {
                const payload = block?.[1]?.trim();
                if (!payload) continue;
                const extracted = extractCallsFromBlock(payload);
                extracted.forEach((c, index) => {
                    matches.push({
                        id: `call_${Date.now()}_${matches.length + index + 1}`,
                        type: 'function',
                        function: { name: c.name, arguments: c.arguments }
                    });
                });
            }
        }

        // Pattern 2: Bare <tool_name>...</tool_name><tool_arguments>...</tool_arguments>
        // Also handles <parameters>, <tool_input>, and bare <param name="..."> as argument containers
        const nameMatches = [...chunk.matchAll(TOOL_NAME_RE)];
        nameMatches.forEach((nm, index) => {
            const name = nm[1].trim();
            // Find corresponding arguments: try <tool_arguments>, <parameters>, <tool_input> in order
            const afterName = chunk.slice(nm.index + nm[0].length);
            let argsMatch = afterName.match(TOOL_ARGS_SINGLE);
            if (!argsMatch) argsMatch = afterName.match(PARAMETERS_SINGLE);
            if (!argsMatch) {
                // <tool_input> as argument container — content may be JSON or XML tags
                const tiMatch = afterName.match(/<tool_input>\s*([\s\S]*?)\s*<\/tool_input>/);
                if (tiMatch) argsMatch = tiMatch;
            }
            let args = '{}';
            if (argsMatch) {
                const rawArgs = argsMatch[1].trim();
                try {
                    args = JSON.stringify(JSON.parse(rawArgs));
                } catch {
                    // Not JSON — try XML tag formats
                    const argObj = {};
                    // Format 1: <param_name>value</param_name>
                    [...rawArgs.matchAll(/<([a-zA-Z_][a-zA-Z0-9_]*)>\s*([\s\S]*?)\s*<\/\1>/g)].forEach((am) => {
                        argObj[am[1]] = am[2].trim();
                    });
                    // Format 2: <param name="key">value</param> or <parameter name="key">value</parameter>
                    [...rawArgs.matchAll(/<param(?:eter)?\s+name\s*=\s*["']([^"']+)["']\s*>\s*([\s\S]*?)\s*<\/param(?:eter)?>/g)].forEach((am) => {
                        argObj[am[1]] = am[2].trim();
                    });
                    // Format 3: <arg name="key">value</arg>
                    [...rawArgs.matchAll(/<arg\s+name\s*=\s*["']([^"']+)["']\s*>\s*([\s\S]*?)\s*<\/arg>/g)].forEach((am) => {
                        argObj[am[1]] = am[2].trim();
                    });
                    // Format 4: <param_name>key</param_name><param_value>val</param_value>
                    const paramNames = [...rawArgs.matchAll(/<param_name>\s*([\s\S]*?)\s*<\/param_name>/g)];
                    const paramValues = [...rawArgs.matchAll(/<param_value>\s*([\s\S]*?)\s*<\/param_value>/g)];
                    paramNames.forEach((pn, i) => {
                        if (paramValues[i]) {
                            argObj[pn[1].trim()] = paramValues[i][1].trim();
                        }
                    });
                    args = Object.keys(argObj).length > 0 ? JSON.stringify(argObj) : rawArgs;
                }
            } else {
                // No argument container found — try bare param formats right after tool_name
                const bareParams = [...afterName.matchAll(/<param(?:eter)?\s+name\s*=\s*["']([^"']+)["']\s*>\s*([\s\S]*?)\s*<\/param(?:eter)?>/g)];
                if (bareParams.length > 0) {
                    const argObj = {};
                    bareParams.forEach((am) => { argObj[am[1]] = am[2].trim(); });
                    args = JSON.stringify(argObj);
                } else {
                    // Try <param_name>key</param_name><param_value>val</param_value> format
                    const pNames = [...afterName.matchAll(/<param_name>\s*([\s\S]*?)\s*<\/param_name>/g)];
                    const pValues = [...afterName.matchAll(/<param_value>\s*([\s\S]*?)\s*<\/param_value>/g)];
                    if (pNames.length > 0 && pValues.length > 0) {
                        const argObj = {};
                        pNames.forEach((pn, i) => {
                            if (pValues[i]) argObj[pn[1].trim()] = pValues[i][1].trim();
                        });
                        args = JSON.stringify(argObj);
                    }
                }
            }
            matches.push({
                id: `call_${Date.now()}_${matches.length + index + 1}`,
                type: 'function',
                function: { name, arguments: args }
            });
        });

        // Pattern 2b: <function_name>...</function_name><parameters>...</parameters>
        // (variant of Pattern 2 — some models use function_name instead of tool_name)
        const funcNameMatches = [...chunk.matchAll(FUNC_NAME_RE)];
        funcNameMatches.forEach((nm, index) => {
            const name = nm[1].trim();
            // Find corresponding arguments: try <tool_arguments>, <parameters>, <tool_input> in order
            const afterName = chunk.slice(nm.index + nm[0].length);
            let argsMatch = afterName.match(TOOL_ARGS_SINGLE);
            if (!argsMatch) argsMatch = afterName.match(PARAMETERS_SINGLE);
            if (!argsMatch) {
                const tiMatch = afterName.match(/<tool_input>\s*([\s\S]*?)\s*<\/tool_input>/);
                if (tiMatch) argsMatch = tiMatch;
            }
            let args = '{}';
            if (argsMatch) {
                const rawArgs = argsMatch[1].trim();
                try {
                    args = JSON.stringify(JSON.parse(rawArgs));
                } catch {
                    // Not JSON — try XML tag formats
                    const argObj = {};
                    [...rawArgs.matchAll(/<([a-zA-Z_][a-zA-Z0-9_]*)>\s*([\s\S]*?)\s*<\/\1>/g)].forEach((am) => {
                        argObj[am[1]] = am[2].trim();
                    });
                    [...rawArgs.matchAll(/<param(?:eter)?\s+name\s*=\s*["']([^"']+)["']\s*>\s*([\s\S]*?)\s*<\/param(?:eter)?>/g)].forEach((am) => {
                        argObj[am[1]] = am[2].trim();
                    });
                    [...rawArgs.matchAll(/<arg\s+name\s*=\s*["']([^"']+)["']\s*>\s*([\s\S]*?)\s*<\/arg>/g)].forEach((am) => {
                        argObj[am[1]] = am[2].trim();
                    });
                    args = Object.keys(argObj).length > 0 ? JSON.stringify(argObj) : rawArgs;
                }
            } else {
                // No argument container found — try bare <param name="..."> tags right after function_name
                const bareParams = [...afterName.matchAll(/<param(?:eter)?\s+name\s*=\s*["']([^"']+)["']\s*>\s*([\s\S]*?)\s*<\/param(?:eter)?>/g)];
                if (bareParams.length > 0) {
                    const argObj = {};
                    bareParams.forEach((am) => { argObj[am[1]] = am[2].trim(); });
                    args = JSON.stringify(argObj);
                }
            }
            matches.push({
                id: `call_${Date.now()}_${matches.length + index + 1}`,
                type: 'function',
                function: { name, arguments: args }
            });
        });

        // Pattern 3: <invoke name="...">...</invoke> with <arg> or JSON body
        for (const invoke of chunk.matchAll(INVOKE_RE)) {
            const name = invoke[1].trim();
            const body = invoke[2] || '';
            let args = '{}';
            // Try JSON first, then <arg> tags
            try {
                args = JSON.stringify(JSON.parse(body.trim()));
            } catch {
                const argMatches = [...body.matchAll(/<arg\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/arg>/g)];
                if (argMatches.length > 0) {
                    const argObj = {};
                    argMatches.forEach((am) => {
                        argObj[am[1].trim()] = am[2].trim();
                    });
                    args = JSON.stringify(argObj);
                }
            }
            matches.push({
                id: `call_${Date.now()}_${matches.length + 1}`,
                type: 'function',
                function: { name, arguments: args }
            });
        }

        // Pattern 3c: <function_call name="..." arguments={json} /> self-closing
        if (matches.length === 0) {
            for (const fm of chunk.matchAll(FUNC_CALL_ATTR_RE)) {
                const name = fm[1].trim();
                const rawArgs = fm[2].trim();
                let args = '{}';
                try {
                    const parsed = JSON.parse(rawArgs);
                    args = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
                } catch {
                    const jsonMatch = rawArgs.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        try {
                            args = JSON.stringify(JSON.parse(jsonMatch[0]));
                        } catch {
                            args = jsonMatch[0];
                        }
                    } else {
                        args = rawArgs;
                    }
                }
                matches.push({
                    id: `call_${Date.now()}_${matches.length + 1}`,
                    type: 'function',
                    function: { name, arguments: args }
                });
            }
        }

        // Pattern 4: Bare JSON (no XML tags) — {"name":"external__tool","arguments":{...}}
        // Only try if no XML-tagged calls were found
        if (matches.length === 0) {
            // Find all JSON objects that look like tool calls
            const jsonRegex = /\{[^{}]*"name"\s*:\s*"[^"]+"[^{}]*"arguments"\s*:\s*\{[^{}]*\}[^{}]*\}/g;
            const jsonMatches = [...chunk.matchAll(jsonRegex)];
            for (const jm of jsonMatches) {
                try {
                    const parsed = JSON.parse(jm[0]);
                    const name = parsed?.name || parsed?.function?.name;
                    const args = parsed?.arguments ?? parsed?.function?.arguments ?? {};
                    if (name) {
                        matches.push({
                            id: `call_${Date.now()}_${matches.length + 1}`,
                            type: 'function',
                            function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
                        });
                    }
                } catch {}
            }
        }

        // Pattern 5: XML-style <function=name> ... </function> with <parameter=name>value</parameter>
        if (matches.length === 0) {
            const funcTagRegex = /<function\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/function>/g;
            for (const fm of chunk.matchAll(funcTagRegex)) {
                const name = fm[1].trim();
                const body = fm[2];
                const args = {};
                const paramRegex = /<parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;
                for (const pm of body.matchAll(paramRegex)) {
                    args[pm[1].trim()] = pm[2].trim();
                }
                matches.push({
                    id: `call_${Date.now()}_${matches.length + 1}`,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) }
                });
            }
        }

        // Pattern 6: <invoke name="..."> with <arg name="...">value</arg>
        if (matches.length === 0) {
            const invokeRegex = /<invoke\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/g;
            for (const im of chunk.matchAll(invokeRegex)) {
                const name = im[1].trim();
                const body = im[2];
                const args = {};
                const argRegex = /<arg\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/arg>/g;
                for (const am of body.matchAll(argRegex)) {
                    args[am[1].trim()] = am[2].trim();
                }
                matches.push({
                    id: `call_${Date.now()}_${matches.length + 1}`,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) }
                });
            }
        }

        // Pattern 7: <tool_input> format — no tool name, only parameter tags.
        // Model outputs e.g. <tool_input><command>ls -la</command></tool_input>
        // We extract parameter names+values, then use findToolByParamNames to
        // identify the tool by matching parameter names against the registry.
        // This pattern runs even if other patterns matched, because the model
        // may mix formats across different tool calls in the same response.
        {
            const toolInputRegex = /<tool_input>([\s\S]*?)<\/tool_input>/g;
            for (const tim of chunk.matchAll(toolInputRegex)) {
                const body = tim[1];
                const args = {};
                const paramNames = [];
                // Extract <param_name>value</param_name> style parameters
                const paramRegex = /<([a-zA-Z_][a-zA-Z0-9_]*)>\s*([\s\S]*?)\s*<\/\1>/g;
                for (const pm of body.matchAll(paramRegex)) {
                    args[pm[1].trim()] = pm[2].trim();
                    paramNames.push(pm[1].trim());
                }
                if (paramNames.length === 0) continue;
                // Find the tool by parameter name matching — registry passed via
                // parseExternalToolCallsFromText which calls this function.
                // We set a placeholder name here; the registry lookup happens
                // in parseExternalToolCallsFromText via findToolByParamNames.
                matches.push({
                    id: `call_${Date.now()}_${matches.length + 1}`,
                    type: 'function',
                    function: {
                        name: `__param_inferred__${paramNames.join(',')}`,
                        arguments: JSON.stringify(args)
                    }
                });
            }
        }
    });
    return matches;
}

export function parseExternalToolCallsFromText(registry, ...chunks) {
    if (!Array.isArray(registry) || registry.length === 0) return [];
    const rawCalls = parseToolCallsFromText(...chunks);
    const counts = new Map();
    return rawCalls.flatMap((rawCall) => {
        const rawName = rawCall?.function?.name;
        // Handle <tool_input> format: name is __param_inferred__param1,param2,...
        if (rawName && rawName.startsWith('__param_inferred__')) {
            const paramNames = rawName.replace('__param_inferred__', '').split(',');
            const tool = findToolByParamNames(registry, paramNames);
            if (!tool) return [];
            const nextCount = (counts.get(tool.namespacedName) || 0) + 1;
            counts.set(tool.namespacedName, nextCount);
            return [{
                id: rawCall.id || `call_${tool.namespacedName.replace(/[^a-zA-Z0-9_]/g, '_')}_${nextCount}`,
                type: 'function',
                function: {
                    name: tool.originalName,
                    arguments: rawCall.function.arguments
                }
            }];
        }
        // Normal name-based lookup
        const tool = findExternalToolByName(registry, rawName);
        if (!tool) return [];
        const nextCount = (counts.get(tool.namespacedName) || 0) + 1;
        counts.set(tool.namespacedName, nextCount);
        return [{
            id: rawCall.id || `call_${tool.namespacedName.replace(/[^a-zA-Z0-9_]/g, '_')}_${nextCount}`,
            type: 'function',
            function: {
                name: tool.originalName,
                arguments: rawCall.function.arguments
            }
        }];
    });
}

// ─── Streaming filter: strip tool call markup from visible output ───
// Stateful filter that handles tool-call XML tags split across stream deltas.
// When a partial opening tag is detected at the end of a chunk (e.g. "<func"),
// it is held back until the next chunk completes or refutes the tag.
const PARTIAL_TAG_RE = /<\/?(?:func|tool|invoke|parameter|arg|function|tool_use|parameters|tool_input|function_name)?[a-z_=]*$/i;

export function createToolCallFilter({ disableTools, forceStrip = false }) {
    if (!disableTools && !forceStrip) return (chunk) => chunk;
    let inBlock = false;
    let pending = ''; // buffered tail that might be a partial tag
    return (chunk) => {
        if (!chunk) return chunk;
        // Prepend any pending partial tag from previous chunk
        let remaining = pending + chunk;
        pending = '';
        let output = '';
        while (remaining.length) {
            if (inBlock) {
                const close = matchCloseTag(remaining, 0);
                if (!close) {
                    // Still inside block — discard all, but check for partial close tag
                    const partialClose = remaining.match(/<\/?[a-z_=]*$/i);
                    if (partialClose) {
                        pending = partialClose[0];
                    }
                    return output;
                }
                remaining = remaining.slice(close.index + close.length);
                inBlock = false;
                continue;
            }
            const open = matchOpenTag(remaining);
            if (!open) {
                // Check for bare tool_name/tool_arguments tags
                const tnIdx = remaining.indexOf('<tool_name>');
                const tiIdx = remaining.indexOf('<tool_arguments>');
                const piIdx = remaining.indexOf('<parameters>');
                const tinIdx = remaining.indexOf('<tool_input>');
                const fnIdx = remaining.indexOf('<function_name>');
                // Also check for stray closing tags (model output bug)
                const closeMatch = remaining.match(/<\/(?:function_calls?|tool_calls?|tool_use[s]?|function|invoke|tool_name|parameters|tool_input|function_name)>/);
                if (tnIdx === -1 && tiIdx === -1 && piIdx === -1 && tinIdx === -1 && fnIdx === -1 && !closeMatch) {
                    // No opening tag found — but check if the tail looks like a partial tag
                    const partial = remaining.match(PARTIAL_TAG_RE);
                    if (partial) {
                        // Hold back the partial tag for next chunk
                        output += remaining.slice(0, remaining.length - partial[0].length);
                        pending = partial[0];
                        return output;
                    }
                    output += remaining;
                    return output;
                }
                // Handle stray closing tags
                if (closeMatch && tnIdx === -1 && tiIdx === -1 && piIdx === -1 && tinIdx === -1 && fnIdx === -1) {
                    const cutIdx = closeMatch.index;
                    output += remaining.slice(0, cutIdx);
                    remaining = remaining.slice(cutIdx + closeMatch[0].length);
                    continue;
                }
                const indices = [tnIdx, tiIdx, piIdx, tinIdx, fnIdx].filter(i => i !== -1);
                const cutIdx = Math.min(...indices);
                output += remaining.slice(0, cutIdx);
                remaining = remaining.slice(cutIdx);
                inBlock = true;
                continue;
            }
            output += remaining.slice(0, open.index);
            remaining = remaining.slice(open.index + open.length);
            inBlock = true;
        }
        // After processing, check if we ended on a partial tag while not in block
        if (!inBlock) {
            const partial = output.match(PARTIAL_TAG_RE);
            if (partial) {
                pending = partial[0];
                output = output.slice(0, output.length - partial[0].length);
            }
        }
        return output;
    };
}

// ─── Streaming parser: extract tool calls as they arrive ───
export function createExternalToolCallStreamParser(registry) {
    if (!Array.isArray(registry) || registry.length === 0) {
        return () => [];
    }
    const minTagLen = 8; // Minimum tag length to keep as lookbehind
    let buffer = '';
    return (chunk) => {
        if (!chunk) return [];
        buffer += chunk;
        const parsedCalls = [];

        while (buffer.length) {
            // Try to find any opening tag
            const open = matchOpenTag(buffer);
            // Also check bare tool_name format, tool_input format, and function_name format
            const bareNameIdx = buffer.indexOf('<tool_name>');
            const bareInputIdx = buffer.indexOf('<tool_input>');
            const bareFuncNameIdx = buffer.indexOf('<function_name>');

            if (!open && bareNameIdx === -1 && bareInputIdx === -1 && bareFuncNameIdx === -1) {
                // No opening tag found — keep tail for partial match
                buffer = buffer.slice(-minTagLen);
                break;
            }

            const startIdx = open ? open.index : Math.min(...[bareNameIdx, bareInputIdx, bareFuncNameIdx].filter(i => i !== -1));
            const openLen = open ? open.length : (startIdx === bareNameIdx ? '<tool_name>'.length : (startIdx === bareInputIdx ? '<tool_input>'.length : '<function_name>'.length));

            // Find closing tag
            let close = null;
            if (open) {
                close = matchCloseTag(buffer, startIdx + openLen);
            } else {
                // For bare format, find </tool_arguments>, </tool_input>, or </function_name>
                const argsClose = buffer.indexOf('</tool_arguments>', startIdx + openLen);
                const inputClose = buffer.indexOf('</tool_input>', startIdx + openLen);
                const funcNameClose = buffer.indexOf('</function_name>', startIdx + openLen);
                // Find the closest closing tag
                const closeIndices = [argsClose, inputClose, funcNameClose].filter(i => i !== -1);
                if (closeIndices.length > 0) {
                    const minClose = Math.min(...closeIndices);
                    if (minClose === inputClose) {
                        close = { index: inputClose, length: '</tool_input>'.length };
                    } else if (minClose === argsClose) {
                        close = { index: argsClose, length: '</tool_arguments>'.length };
                    } else {
                        close = { index: funcNameClose, length: '</function_name>'.length };
                    }
                }
            }

            if (!close) {
                // Block not complete yet — wait for more data
                buffer = buffer.slice(startIdx);
                break;
            }

            const block = buffer.slice(startIdx, close.index + close.length);
            parsedCalls.push(...parseExternalToolCallsFromText(registry, block));
            buffer = buffer.slice(close.index + close.length);
        }
        return parsedCalls;
    };
}

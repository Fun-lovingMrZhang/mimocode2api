import { findExternalToolByName } from './registry.js';

// ─── Flexible tag matching ───
// Models may output <function_calls>, <function_call>, <tool_call>, <tool_use>, etc.
// Also <function=name> and <parameter=name> (self-closing XML style).
const OPEN_TAG_RE = /<function_calls?>|<tool_calls?>|<tool_use[s]?>|<function(?:\s[^>]*)?>|<invoke\s+name=/;
const CLOSE_TAG_RE = /<\/function_calls?>|<\/tool_calls?>|<\/tool_use[s]?>|<\/function>|<\/invoke>/;
// Some models use <tool_name>...</tool_name><tool_arguments>...</tool_arguments>
const TOOL_NAME_RE = /<tool_name>\s*([\s\S]*?)\s*<\/tool_name>/g;
const TOOL_ARGS_RE = /<tool_arguments>\s*([\s\S]*?)\s*<\/tool_arguments>/g;
// Some models use <invoke name="..."> or <call name="...">
const INVOKE_RE = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/g;

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
    // Remove <parameter=name>...</parameter> leftovers
    cleaned = cleaned.replace(/<parameter\s*=\s*[^>]+>[\s\S]*?<\/parameter>/g, '');
    cleaned = cleaned.replace(/<\/?parameter\s*=\s*[^>]*>/g, '');
    // Remove <arg name="...">...</arg> leftovers
    cleaned = cleaned.replace(/<arg\s+name=[^>]+>[\s\S]*?<\/arg>/g, '');
    cleaned = cleaned.replace(/<\/?arg\s+name=[^>]*>/g, '');
    return trim ? cleaned.trim() : cleaned;
}

// ─── Parse raw tool calls from text (flexible format) ───
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
        // Not valid JSON — try tool_name/tool_arguments format
        const nameMatch = content.match(TOOL_NAME_SINGLE);
        const argsMatch = content.match(TOOL_ARGS_SINGLE);
        if (nameMatch) {
            const name = nameMatch[1].trim();
            let args = '{}';
            if (argsMatch) {
                try {
                    const parsedArgs = JSON.parse(argsMatch[1].trim());
                    args = JSON.stringify(parsedArgs);
                } catch {
                    args = argsMatch[1].trim();
                }
            }
            calls.push({ name, arguments: args });
        }

        // Try <invoke name="..."> format
        const invokeMatch = content.match(INVOKE_SINGLE);
        if (invokeMatch) {
            const name = invokeMatch[1].trim();
            let args = '{}';
            try {
                args = JSON.stringify(JSON.parse(invokeMatch[2].trim()));
            } catch {}
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
        const nameMatches = [...chunk.matchAll(TOOL_NAME_RE)];
        nameMatches.forEach((nm, index) => {
            const name = nm[1].trim();
            // Find corresponding arguments (next tool_arguments block after this tool_name)
            const afterName = chunk.slice(nm.index + nm[0].length);
            const argsMatch = afterName.match(TOOL_ARGS_RE);
            let args = '{}';
            if (argsMatch) {
                try {
                    args = JSON.stringify(JSON.parse(argsMatch[1].trim()));
                } catch {
                    args = argsMatch[1].trim();
                }
            }
            matches.push({
                id: `call_${Date.now()}_${matches.length + index + 1}`,
                type: 'function',
                function: { name, arguments: args }
            });
        });

        // Pattern 3: <invoke name="...">...</invoke>
        for (const invoke of chunk.matchAll(INVOKE_RE)) {
            const name = invoke[1].trim();
            let args = '{}';
            try {
                args = JSON.stringify(JSON.parse(invoke[2].trim()));
            } catch {}
            matches.push({
                id: `call_${Date.now()}_${matches.length + 1}`,
                type: 'function',
                function: { name, arguments: args }
            });
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
    });
    return matches;
}

export function parseExternalToolCallsFromText(registry, ...chunks) {
    if (!Array.isArray(registry) || registry.length === 0) return [];
    const rawCalls = parseToolCallsFromText(...chunks);
    const counts = new Map();
    return rawCalls.flatMap((rawCall) => {
        const tool = findExternalToolByName(registry, rawCall?.function?.name);
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
const PARTIAL_TAG_RE = /<\/?(?:func|tool|invoke|parameter|arg|function|tool_use)?[a-z_=]*$/i;

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
                // Also check for stray closing tags (model output bug)
                const closeMatch = remaining.match(/<\/(?:function_calls?|tool_calls?|tool_use[s]?|function|invoke)>/);
                if (tnIdx === -1 && tiIdx === -1 && !closeMatch) {
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
                if (closeMatch && tnIdx === -1 && tiIdx === -1) {
                    const cutIdx = closeMatch.index;
                    output += remaining.slice(0, cutIdx);
                    remaining = remaining.slice(cutIdx + closeMatch[0].length);
                    continue;
                }
                const cutIdx = tnIdx !== -1 ? (tiIdx !== -1 ? Math.min(tnIdx, tiIdx) : tnIdx) : tiIdx;
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
            // Also check bare tool_name format
            const bareNameIdx = buffer.indexOf('<tool_name>');

            if (!open && bareNameIdx === -1) {
                // No opening tag found — keep tail for partial match
                buffer = buffer.slice(-minTagLen);
                break;
            }

            const startIdx = open ? open.index : bareNameIdx;
            const openLen = open ? open.length : '<tool_name>'.length;

            // Find closing tag
            let close = null;
            if (open) {
                close = matchCloseTag(buffer, startIdx + openLen);
            } else {
                // For bare format, find </tool_arguments>
                const argsClose = buffer.indexOf('</tool_arguments>', startIdx + openLen);
                if (argsClose !== -1) {
                    close = { index: argsClose, length: '</tool_arguments>'.length };
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

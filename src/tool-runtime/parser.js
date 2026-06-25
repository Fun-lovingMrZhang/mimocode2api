import { findExternalToolByName } from './registry.js';

// ─── Flexible tag matching ───
// Models may output <function_calls>, <function_call>, <tool_call>, <tool_use>, etc.
// This regex matches any of these as opening/closing tags.
const OPEN_TAG_RE = /<function_calls?>|<tool_calls?>|<tool_use[s]?>/;
const CLOSE_TAG_RE = /<\/function_calls?>|<\/tool_calls?>|<\/tool_use[s]?>/;
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
    // Remove loose tags
    cleaned = cleaned.replace(/<\/?function_calls?>/g, '');
    cleaned = cleaned.replace(/<\/?tool_calls?>/g, '');
    cleaned = cleaned.replace(/<\/?tool_use[s]?>/g, '');
    // Remove tool_name/tool_arguments pairs
    cleaned = cleaned.replace(/<tool_name>[\s\S]*?<\/tool_name>/g, '');
    cleaned = cleaned.replace(/<tool_arguments>[\s\S]*?<\/tool_arguments>/g, '');
    // Remove invoke tags
    cleaned = cleaned.replace(/<invoke\s+name=["'][^"']+["']\s*>[\s\S]*?<\/invoke>/g, '');
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
export function createToolCallFilter({ disableTools, forceStrip = false }) {
    if (!disableTools && !forceStrip) return (chunk) => chunk;
    let inBlock = false;
    return (chunk) => {
        if (!chunk) return chunk;
        let output = '';
        let remaining = chunk;
        while (remaining.length) {
            if (inBlock) {
                const close = matchCloseTag(remaining, 0);
                if (!close) {
                    // Still inside block, discard
                    return output;
                }
                remaining = remaining.slice(close.index + close.length);
                inBlock = false;
                continue;
            }
            const open = matchOpenTag(remaining);
            if (!open) {
                // Also check for tool_name/tool_arguments bare tags
                const tnIdx = remaining.indexOf('<tool_name>');
                const tiIdx = remaining.indexOf('<tool_arguments>');
                if (tnIdx === -1 && tiIdx === -1) {
                    output += remaining;
                    return output;
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

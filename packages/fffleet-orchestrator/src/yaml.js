// A small YAML reader for the orchestrator's config file, so no dependency is needed.
//
// Supported: block mappings and sequences (spaces only), `key: value` items inside sequences,
// single-line flow sequences and mappings (`[a, b]`, `{ a: 1 }`), plain, 'single' and "double"
// quoted scalars, null (`~`, `null`, empty), booleans, numbers and # comments.
// Not supported, and rejected with an error: anchors and aliases, tags, multi-line scalars
// (`|`, `>`), multiple documents and tabs for indentation. JSON is valid input too.

const fail = (no, message) => {
  throw new Error(`config line ${no}: ${message}`);
};

/** Removes a trailing comment: a `#` at the start or after whitespace, outside quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(line[i - 1]))) quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function unquote(text, no) {
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return fail(no, `bad double-quoted string ${text}`);
    }
  }
  return text.slice(1, -1).replace(/''/g, "'");
}

function scalar(text, no) {
  const t = text.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^[-+]?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t[0] === '"' || t[0] === "'") {
    if (t.length < 2 || t.at(-1) !== t[0]) fail(no, `unterminated string ${t}`);
    return unquote(t, no);
  }
  if (/^[&*!|>]/.test(t)) fail(no, `"${t[0]}" (anchors, aliases, tags and multi-line strings) is not supported`);
  return t;
}

/** Parses a single-line flow value: [a, b], { a: 1 } or a scalar. */
function flow(text, no) {
  let i = 0;
  const skip = () => {
    while (text[i] === ' ') i++;
  };
  function quoted() {
    const q = text[i];
    const start = i++;
    while (i < text.length && text[i] !== q) i += text[i] === '\\' && q === '"' ? 2 : 1;
    if (text[i] !== q) fail(no, 'unterminated string in a flow value');
    i++;
    return unquote(text.slice(start, i), no);
  }
  function bare(stops) {
    const start = i;
    while (i < text.length && !stops.includes(text[i])) i++;
    return text.slice(start, i).trim();
  }
  function value() {
    skip();
    if (text[i] === '[') {
      i++;
      const out = [];
      skip();
      while (text[i] !== ']') {
        out.push(value());
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== ']') fail(no, 'expected "," or "]"');
        skip();
      }
      i++;
      return out;
    }
    if (text[i] === '{') {
      i++;
      const out = {};
      skip();
      while (text[i] !== '}') {
        skip();
        const key = text[i] === '"' || text[i] === "'" ? quoted() : bare(':,}');
        skip();
        if (text[i] !== ':') fail(no, `expected ":" after "${key}"`);
        i++;
        out[key] = value();
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== '}') fail(no, 'expected "," or "}"');
        skip();
      }
      i++;
      return out;
    }
    if (text[i] === '"' || text[i] === "'") return quoted();
    return scalar(bare(',]}'), no);
  }
  const result = value();
  skip();
  if (i < text.length) fail(no, `unexpected "${text.slice(i)}"`);
  return result;
}

const inline = (text, no) => (/^[[{]/.test(text.trim()) ? flow(text.trim(), no) : scalar(text, no));

/** Finds the `key: value` split of a line, or null when it is not a mapping entry. */
function splitKey(text, no) {
  if (text[0] === '"' || text[0] === "'") {
    let i = 1;
    while (i < text.length && text[i] !== text[0]) i += text[i] === '\\' && text[0] === '"' ? 2 : 1;
    if (text[i] !== text[0] || text[i + 1] !== ':') return null;
    const rest = text.slice(i + 2);
    if (rest !== '' && !/^\s/.test(rest)) return null;
    return { key: unquote(text.slice(0, i + 1), no), value: rest.trim() };
  }
  if (/^[[{]/.test(text)) return null;
  // The key ends at the first ":" that is followed by a space or the end of the line.
  const m = text.match(/^(.*?):(?:\s+(.*))?$/);
  return m ? { key: m[1].trim(), value: (m[2] ?? '').trim() } : null;
}

export function parseYaml(source) {
  const lines = [];
  source.split(/\r?\n/).forEach((raw, idx) => {
    const no = idx + 1;
    const stripped = stripComment(raw).replace(/\s+$/, '');
    if (!stripped.trim()) return;
    const indent = stripped.match(/^[ \t]*/)[0];
    if (indent.includes('\t')) fail(no, 'tabs cannot be used for indentation');
    if (stripped.trim() === '---' && !lines.length) return;
    if (stripped.trim() === '---' || stripped.trim() === '...') fail(no, 'multiple documents are not supported');
    lines.push({ indent: indent.length, text: stripped.trim(), no });
  });
  let pos = 0;

  const isSeq = l => l.text === '-' || l.text.startsWith('- ');

  function node(indent) {
    const line = lines[pos];
    if (isSeq(line)) return seq(line.indent);
    if (splitKey(line.text, line.no)) return map(line.indent);
    pos++;
    return inline(line.text, line.no);
  }

  function child(parentIndent, allowSameIndentSeq) {
    const next = lines[pos];
    if (next && next.indent > parentIndent) return node(next.indent);
    if (allowSameIndentSeq && next && next.indent === parentIndent && isSeq(next)) return seq(parentIndent);
    return null;
  }

  function map(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent && !isSeq(lines[pos])) {
      const { text, no } = lines[pos];
      const kv = splitKey(text, no);
      if (!kv) fail(no, `expected "key: value", got "${text}"`);
      if (Object.hasOwn(out, kv.key)) fail(no, `duplicate key "${kv.key}"`);
      pos++;
      out[kv.key] = kv.value === '' ? child(indent, true) : inline(kv.value, no);
    }
    if (pos < lines.length && lines[pos].indent > indent) fail(lines[pos].no, 'unexpected indentation');
    return out;
  }

  function seq(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && isSeq(lines[pos])) {
      const line = lines[pos];
      const rest = line.text.slice(1).trim();
      if (!rest) {
        pos++;
        out.push(child(indent, false));
      } else if (splitKey(rest, line.no) && !/^["'[{]/.test(rest.split(':')[0])) {
        // "- key: value": the mapping continues on the following lines at the column of "key".
        const offset = line.text.length - rest.length;
        lines[pos] = { indent: indent + offset, text: rest, no: line.no };
        out.push(map(indent + offset));
      } else {
        pos++;
        out.push(inline(rest, line.no));
      }
    }
    if (pos < lines.length && lines[pos].indent > indent) fail(lines[pos].no, 'unexpected indentation');
    return out;
  }

  if (!lines.length) return null;
  const result = node(lines[0].indent);
  if (pos < lines.length) fail(lines[pos].no, 'unexpected content');
  return result;
}

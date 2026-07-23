'use strict';

// Conservative bash tokenizer/parser for Action IR.
// Never executes input. Prefers uncertainty over claiming false certainty.

const INTERPRETER_FLAGS = new Set(['-c', '-lc', '-ic', '-ilc', '-lic']);
const INTERPRETER_NAMES = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'node', 'ruby', 'perl'
]);
const NESTED_EVAL = new Set(['eval', 'source', '.']);

function isOperator(tok) {
  return tok && tok.kind === 'op';
}

function isMetaOp(value) {
  return value === ';' || value === '&&' || value === '||' || value === '|' ||
    value === '&' || value === '\n' || value === '|&';
}

/**
 * Tokenize a shell command string.
 * Returns tokens: { kind: 'word'|'op'|'redir', value, quoted, span:[start,end], uncertainty? }
 */
function tokenizeConservative(command) {
  const s = String(command || '');
  const tokens = [];
  const uncertainty = [];
  let i = 0;
  const n = s.length;

  const pushWord = (value, start, end, quoted, kinds) => {
    tokens.push({
      kind: 'word',
      value,
      quoted: !!quoted,
      quote_kind: kinds || null,
      span: [start, end]
    });
  };

  while (i < n) {
    const c = s[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }

    // newline as statement separator
    if (c === '\n') {
      tokens.push({ kind: 'op', value: '\n', quoted: false, span: [i, i + 1] });
      i++;
      continue;
    }

    // comments — only when at token boundary
    if (c === '#') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }

    // operators (2-char first)
    if (i + 1 < n) {
      const two = s.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '|&' || two === '>>' || two === '<<' || two === '2>' || two === '&>') {
        if (two === '>>' || two === '<<' || two === '2>' || two === '&>') {
          tokens.push({ kind: 'redir', value: two, quoted: false, span: [i, i + 2] });
        } else {
          tokens.push({ kind: 'op', value: two, quoted: false, span: [i, i + 2] });
        }
        i += 2;
        continue;
      }
    }

    if (c === '|' || c === ';' || c === '&') {
      tokens.push({ kind: 'op', value: c, quoted: false, span: [i, i + 1] });
      i++;
      continue;
    }

    if (c === '>' || c === '<') {
      tokens.push({ kind: 'redir', value: c, quoted: false, span: [i, i + 1] });
      i++;
      continue;
    }

    // parentheses / subshell — record uncertainty, keep as word-ish boundary ops
    if (c === '(' || c === ')' || c === '{' || c === '}') {
      tokens.push({ kind: 'op', value: c, quoted: false, span: [i, i + 1] });
      uncertainty.push({ code: 'group-boundary', span: [i, i + 1], detail: c });
      i++;
      continue;
    }

    // quoted strings
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      const start = i;
      i++;
      let body = '';
      let closed = false;
      while (i < n) {
        if (s[i] === q) {
          // handle escaped double-quote / backtick
          if (q !== "'" && i > 0 && s[i - 1] === '\\') {
            body += s[i];
            i++;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        // $() and ${} inside double quotes — uncertainty (may expand to executable text)
        if (q === '"' && s[i] === '$' && (s[i + 1] === '(' || s[i + 1] === '{')) {
          uncertainty.push({ code: 'expansion-in-quotes', span: [i, i + 2] });
        }
        if (q === '`' ) {
          uncertainty.push({ code: 'backtick-command-sub', span: [start, i + 1] });
        }
        body += s[i];
        i++;
      }
      if (!closed) {
        uncertainty.push({ code: 'unclosed-quote', span: [start, i], quote: q });
      }
      pushWord(body, start, i, true, q === "'" ? 'single' : q === '"' ? 'double' : 'backtick');
      if (q === '`') {
        // backtick content is potentially executable
        tokens[tokens.length - 1].potentially_executable = true;
      }
      continue;
    }

    // $() command substitution
    if (c === '$' && s[i + 1] === '(') {
      const start = i;
      i += 2;
      let depth = 1;
      let body = '';
      while (i < n && depth > 0) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') depth--;
        if (depth > 0) body += s[i];
        i++;
      }
      uncertainty.push({ code: 'command-substitution', span: [start, i] });
      tokens.push({
        kind: 'word',
        value: body,
        quoted: false,
        potentially_executable: true,
        substitution: true,
        span: [start, i]
      });
      continue;
    }

    // bare word
    const start = i;
    let body = '';
    while (i < n) {
      const ch = s[i];
      if (/[\s;&|<>(){}`]/.test(ch)) break;
      if (ch === "'" || ch === '"') break;
      // keep $VAR as part of word
      body += ch;
      i++;
    }
    if (body.length) {
      const hasGlob = /[*?[]/.test(body);
      pushWord(body, start, i, false, null);
      if (hasGlob) tokens[tokens.length - 1].has_glob = true;
      if (/\$\{?[\w{]/.test(body) || body.includes('$(')) {
        uncertainty.push({ code: 'expansion', span: [start, i] });
      }
    } else {
      // unknown char — skip with uncertainty
      uncertainty.push({ code: 'skipped-char', span: [i, i + 1], detail: s[i] });
      i++;
    }
  }

  return { tokens, uncertainty };
}

function stripFlags(argv) {
  const flags = [];
  const operands = [];
  let endFlags = false;
  for (const a of argv) {
    if (!endFlags && a === '--') {
      endFlags = true;
      continue;
    }
    if (!endFlags && a.startsWith('-') && a !== '-') {
      flags.push(a);
    } else {
      operands.push(a);
    }
  }
  return { flags, operands };
}

// GNU long flags carry the same meaning as their short forms, and predicates
// reason in short letters. Without this mapping `rm --recursive --force` reads as
// non-recursive and slips every rm predicate.
const LONG_FLAG_LETTERS = {
  '--recursive': 'r',
  '--dir': 'd',
  '--force': 'f',
  '--verbose': 'v',
  '--interactive': 'i'
};

function expandClusterFlags(flags) {
  // "-rf" → consider r and f present
  const set = new Set();
  for (const f of flags) {
    if (f.startsWith('--')) {
      set.add(f);
      const letter = LONG_FLAG_LETTERS[f.split('=')[0]];
      if (letter) set.add(letter);
      continue;
    }
    if (f.startsWith('-') && f.length > 1) {
      for (const ch of f.slice(1)) set.add(ch);
    }
  }
  return set;
}

function groupExecutableSegments(tokens, topUncertainty = []) {
  const segments = [];
  let current = [];
  const flush = (opAfter) => {
    if (!current.length) return;
    const words = current.filter(t => t.kind === 'word');
    const redirs = current.filter(t => t.kind === 'redir');
    if (!words.length && !redirs.length) {
      current = [];
      return;
    }
    const argv = words.map(w => w.value);
    const executable = (argv[0] || '').replace(/^\\/, '');
    const rest = argv.slice(1);
    const { flags, operands } = stripFlags(rest);
    const flagSet = expandClusterFlags(flags);

    const wildcard_operands = [];
    const quoted_literals = [];
    words.forEach((w, idx) => {
      if (idx === 0) return;
      if (w.quoted) quoted_literals.push(idx - 1);
      // operand index among argv (including flags) — use rest index
      const restIdx = idx - 1;
      if (!w.quoted && (w.has_glob || /[*?]/.test(w.value))) {
        // map to argv index in full argv (rest is argv without executable)
        wildcard_operands.push(restIdx);
      }
    });

    segments.push({
      executable,
      argv: rest,
      full_argv: argv,
      flags,
      flag_set: [...flagSet],
      operands,
      operators: opAfter ? [opAfter] : [],
      redirections: redirs.map(r => r.value),
      wildcard_operands,
      quoted_literals,
      heredoc_bodies: [],
      interpreter_boundary: null,
      words,
      uncertainty: [],
      span: words.length
        ? [words[0].span[0], words[words.length - 1].span[1]]
        : null
    });
    current = [];
  };

  for (const tok of tokens) {
    if (tok.kind === 'op' && isMetaOp(tok.value)) {
      flush(tok.value);
      continue;
    }
    if (tok.kind === 'op' && (tok.value === '(' || tok.value === ')')) {
      flush(tok.value);
      continue;
    }
    current.push(tok);
  }
  flush(null);

  // attach top-level uncertainty references
  if (topUncertainty.length && segments.length) {
    segments[0].uncertainty = segments[0].uncertainty.concat(
      topUncertainty.map(u => ({ ...u, scope: 'command' }))
    );
  }
  return segments;
}

function inspectNestedInterpreters(segments) {
  for (const seg of segments) {
    const exe = (seg.executable || '').toLowerCase();
    const base = exe.split('/').pop();

    // bash -c "..." / sh -c '...'
    if (INTERPRETER_NAMES.has(base)) {
      const cIdx = seg.argv.findIndex(a => INTERPRETER_FLAGS.has(a) || a === '-c');
      if (cIdx !== -1 && seg.argv[cIdx + 1] != null) {
        const nestedCmd = seg.argv[cIdx + 1];
        const nested = parseBashCommand(nestedCmd);
        seg.interpreter_boundary = {
          kind: 'shell-c',
          interpreter: base,
          flag: seg.argv[cIdx],
          nested_segments: nested.segments
        };
        // promote nested mutation visibility
        for (const ns of nested.segments) {
          if (ns.executable) {
            seg.uncertainty.push({
              code: 'nested-executable',
              executable: ns.executable,
              argv: ns.argv
            });
          }
        }
      }
    }

    // eval "rm ..."
    if (NESTED_EVAL.has(base) || base === 'eval') {
      const joined = seg.argv.join(' ');
      if (joined) {
        const nested = parseBashCommand(joined);
        seg.interpreter_boundary = {
          kind: base === '.' || base === 'source' ? 'source' : 'eval',
          interpreter: base,
          nested_segments: nested.segments
        };
      }
    }

    // xargs rm ...
    if (base === 'xargs') {
      // find first non-flag as nested executable
      let i = 0;
      while (i < seg.argv.length && seg.argv[i].startsWith('-')) i++;
      if (i < seg.argv.length) {
        seg.interpreter_boundary = {
          kind: 'xargs',
          interpreter: 'xargs',
          nested_executable: seg.argv[i],
          nested_argv: seg.argv.slice(i + 1)
        };
        seg.uncertainty.push({
          code: 'xargs-executable',
          executable: seg.argv[i]
        });
      }
    }

    // command substitution words marked potentially_executable
    for (const w of seg.words || []) {
      if (w.potentially_executable && w.value) {
        const nested = parseBashCommand(w.value);
        for (const ns of nested.segments) {
          if (ns.executable) {
            seg.uncertainty.push({
              code: 'subst-executable',
              executable: ns.executable,
              argv: ns.argv
            });
          }
        }
      }
    }
  }
  return segments;
}

function identifyMutationTargets(segments, context = {}) {
  const targets = [];
  for (const seg of segments) {
    const base = (seg.executable || '').split('/').pop();
    if (base === 'rm' || base === 'rmdir' || base === 'unlink') {
      for (const op of seg.operands || []) {
        targets.push(op);
      }
    }
    if (base === 'mv' || base === 'cp') {
      // last operand is destination; sources may be mutated for mv
      if (seg.operands && seg.operands.length) {
        targets.push(...seg.operands);
      }
    }
    if (base === 'git' && (seg.argv[0] === 'clean' || seg.argv[0] === 'reset')) {
      targets.push(...(seg.operands || []).slice(1));
    }
    // nested
    if (seg.interpreter_boundary && seg.interpreter_boundary.nested_segments) {
      const nested = identifyMutationTargets(seg.interpreter_boundary.nested_segments, context);
      targets.push(...nested);
    }
  }
  return targets;
}

function parseBashCommand(command) {
  const { tokens, uncertainty } = tokenizeConservative(command);
  let segments = groupExecutableSegments(tokens, uncertainty);
  segments = inspectNestedInterpreters(segments);
  const mutation_targets = identifyMutationTargets(segments);
  return { segments, mutation_targets, uncertainty, tokens };
}

module.exports = {
  tokenizeConservative,
  groupExecutableSegments,
  inspectNestedInterpreters,
  identifyMutationTargets,
  parseBashCommand,
  stripFlags,
  expandClusterFlags,
  LONG_FLAG_LETTERS
};

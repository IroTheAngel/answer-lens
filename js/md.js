// Small, safe Markdown + maths renderer. Everything is HTML-escaped first,
// so text from the AI can never inject tags into the panel.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const SYM = {
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥',
  neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', infty: '∞', pi: 'π', theta: 'θ',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', lambda: 'λ', mu: 'μ', sigma: 'σ',
  Sigma: 'Σ', omega: 'ω', Omega: 'Ω', phi: 'φ', rho: 'ρ', epsilon: 'ε', tau: 'τ', sum: '∑',
  prod: '∏', int: '∫', partial: '∂', nabla: '∇', rightarrow: '→', to: '→', leftarrow: '←',
  Rightarrow: '⇒', Leftarrow: '⇐', iff: '⇔', implies: '⇒', degree: '°', circ: '°', angle: '∠',
  triangle: '△', perp: '⊥', parallel: '∥', in: '∈', notin: '∉', subset: '⊂', cup: '∪', cap: '∩',
  emptyset: '∅', forall: '∀', exists: '∃', therefore: '∴', because: '∵', ldots: '…', dots: '…',
  cdots: '⋯', quad: '  ', qquad: '    ', percent: '%', lbrace: '{', rbrace: '}', lvert: '|', rvert: '|',
  mid: '|', vert: '|', log: 'log', ln: 'ln', sin: 'sin', cos: 'cos', tan: 'tan', lim: 'lim',
};

// Turns simple LaTeX (fractions, roots, powers, symbols) into HTML.
export function math(t) {
  let i = 0;
  const group = () => {
    if (t[i] === '{') {
      i++;
      const out = seq('}');
      i++;
      return out;
    }
    if (t[i] === '\\') return cmd();
    return t[i++] ?? '';
  };
  const cmd = () => {
    i++;
    let name = '';
    while (i < t.length && /[a-zA-Z]/.test(t[i])) name += t[i++];
    if (!name) {
      const c = t[i++] ?? '';
      return ',;: !'.includes(c) ? ' ' : c;
    }
    if (/^[dt]?frac$/.test(name)) {
      const a = group();
      const b = group();
      return `<span class="frac"><span>${a}</span><span>${b}</span></span>`;
    }
    if (name === 'sqrt') {
      let idx = '';
      if (t[i] === '[') {
        const j = t.indexOf(']', i);
        idx = t.slice(i + 1, j);
        i = j + 1;
      }
      return `${idx ? `<sup>${idx}</sup>` : ''}√<span class="sqrt">${group()}</span>`;
    }
    if (['text', 'mathrm', 'textbf', 'mathbf', 'operatorname', 'boxed', 'mathit', 'textit'].includes(name)) return group();
    if (name === 'left' || name === 'right') {
      if (t[i] === '.') { i++; return ''; }
      return t[i] === '\\' ? cmd() : t[i++] ?? '';
    }
    return SYM[name] ?? name;
  };
  const seq = (end) => {
    let out = '';
    while (i < t.length && t[i] !== end) {
      const c = t[i];
      if (c === '^' || c === '_') {
        i++;
        const g = group();
        out += c === '^' ? `<sup>${g}</sup>` : `<sub>${g}</sub>`;
      } else if (c === '\\') {
        out += cmd();
      } else if (c === '{') {
        i++;
        out += seq('}');
        i++;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  };
  return seq(undefined);
}

function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>');
}

export function md(src) {
  const code = [];
  const mathBits = [];
  let s = String(src);
  // Pull out code blocks and maths first so nothing else touches them.
  s = s.replace(/```[\w+-]*\n?([\s\S]*?)(```|$)/g, (m, c) => {
    code.push(c.replace(/\n$/, ''));
    return `\u0001C${code.length - 1}\u0001`;
  });
  s = s.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (m, a, b) => {
    mathBits.push(`<div class="math block">${math(esc(a ?? b).trim())}</div>`);
    return `\u0001M${mathBits.length - 1}\u0001`;
  });
  s = s.replace(/\\\((.+?)\\\)|\$(?=\S)([^$\n]+?)(?<=\S)\$(?!\d)/g, (m, a, b) => {
    mathBits.push(`<span class="math">${math(esc(a ?? b))}</span>`);
    return `\u0001M${mathBits.length - 1}\u0001`;
  });
  s = esc(s);

  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of s.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) {
      flushPara();
      closeList();
    } else if ((m = line.match(/^\s*(#{1,4})\s+(.*)$/))) {
      flushPara();
      closeList();
      out.push(`<h4>${inline(m[2])}</h4>`);
    } else if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(m[2])}</li>`);
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (/^\u0001C\d+\u0001$/.test(line.trim())) {
      flushPara();
      closeList();
      out.push(line.trim());
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara();
  closeList();
  return out
    .join('')
    .replace(/\u0001C(\d+)\u0001/g, (m, n) => `<pre><button class="code-copy" type="button">Copy</button><code>${esc(code[n])}</code></pre>`)
    .replace(/\u0001M(\d+)\u0001/g, (m, n) => mathBits[n]);
}

// Plain text for copying: drops Markdown marks but keeps the words.
export function plain(src) {
  return String(src)
    .replace(/```[\w+-]*\n?/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/^#+\s*/gm, '')
    .trim();
}

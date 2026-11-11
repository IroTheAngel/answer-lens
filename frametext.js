// Answer Lens: reads the text you can see in this frame, including maths
// (KaTeX, MathJax 2/3/4 and MathML), and where each piece is on screen.
// It runs in every frame, so questions inside embedded frames can be read.
// Nothing happens until Answer Lens asks for it during a snap.
(() => {
  if (globalThis.__alCollect) return;

  // Maths renderers draw numbers and letters with fonts, CSS or SVG, so their
  // plain text is often missing. Text inside these is read as one maths piece.
  const MATH = '.katex, mjx-container, .MathJax, .MathJax_Display, .MathJax_SVG, .MathJax_CHTML, .MathJax_Preview, mjx-assistive-mml, .MJX_Assistive_MathML, math';

  const cleanTex = (t) => String(t)
    .replace(/\\(?:quad|qquad|[,;:! ])/g, ' ')
    .replace(/\\(?:left|right|displaystyle|textstyle|limits)\b/g, '')
    .replace(/\\(?:text|textrm|mathrm|mathit|mathbf|operatorname)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  // MathML to plain text: fractions as a/b, powers as a^b.
  function mml(n) {
    if (n.nodeType === 3) return n.nodeValue.trim();
    if (n.nodeType !== 1) return '';
    const tag = n.localName;
    if (tag === 'annotation' || tag === 'annotation-xml') return '';
    if (tag === 'mspace') return ' ';
    const k = [...n.childNodes].map(mml).filter((s) => s !== '');
    const w = (s) => (s && s.trim().length > 1 ? `(${s.trim()})` : (s || '').trim());
    switch (tag) {
      case 'semantics': return k[0] || '';
      case 'mfrac': return `${w(k[0])}/${w(k[1])}`;
      case 'msup': return `${k[0]}^${w(k[1])}`;
      case 'msub': return `${k[0]}_${w(k[1])}`;
      case 'msubsup': return `${k[0]}_${w(k[1])}^${w(k[2])}`;
      case 'msqrt': return `√${w(k.join(''))}`;
      case 'mroot': return `${w(k[1])}√${w(k[0])}`;
      case 'mo': {
        const s = k.join('');
        return /^[=+\-−×÷<>≤≥≠±]$/.test(s) ? ` ${s} ` : s;
      }
      default: return k.join('');
    }
  }

  function mathText(m) {
    const tex = m.querySelector('annotation[encoding="application/x-tex"]');
    if (tex) return cleanTex(tex.textContent);
    return mml(m).normalize('NFKC').replace(/\s+/g, ' ').trim();
  }

  // MathJax 3/4: use its hidden MathML copy, else read each character from
  // its class name (mjx-c1D45A = 𝑚) or SVG data-c attribute.
  function mjxText(c) {
    const copy = c.querySelector('mjx-assistive-mml math');
    if (copy) return mathText(copy);
    let s = '';
    c.querySelectorAll('mjx-c, [data-c]').forEach((e) => {
      let hex = e.getAttribute('data-c');
      if (!hex) {
        const m = [...e.classList].map((x) => x.match(/^mjx-c([0-9A-F]+)$/i)).find(Boolean);
        hex = m && m[1];
      }
      if (hex) {
        try { s += String.fromCodePoint(parseInt(hex, 16)); } catch (err) { /* not a character */ }
      } else s += e.textContent;
    });
    s = s.normalize('NFKC').trim();
    return s || c.textContent.normalize('NFKC').trim() || c.getAttribute('aria-label') || '';
  }

  globalThis.__alCollect = function collect() {
    const body = document.body || document.documentElement;
    if (!body) return null;
    const W = innerWidth;
    const H = innerHeight;
    const onScreen = (b) => b.width > 0 && b.height > 0 && b.right > 0 && b.bottom > 0 && b.left < W && b.top < H;
    const shown = (el) => {
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.opacity !== '0';
    };
    const box = (b) => ({ left: b.left, right: b.right, top: b.top, bottom: b.bottom });
    const bits = []; // { t, rects }

    // Normal text.
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const range = document.createRange();
    let n;
    let seen = 0;
    while ((n = walker.nextNode()) && seen < 20000) {
      seen++;
      const p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName) || p.closest(MATH)) continue;
      range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter(onScreen);
      if (!rects.length || !shown(p)) continue;
      bits.push({ t: n.nodeValue.replace(/\s+/g, ' ').trim(), rects: rects.map(box) });
    }

    // Typed answers in text boxes.
    for (const f of document.querySelectorAll('input[type=text], input:not([type]), textarea')) {
      const b = f.getBoundingClientRect();
      if (f.value && onScreen(b)) bits.push({ t: f.value.trim(), rects: [box(b)] });
    }

    // Maths, as one piece each, written as $...$.
    const add = (el, text) => {
      if (!el || !text) return;
      const b = el.getBoundingClientRect();
      if (onScreen(b) && shown(el)) bits.push({ t: `$${text}$`, rects: [box(b)] });
    };
    document.querySelectorAll('.katex').forEach((k) => {
      if (k.parentElement && k.parentElement.closest('.katex')) return;
      const tex = k.querySelector('annotation[encoding="application/x-tex"]');
      const vis = k.querySelector('.katex-html') || k;
      add(vis, tex ? cleanTex(tex.textContent) : vis.textContent.normalize('NFKC').trim());
    });
    document.querySelectorAll('mjx-container').forEach((c) => add(c, mjxText(c)));
    document.querySelectorAll('script[type^="math/tex"]').forEach((s) => {
      // MathJax 2 keeps the TeX in a script right after what it drew.
      let r = s.previousElementSibling;
      while (r && r.classList.contains('MathJax_Preview')) r = r.previousElementSibling;
      add(r, cleanTex(s.textContent));
    });
    document.querySelectorAll('math').forEach((m) => {
      if (m.parentElement && m.parentElement.closest(MATH)) return;
      add(m, mathText(m));
    });

    return { href: location.href, w: W, h: H, bits };
  };
})();

// DOM helpers shared by app.js and ops.js. Text goes in through
// textContent, never innerHTML, because messages and results are untrusted.

/** localStorage, or undefined when the browser blocks it. */
export function storage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Appends children, skipping null and false (append would print "null"). */
export function appendAll(node, ...children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c);
  }
}

/** A warning triangle, for status lines that also carry a text label. */
export function warnIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'warn-icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M10 2.5 18.5 17h-17L10 2.5Zm0 5.5v4.5m0 2.25v.25');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.75');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

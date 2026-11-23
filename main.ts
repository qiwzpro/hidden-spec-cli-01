// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** File text split into lines at its own break, with its final-break flag. */
function splitFile(text: string): { lines: string[]; br: string; ends: boolean } {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}
function joinFile(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}
const trimT = (s: string): string => s.replace(/[ \t]+$/, '');
const trimB = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
/** One new line: `ctx >= 0` means a context line, the file's own line O[ctx]. */
interface NLine {
  text: string;
  ctx: number;
}
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimT(a) === trimT(b);
  return trimB(a) === trimB(b);
}
function occurrences(O: string[], F: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(O[j]!, F[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(O: string[], F: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, F, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
/** Replace F[pos .. pos+O.length) by N (context lines taken from the file, tier-2 re-indent). */
function applyLines(F: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const P = O.length > 0 ? leadOf(O[0]!) : '';
  const F0 = O.length > 0 && F.length > pos ? leadOf(F[pos]!) : '';
  const mapped = N.map((n) => {
    if (n.ctx >= 0) return F[pos + n.ctx]!;
    if (tier === 2 && O.length > 0 && n.text.trim() !== '' && n.text.startsWith(P)) return F0 + n.text.slice(P.length);
    return n.text;
  });
  return [...F.slice(0, pos), ...mapped, ...F.slice(pos + O.length)];
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Section 6: unified diffs ---- */

function stripDiffPath(s: string): string {
  let t = s.split('\t')[0]!.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  noEol: boolean;
  hasPlus: boolean;
  plusNoEol: boolean;
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  named: boolean;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function parseHunkBody(body: string[]): { o: string[]; n: NLine[]; noEol: boolean; hasPlus: boolean; plusNoEol: boolean } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.startsWith('\\')) continue;
    if (b.startsWith(' ')) {
      const t = b.slice(1);
      const oi = o.length;
      o.push(t);
      n.push({ text: t, ctx: oi });
    } else if (b.startsWith('-')) o.push(b.slice(1));
    else if (b.startsWith('+')) n.push({ text: b.slice(1), ctx: -1 });
    else if (b === '') {
      const oi = o.length;
      o.push('');
      n.push({ text: '', ctx: oi });
    }
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const b = body[k]!;
    if (b.startsWith(' ') || b.startsWith('+') || b === '') lastCtxPlus = k;
    if (b.startsWith('+')) lastPlus = k;
  }
  const noEol = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
  const hasPlus = lastPlus >= 0;
  const plusNoEol = hasPlus && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { o, n, noEol, hasPlus, plusNoEol };
}

function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let phase: 'none' | 'header' | 'hunks' = 'none';
  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${idx + 1}`);
      if (cur) sections.push(cur);
      cur = { oldPath: m[1]!, newPath: m[2]!, named: false, create: false, del: false, hunks: [] };
      phase = 'header';
      idx++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')) {
      if (phase === 'header' && cur) {
        cur.oldPath = stripDiffPath(line.slice(4));
        cur.newPath = stripDiffPath(lines[idx + 1]!.slice(4));
        cur.named = true;
        idx += 2;
        continue;
      }
      if (cur) sections.push(cur);
      cur = { oldPath: stripDiffPath(line.slice(4)), newPath: stripDiffPath(lines[idx + 1]!.slice(4)), named: true, create: false, del: false, hunks: [] };
      phase = 'header';
      idx += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${idx + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${idx + 1}`);
      idx++;
      const body: string[] = [];
      while (idx < lines.length) {
        const b = lines[idx]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\') || b === '') {
          body.push(b);
          idx++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const parsed = parseHunkBody(body);
      cur.hunks.push({ a: parseInt(m[1]!, 10), o: parsed.o, n: parsed.n, noEol: parsed.noEol, hasPlus: parsed.hasPlus, plusNoEol: parsed.plusNoEol });
      phase = 'hunks';
      continue;
    }
    if (phase === 'header' && cur) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${idx + 2}`);
      if (line.startsWith('+++ ')) {
        cur.newPath = stripDiffPath(line.slice(4));
        cur.named = true;
        idx++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!cur.named) cur.oldPath = line.slice('rename from '.length).trim();
        idx++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!cur.named) cur.newPath = line.slice('rename to '.length).trim();
        idx++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        idx++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        idx++;
        continue;
      }
      idx++;
      continue;
    }
    idx++;
  }
  if (cur) sections.push(cur);
  return sections;
}

function applyHunks(startLines: string[], hunks: Hunk[], strict: boolean, path: string): { lines: string[]; ends: boolean | null } {
  let lines = [...startLines];
  let ends: boolean | null = null;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0 && h.n.length === 0) continue;
    if (h.o.length === 0) {
      let ins = h.a + d;
      if (ins < 0) ins = 0;
      if (ins > lines.length) ins = lines.length;
      const mapped = h.n.map((nn) => nn.text);
      const atEnd = ins === lines.length;
      lines = [...lines.slice(0, ins), ...mapped, ...lines.slice(ins)];
      if (atEnd) ends = !h.noEol;
      d += h.n.length;
    } else {
      const found = findTier(h.o, lines, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + h.o.length === lines.length;
      lines = applyLines(lines, best, h.o, h.n, found.tier);
      if (atEnd) ends = !h.noEol;
      d += h.n.length - h.o.length;
    }
  }
  return { lines, ends };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = unifiedSections(lines);
  return sections.map((sec) => {
    const oldP = sec.oldPath ?? sec.newPath;
    const newP = sec.newPath ?? sec.oldPath;
    return (tree: Tree) => {
      if (oldP === null || newP === null) return;
      const isCreate = oldP === '/dev/null' || sec.create;
      const isDelete = !isCreate && (newP === '/dev/null' || sec.del);
      if (isCreate) {
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const nn of h.n) if (nn.ctx < 0) plus.push(nn.text);
        let lastPlusNoEol = false;
        for (let k = sec.hunks.length - 1; k >= 0; k--) {
          if (sec.hunks[k]!.hasPlus) {
            lastPlusNoEol = sec.hunks[k]!.plusNoEol;
            break;
          }
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoEol ? '' : '\n'));
        return;
      }
      if (isDelete) {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (oldP !== newP && !safe(newP)) throw new Fail('unsafe', newP);
      const content = tree.get(oldP);
      if (content === null) throw new Fail('missing', oldP);
      if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = splitFile(content);
      const out = applyHunks(f.lines, sec.hunks, strict, oldP);
      const finalEnds = out.ends === null ? f.ends : out.ends;
      const finalText = joinFile(out.lines, f.br, finalEnds);
      if (oldP !== newP) {
        tree.now.set(oldP, null);
        tree.now.set(newP, finalText);
        tree.moves.push([oldP, newP]);
      } else {
        tree.now.set(oldP, finalText);
      }
    };
  });
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    const p = path;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const t = tree.get(p);
      if (t === null) throw new Fail('missing', p);
      const f = splitFile(t);
      const found = findTier(oldLines, f.lines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const n: NLine[] = newLines.map((text) => ({ text, ctx: -1 }));
      const out = applyLines(f.lines, found.pos[0]!, oldLines, n, found.tier);
      tree.now.set(p, joinFile(out, f.br, f.ends));
    });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/* ---- Section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isHeader = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (!isHeader(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = line.startsWith('*** Add') ? 'add' : line.startsWith('*** Delete') ? 'delete' : 'update';
    const path = line.slice(line.indexOf(':') + 1).trim();
    const headNum = i + 1;
    i++;
    const raw: { t: string; n: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (isHeader(l)) break;
      raw.push({ t: l, n: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.t === '') addLines.push('');
        else if (r.t.startsWith('+')) addLines.push(r.t.slice(1));
        else throw new Exit2(`error: parse ${r.n}`);
      }
      const p = path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.t)) throw new Exit2(`error: parse ${r.n}`);
      }
      const p = path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let rest = raw;
      if (rest.length > 0 && rest[0]!.t.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.t.slice('*** Move to: '.length).trim();
        rest = rest.slice(1);
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      for (const r of rest) {
        const t = r.t;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
          chunks.push(curChunk);
          continue;
        }
        if (t === '*** End of File') {
          if (!curChunk) {
            curChunk = { anchor: null, eof: true, o: [], n: [] };
            chunks.push(curChunk);
          } else curChunk.eof = true;
          curChunk = null;
          continue;
        }
        if (t.startsWith('*** ')) throw new Exit2(`error: parse ${r.n}`);
        if (!curChunk) {
          curChunk = { anchor: null, eof: false, o: [], n: [] };
          chunks.push(curChunk);
        }
        if (t.startsWith(' ')) {
          const tx = t.slice(1);
          const oi = curChunk.o.length;
          curChunk.o.push(tx);
          curChunk.n.push({ text: tx, ctx: oi });
        } else if (t.startsWith('-')) curChunk.o.push(t.slice(1));
        else if (t.startsWith('+')) curChunk.n.push({ text: t.slice(1), ctx: -1 });
        else if (t === '') {
          const oi = curChunk.o.length;
          curChunk.o.push('');
          curChunk.n.push({ text: '', ctx: oi });
        } else throw new Exit2(`error: parse ${r.n}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headNum}`);
      const p = path;
      const mv = moveTo;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const content = tree.get(p);
        if (content === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const f = splitFile(content);
        let flines = [...f.lines];
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            let foundIdx = -1;
            const tiers = strict ? [0] : [0, 1, 2];
            for (const tier of tiers) {
              for (let k = cursor; k < flines.length; k++) {
                if (tierEq(ch.anchor, flines[k]!, tier)) {
                  foundIdx = k;
                  break;
                }
              }
              if (foundIdx >= 0) break;
            }
            if (foundIdx < 0) throw new Fail('no-match', p);
            cursor = foundIdx + 1;
          }
          if (ch.o.length === 0) {
            const ins = ch.eof ? flines.length : cursor;
            const mapped = ch.n.map((nn) => nn.text);
            flines = [...flines.slice(0, ins), ...mapped, ...flines.slice(ins)];
            cursor = ins + mapped.length;
          } else {
            const found = findTier(ch.o, flines, strict, cursor);
            if (!found) throw new Fail('no-match', p);
            let pos = -1;
            for (const q of found.pos) {
              if (ch.eof && q + ch.o.length !== flines.length) continue;
              pos = q;
              break;
            }
            if (pos < 0) throw new Fail('no-match', p);
            flines = applyLines(flines, pos, ch.o, ch.n, found.tier);
            cursor = pos + ch.n.length;
          }
        }
        const out = joinFile(flines, f.br, f.ends);
        if (mv !== null) {
          tree.now.set(p, null);
          tree.now.set(mv, out);
          tree.moves.push([p, mv]);
        } else tree.now.set(p, out);
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const del = new Set<string>();
  const add = new Set<string>();
  const mod = new Set<string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) add.add(p);
    else if (now === null) del.add(p);
    else mod.add(p);
  }
  const rows: { key: string; line: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (del.has(o) && add.has(n)) {
      del.delete(o);
      add.delete(n);
      rows.push({ key: n, line: `R ${o} -> ${n}` });
    }
  }
  for (const p of del) rows.push({ key: p, line: `D ${p}` });
  for (const p of add) rows.push({ key: p, line: `A ${p}` });
  for (const p of mod) rows.push({ key: p, line: `M ${p}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort()) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()].sort()) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      if (tree.original(p) === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

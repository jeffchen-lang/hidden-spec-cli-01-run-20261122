// mend: one command-line tool that applies AI-written edits in four formats
// (unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON tool calls) to a
// tree of text files, to the specification in SPEC.md. Written fresh for the
// make.fun bounty hidden-spec-cli-01-run-20261122. Node 22, standard library
// alone; run as `node main.ts [options] [PATCH]`.
//
// The last lines hand a trial over to runner.ts when MAKEFUN_ENV_URL is set:
// keep them and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line on stdout, nothing else. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed with this code on this path. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, and no
 * empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \,
 * and none of its /-separated segments is empty, . or ... */
function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** Byte order of paths (UTF-8), for the changed-files listing. */
function byteLess(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---- Files: lines and line breaks (SPEC.md section 3) ----

interface FileState {
  /** The file's line break: CRLF when its first line feed follows a carriage
   * return, LF otherwise. */
  br: string;
  lines: string[];
  /** Whether the text ends with that break. */
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function serializeFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

// ---- Matching lines at three tiers (SPEC.md section 5) ----

/** A line as a tier sees it. */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O's lines match the file's lines at a tier. */
function occurrences(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const on = o.map((l) => norm(l, tier));
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(fileLines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions. */
function findTier(
  fileLines: string[],
  o: string[],
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const top = strict ? 1 : 3;
  for (let tier = 0; tier < top; tier++) {
    const occ = occurrences(fileLines, o, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

/** Re-indent one added line at tier 2: its leading P (the old first line's)
 * replaced by F (the file's first matched line's). Lines that are empty, only
 * whitespace, or do not start with P are written as they are. */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

// ---- The tree as the edits leave it ----

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful move edit made, for the R lines of the listing. */
  moves: Array<{ old: string; nw: string }> = [];

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

// ---- Unified diffs (SPEC.md section 6) ----

interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

interface Hunk {
  /** The old-file start line from the header (1-based). */
  a: number;
  items: BodyItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line (false when it has none). */
  lastAddNoEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  createFlag: boolean;
  delFlag: boolean;
  hunks: Hunk[];
}

/** The old lines of a hunk: its context and `-` lines, in body order. */
function hunkO(h: Hunk): string[] {
  return h.items.filter((i) => i.kind !== 'add').map((i) => i.text);
}

interface NItem {
  ctx: boolean;
  /** Index in O, for context lines. */
  oIndex: number;
  text: string;
}

/** The new lines of a hunk: its context and `+` lines, in body order. */
function hunkN(h: Hunk): NItem[] {
  const out: NItem[] = [];
  let oi = 0;
  for (const it of h.items) {
    if (it.kind === 'del') {
      oi++;
    } else if (it.kind === 'ctx') {
      out.push({ ctx: true, oIndex: oi, text: it.text });
      oi++;
    } else {
      out.push({ ctx: false, oIndex: -1, text: it.text });
    }
  }
  return out;
}

function parseUnifiedPath(line: string): string {
  const rest = line.slice(4);
  const cut = rest.indexOf('\t');
  const p = (cut < 0 ? rest : rest.slice(0, cut)).trim();
  if (p === '/dev/null') return p;
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseDiffGit(line: string, num: number): { a: string; b: string } {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${num}`);
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) throw new Exit2(`error: parse ${num}`);
  const a = rest.slice(2, sep);
  const b = rest.slice(sep + 3);
  if (a === '' || b === '') throw new Exit2(`error: parse ${num}`);
  return { a, b };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hasPair = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const { a, b } = parseDiffGit(l, i + 1);
      cur = { oldPath: a, newPath: b, createFlag: false, delFlag: false, hunks: [] };
      sections.push(cur);
      hasPair = false;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const items: BodyItem[] = [];
      for (const bl of body) {
        if (bl === '') items.push({ kind: 'ctx', text: '' });
        else if (bl.startsWith(' ')) items.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl.startsWith('-')) items.push({ kind: 'del', text: bl.slice(1) });
        else if (bl.startsWith('+')) items.push({ kind: 'add', text: bl.slice(1) });
      }
      let lastCtxAdd = -1;
      let lastAdd = -1;
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl.startsWith('\\')) continue;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('+')) lastCtxAdd = k;
        if (bl.startsWith('+')) lastAdd = k;
      }
      const noEol =
        lastCtxAdd >= 0 && body[lastCtxAdd + 1] !== undefined && body[lastCtxAdd + 1]!.startsWith('\\');
      const lastAddNoEol =
        lastAdd >= 0 && body[lastAdd + 1] !== undefined && body[lastAdd + 1]!.startsWith('\\');
      cur.hunks.push({ a, items, noEol, lastAddNoEol });
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !hasPair) {
        cur.oldPath = parseUnifiedPath(l);
        cur.newPath = parseUnifiedPath(lines[i + 1]!);
        hasPair = true;
        i += 2;
        continue;
      }
      cur = {
        oldPath: parseUnifiedPath(l),
        newPath: parseUnifiedPath(lines[i + 1]!),
        createFlag: false,
        delFlag: false,
        hunks: [],
      };
      sections.push(cur);
      hasPair = true;
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.createFlag = true;
      else if (l.startsWith('deleted file mode')) cur.delFlag = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Apply a section's hunks, in order, to a file's lines. */
function applyHunks(st: FileState, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const o = hunkO(h);
    const n = hunkN(h);
    if (o.length === 0) {
      const ins = Math.min(h.a + d, st.lines.length);
      const atEnd = ins === st.lines.length;
      st.lines.splice(ins, 0, ...n.map((x) => x.text));
      if (atEnd) st.final = !h.noEol;
      d += n.length;
      continue;
    }
    const found = findTier(st.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const q of found.occ) {
      const dd = Math.abs(q - target);
      if (dd < best) {
        best = dd;
        pos = q;
      }
    }
    const atEnd = pos + o.length === st.lines.length;
    const p = leadingWs(o[0]!);
    const f = leadingWs(st.lines[pos]!);
    const repl = n.map((x) => (x.ctx ? st.lines[pos + x.oIndex]! : found.tier === 2 ? reindent(x.text, p, f) : x.text));
    st.lines.splice(pos, o.length, ...repl);
    if (atEnd) st.final = !h.noEol;
    d += repl.length - o.length;
  }
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath === '/dev/null' ? null : sec.oldPath;
    const newP = sec.newPath === '/dev/null' ? null : sec.newPath;
    const create = oldP === null || sec.createFlag;
    const del = newP === null || sec.delFlag;
    if (create) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastAddNoEol = false;
      for (const h of sec.hunks) {
        for (const it of h.items) if (it.kind === 'add') plus.push(it.text);
        if (h.items.some((it) => it.kind === 'add')) lastAddNoEol = h.lastAddNoEol;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastAddNoEol ? '' : '\n'));
      return;
    }
    if (del) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldPath = oldP!;
    const newPath = newP!;
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (!safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (oldPath !== newPath) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const st = parseFile(before);
      applyHunks(st, sec.hunks, oldPath, strict);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, serializeFile(st));
      tree.moves.push({ old: oldPath, nw: newPath });
      return;
    }
    const st = parseFile(before);
    applyHunks(st, sec.hunks, oldPath, strict);
    tree.now.set(oldPath, serializeFile(st));
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const st = parseFile(text);
    const found = findTier(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const p = leadingWs(oldLines[0]!);
    const f = leadingWs(st.lines[pos]!);
    const repl = newLines.map((l) => (found.tier === 2 ? reindent(l, p, f) : l));
    st.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, serializeFile(st));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  /** null: no anchor. */
  anchor: string | null;
  /** Anchored to the end of the file. */
  eof: boolean;
  items: BodyItem[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  /** Add File: the section's lines. Update File: its chunks. */
  addLines: string[];
  chunks: VChunk[];
  /** Line number of the section's header, for the no-chunk parse error. */
  headerLine: number;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = parseFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let at = -1;
        const top = strict ? 1 : 3;
        for (let tier = 0; tier < top && at < 0; tier++) {
          for (let k = cursor; k < st.lines.length; k++) {
            if (norm(st.lines[k]!, tier) === norm(ch.anchor, tier)) {
              at = k;
              break;
            }
          }
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o = ch.items.filter((x) => x.kind !== 'add').map((x) => x.text);
      const n = hunkN({ a: 0, items: ch.items, noEol: false, lastAddNoEol: false });
      if (o.length === 0) {
        const ins = ch.eof ? st.lines.length : cursor;
        st.lines.splice(ins, 0, ...n.map((x) => x.text));
        cursor = ins + n.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      const top = strict ? 1 : 3;
      for (let tier = 0; tier < top && found === null; tier++) {
        const occ = occurrences(st.lines, o, tier).filter((i) => i >= cursor);
        for (const q of occ) {
          if (!ch.eof || q + o.length === st.lines.length) {
            found = { tier, pos: q };
            break;
          }
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const pos = found.pos;
      const p = leadingWs(o[0]!);
      const f = leadingWs(st.lines[pos]!);
      const repl = n.map((x) =>
        x.ctx ? st.lines[pos + x.oIndex]! : found.tier === 2 ? reindent(x.text, p, f) : x.text,
      );
      st.lines.splice(pos, o.length, ...repl);
      cursor = pos + repl.length;
    }
    const out = serializeFile(st);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let marker = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      marker = '*** Add File: ';
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      marker = '*** Delete File: ';
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      marker = '*** Update File: ';
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const path = l.slice(marker.length).trim();
    const headerLine = i + 1;
    i++;
    const rawStart = i;
    const raw: string[] = [];
    while (i < last) {
      const bl = lines[i]!;
      if (
        bl.startsWith('*** Add File: ') ||
        bl.startsWith('*** Delete File: ') ||
        bl.startsWith('*** Update File: ')
      ) {
        break;
      }
      raw.push(bl);
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const rl = raw[k]!;
        if (rl === '') fileLines.push('');
        else if (rl.startsWith('+')) fileLines.push(rl.slice(1));
        else throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
      sections.push({ kind, path, moveTo: null, addLines: fileLines, chunks: [], headerLine });
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (raw[k] !== '') throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [], headerLine });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let closed = false;
      for (; k < raw.length; k++) {
        const rl = raw[k]!;
        if (closed) {
          if (rl === '') continue;
          throw new Exit2(`error: parse ${rawStart + k + 1}`);
        }
        if (rl.startsWith('@@')) {
          cur = { anchor: rl.slice(2).trim() === '' ? null : rl.slice(2).trim(), eof: false, items: [] };
          chunks.push(cur);
          continue;
        }
        if (rl === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, items: [] };
            chunks.push(cur);
          } else {
            cur.eof = true;
          }
          closed = true;
          continue;
        }
        if (rl === '' || rl.startsWith(' ') || rl.startsWith('-') || rl.startsWith('+')) {
          if (cur === null) {
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          if (rl === '') cur.items.push({ kind: 'ctx', text: '' });
          else if (rl.startsWith(' ')) cur.items.push({ kind: 'ctx', text: rl.slice(1) });
          else if (rl.startsWith('-')) cur.items.push({ kind: 'del', text: rl.slice(1) });
          else cur.items.push({ kind: 'add', text: rl.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind, path, moveTo, addLines: [], chunks, headerLine });
    }
  }
  return sections.map((s) => {
    if (s.kind === 'add') return v4aAddEdit(s.path, s.addLines);
    if (s.kind === 'delete') return v4aDeleteEdit(s.path);
    return v4aUpdateEdit(s.path, s.moveTo, s.chunks, strict);
  });
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object, or null when it is not one. */
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
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
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
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const st = parseFile(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      st.lines.splice(line, 0, ...add);
      tree.now.set(p, serializeFile(st));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
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

// ---- Detecting the format (SPEC.md section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---- Running one invocation (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
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
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const mv of tree.moves) {
    const oldWas = tree.original(mv.old);
    const newWas = tree.original(mv.nw);
    if (
      oldWas !== null &&
      tree.get(mv.old) === null &&
      newWas === null &&
      tree.get(mv.nw) !== null &&
      tree.now.has(mv.old) &&
      tree.now.has(mv.nw)
    ) {
      rows.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      covered.add(mv.old);
      covered.add(mv.nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteLess(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteLess)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const lines_out = rows.map((r) => r.line);
  return { code: 0, out: [...lines_out, `ok: ${lines_out.length} ${lines_out.length === 1 ? 'file' : 'files'}`] };
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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Level = { w: number; floor: Uint8Array; goals: number[]; boxes: number[]; player: number };
type State = { boxes: number[]; player: number; key: string; g: number; f: number; dir: number; prev: State | null };
const letters = 'udlr';
const offsets = (w: number) => [-w, w, -1, 1];
const INF = 1_000_000;

function parse(text: string): Level {
  const rows = text.split(/\r?\n/);
  if (rows.at(-1) === '') rows.pop();
  const w = rows.reduce((max, row) => Math.max(max, row.length), 0) + 2;
  const floor = new Uint8Array(w * (rows.length + 2)); // Wall padding, including short rows.
  const goals: number[] = [], boxes: number[] = [];
  let player = -1;
  for (const [y, row] of rows.entries()) {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (!' .$*@+'.includes(c)) continue;
      const p = (y + 1) * w + x + 1;
      floor[p] = 1;
      if ('.*+'.includes(c)) goals.push(p);
      if ('$*'.includes(c)) boxes.push(p);
      if ('@+'.includes(c)) player = p;
    }
  }
  return { w, floor, goals, boxes, player };
}

function roomsOf(level: Level): Level[] {
  const { w, floor, goals, boxes, player } = level;
  const dirs = offsets(w);
  const order = new Int32Array(floor.length), cut = new Uint8Array(floor.length);
  let time = 0;
  function visit(p: number, parent: number): number {
    let low = order[p] = ++time;
    let children = 0;
    for (const d of dirs) {
      const q = p + d;
      if (!floor[q] || q === parent) continue;
      if (order[q]) low = Math.min(low, order[q]);
      else {
        children++;
        const below = visit(q, p);
        low = Math.min(low, below);
        if (parent !== -1 && below >= order[p]) cut[p] = 1;
      }
    }
    if (parent === -1 && children > 1) cut[p] = 1;
    return low;
  }
  visit(player, -1);

  // Identify the hallway spine before choosing cuts: many hallway and interior cells are also articulations.
  let left = player, right = player;
  while (floor[left - 1]) left--;
  while (floor[right + 1]) right++;
  const doors: [number, number][] = [];
  for (let p = left; p <= right; p++) {
    if (boxes.includes(p) || goals.includes(p)) return [];
    for (const d of [-w, w]) {
      const door = p + d;
      if (!floor[door]) continue;
      if (!cut[door] || floor[p - d] || floor[door - 1] || floor[door + 1] || !floor[door + d]) return [];
      doors.push([door, p]);
    }
  }

  // Split on just the selected doors. Assign each door back to its room: it may hold a box.
  const used = new Uint8Array(floor.length);
  used.fill(1, left, right + 1);
  for (const [door] of doors) used[door] = 1;
  const rooms: Level[] = [];
  let assigned = 0;
  for (const [door, outside] of doors) {
    const inside = 2 * door - outside;
    if (used[inside]) return [];
    const cells = [inside];
    used[inside] = 1;
    const mask = new Uint8Array(floor.length);
    mask[outside] = mask[door] = 1;
    for (const p of cells) {
      mask[p] = 1;
      for (const d of dirs) {
        const q = p + d;
        if (floor[q] && !used[q]) {
          used[q] = 1;
          cells.push(q);
        }
      }
    }
    const roomBoxes = boxes.filter(b => mask[b]);
    const roomGoals = goals.filter(g => mask[g]);
    if (!roomBoxes.length || roomBoxes.length !== roomGoals.length) return [];
    assigned += roomBoxes.length;
    rooms.push({ w, floor: mask, goals: roomGoals, boxes: roomBoxes, player: outside });
  }
  return assigned === boxes.length ? rooms : [];
}

// All relevant box-to-goal distances: reverse BFS on the empty-board push graph.
// A reverse edge requires both the previous box square and the pusher's support square.
function pushDistances({ w, floor, goals }: Level): Int32Array[] {
  const dirs = offsets(w);
  return goals.map(goal => {
    const dist = new Int32Array(floor.length).fill(INF);
    const queue = [goal];
    dist[goal] = 0;
    for (const p of queue) {
      for (const d of dirs) {
        const q = p - d;
        if (!floor[q] || !floor[q - d] || dist[q] !== INF) continue;
        dist[q] = dist[p] + 1;
        queue.push(q);
      }
    }
    return dist;
  });
}

// Hungarian shortest augmenting paths, with row/column potentials and a dummy column 0.
function assignment(boxes: number[], dist: Int32Array[]): number {
  const n = boxes.length, m = dist.length;
  const u = new Int32Array(n + 1), v = new Int32Array(m + 1);
  const row = new Int32Array(m + 1), prev = new Int32Array(m + 1);
  const slack = new Int32Array(m + 1), used = new Uint8Array(m + 1);
  for (let i = 1; i <= n; i++) {
    row[0] = i;
    slack.fill(INF * 2);
    used.fill(0);
    let j = 0;
    do {
      used[j] = 1;
      const r = row[j], box = boxes[r - 1];
      let delta = INF * 2, next = 0;
      for (let k = 1; k <= m; k++) {
        if (used[k]) continue;
        const cost = dist[k - 1][box] - u[r] - v[k];
        if (cost < slack[k]) {
          slack[k] = cost;
          prev[k] = j;
        }
        if (slack[k] < delta) {
          delta = slack[k];
          next = k;
        }
      }
      for (let k = 0; k <= m; k++) {
        if (used[k]) {
          u[row[k]] += delta;
          v[k] -= delta;
        } else slack[k] -= delta;
      }
      j = next;
    } while (row[j]);
    do {
      const k = prev[j];
      row[j] = row[k];
      j = k;
    } while (j);
  }
  for (let j = 1; j <= m; j++) {
    if (row[j] && dist[j - 1][boxes[row[j] - 1]] === INF) return INF;
  }
  return -v[0];
}

function frozen(level: Level, occ: Uint8Array, goal: Uint8Array, boxes: number[], at: number, stuck: Uint8Array): boolean {
  const { floor, w } = level;
  const blocked = (p: number) => !floor[p] || occ[p];
  const bad = (p: number) => occ[p] && !goal[p];
  for (const p of [at, at - 1, at - w, at - w - 1]) {
    if (blocked(p) && blocked(p + 1) && blocked(p + w) && blocked(p + w + 1) &&
        (bad(p) || bad(p + 1) || bad(p + w) || bad(p + w + 1))) return true;
  }
  // Peel away boxes that could move if all previously peeled boxes vanished. In the
  // surviving set, each box is blocked on both axes, so none can be the first to move.
  for (const b of boxes) stuck[b] = 1;
  const open = (p: number) => floor[p] && !stuck[p];
  let changed: boolean;
  do {
    changed = false;
    for (const b of boxes) {
      if (stuck[b] && ((open(b - 1) && open(b + 1)) || (open(b - w) && open(b + w)))) {
        stuck[b] = 0;
        changed = true;
      }
    }
  } while (changed);
  let dead = false;
  for (const b of boxes) {
    if (stuck[b] && !goal[b]) dead = true;
    stuck[b] = 0;
  }
  return dead;
}

function walk(level: Level, occ: Uint8Array, from: number, to: number): string | null {
  const dirs = offsets(level.w);
  const via = new Int8Array(level.floor.length).fill(-1);
  const queue = [from];
  via[from] = 4;
  for (const p of queue) {
    if (p === to) {
      const moves: string[] = [];
      for (let q = to; q !== from; q -= dirs[via[q]]) moves.push(letters[via[q]]);
      return moves.reverse().join('');
    }
    for (let k = 0; k < 4; k++) {
      const q = p + dirs[k];
      if (!level.floor[q] || occ[q] || via[q] !== -1) continue;
      via[q] = k;
      queue.push(q);
    }
  }
  return null;
}

function search(level: Level, cap: number, pushes: boolean): { moves: string; player: number } | null {
  const { w, floor, goals, boxes, player } = level;
  const dirs = offsets(w), size = floor.length;
  const goal = new Uint8Array(size), live = new Uint8Array(size), occ = new Uint8Array(size);
  const seen = new Int32Array(size), queue = new Int32Array(size), stuck = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dist = pushes ? pushDistances(level) : [];
  // Non-goal wall corners are automatically dead squares: there is no outgoing push edge.
  if (pushes) for (const d of dist) for (let p = 0; p < size; p++) if (d[p] !== INF) live[p] = 1;
  const nearest = new Int32Array(size).fill(INF);
  if (!pushes) for (let p = 0; p < size; p++) if (floor[p]) {
    for (const g of goals) nearest[p] = Math.min(nearest[p], Math.abs(p % w - g % w) + Math.abs(Math.floor(p / w) - Math.floor(g / w)));
  }
  const cache = new Map<string, number>();
  function estimate(bs: number[], boxKey: string): number {
    let h = cache.get(boxKey);
    if (h === undefined) {
      h = pushes ? assignment(bs, dist) : bs.reduce((sum, b) => sum + nearest[b], 0);
      if (cache.size < 80_000) cache.set(boxKey, h);
    }
    return h;
  }

  let stamp = 0;
  function reach(p: number): number {
    let low = p, tail = 1;
    queue[0] = p;
    seen[p] = ++stamp;
    for (let i = 0; i < tail; i++) {
      const cell = queue[i];
      low = Math.min(low, cell);
      for (const d of dirs) {
        const q = cell + d;
        if (!floor[q] || occ[q] || seen[q] === stamp) continue;
        seen[q] = stamp;
        queue[tail++] = q;
      }
    }
    return low;
  }

  const heap: State[] = [];
  const best = new Map<string, number>();
  const less = (a: State, b: State) => a.f < b.f || (a.f === b.f && (a.g > b.g || (a.g === b.g && a.key < b.key)));
  function offer(bs: number[], p: number, dir: number, prev: State | null): void {
    const g = prev ? prev.g + 1 : 0;
    const boxKey = String.fromCharCode(...bs);
    const key = boxKey + String.fromCharCode(pushes ? reach(p) : p);
    if ((best.get(key) ?? Infinity) <= g) return;
    const h = estimate(bs, boxKey);
    if (h >= INF) return;
    best.set(key, g);
    const state = { boxes: bs, player: p, key, g, f: g + h, dir, prev };
    let i = heap.length;
    heap.push(state);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(state, heap[parent])) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = state;
  }
  function pop(): State {
    const top = heap[0], end = heap.pop()!;
    if (heap.length) {
      let i = 0;
      for (let child = 1; child < heap.length; child = 2 * i + 1) {
        if (child + 1 < heap.length && less(heap[child + 1], heap[child])) child++;
        if (!less(heap[child], end)) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = end;
    }
    return top;
  }

  for (const b of boxes) occ[b] = 1;
  offer(boxes, player, -1, null);
  occ.fill(0);
  let expanded = 0;
  while (heap.length) {
    const s = pop();
    if (best.get(s.key) !== s.g) continue;
    if (s.f === s.g) {
      const parts: string[] = [];
      for (let t = s; t.prev; t = t.prev) {
        parts.push(letters[t.dir]);
        if (pushes) {
          for (const b of t.prev.boxes) occ[b] = 1;
          const steps = walk(level, occ, t.prev.player, t.player - dirs[t.dir]);
          for (const b of t.prev.boxes) occ[b] = 0;
          if (steps === null) return null;
          parts.push(steps);
        }
      }
      return { moves: parts.reverse().join(''), player: s.player };
    }
    if (expanded++ >= cap || heap.length + best.size >= 500_000) break;
    for (const b of s.boxes) occ[b] = 1;
    function pushBox(b: number, k: number): void {
      const to = b + dirs[k];
      if (!floor[to] || occ[to] || (pushes && !live[to])) return;
      const bs = s.boxes.map(q => q === b ? to : q).sort((a, b) => a - b);
      occ[b] = 0;
      occ[to] = 1;
      if (!pushes || !frozen(level, occ, goal, bs, to, stuck)) offer(bs, b, k, s);
      occ[to] = 0;
      occ[b] = 1;
    }
    if (pushes) {
      reach(s.player);
      // Successor floods reuse the BFS buffer, so save this state's legal pushes first.
      const options: number[] = [];
      for (const b of s.boxes) for (let k = 0; k < 4; k++) {
        if (seen[b - dirs[k]] === stamp) options.push(b * 4 + k);
      }
      for (const p of options) pushBox(p >> 2, p & 3);
    } else {
      for (let k = 0; k < 4; k++) {
        const to = s.player + dirs[k];
        if (!floor[to]) continue;
        if (occ[to]) pushBox(to, k);
        else offer(s.boxes, to, k, s);
      }
    }
    for (const b of s.boxes) occ[b] = 0;
  }
  return null;
}

function stitch(level: Level): string | null {
  const rooms = roomsOf(level);
  if (!rooms.length) return null;
  const occ = new Uint8Array(level.floor.length);
  for (const b of level.boxes) occ[b] = 1;
  let player = level.player;
  const parts: string[] = [];
  for (const [i, room] of rooms.entries()) {
    const enter = walk(level, occ, player, room.player);
    if (enter === null) return null;
    const result = search(room, 400_000, true);
    if (!result) return null;
    parts.push(enter, result.moves);
    for (const b of room.boxes) occ[b] = 0;
    for (const g of room.goals) occ[g] = 1;
    if (i + 1 < rooms.length) {
      const exit = walk(room, occ, result.player, room.player);
      if (exit === null) return null;
      parts.push(exit);
      player = room.player;
    }
  }
  return parts.join('');
}

function solve(text: string): string {
  const level = parse(text);
  if (level.player < 0 || level.boxes.length > level.goals.length || level.floor.length > 65_536) return '';
  return stitch(level) ?? search(level, 100_000, true)?.moves ?? search(level, 150_000, false)?.moves ?? '';
}

const input = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const output = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (let i = 1; i <= 5; i++) {
  const id = `i00${i}`;
  let moves = '';
  try {
    moves = solve(readFileSync(join(input, id, 'level.txt'), 'utf8'));
  } catch {
    // A missing or malformed instance must not prevent the remaining answers.
  }
  const dir = join(output, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'solution.txt'), moves.length < 65_536 ? `${moves}\n` : '\n');
}

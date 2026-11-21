// Particle creatures. Each agent can "materialise" from an orb into one of these living shapes.
// A form = { n, animate(t, out) } where out is a Float32Array(n*3) of points in roughly [-1, 1].
import { seeded } from './sim.js';

const TAU = Math.PI * 2;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const rotY = (x, z, a) => [x * Math.cos(a) + z * Math.sin(a), -x * Math.sin(a) + z * Math.cos(a)];
const rotX = (y, z, a) => [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];

function hashStr(s) { let h = 7; for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0; return h; }

// ── Curiosity: a spiral eye that looks around and blinks ──
function eye(n, rng) {
  const P = [];
  for (let i = 0; i < n; i++) {
    const r = rng();
    if (r < 0.24) P.push({ k: 'lid', u: rng() * 2 - 1, s: rng() < 0.5 ? 1 : -1, j: (rng() - 0.5) * 0.03 });
    else if (r < 0.58) P.push({ k: 'iris', a: rng() * TAU, rr: 0.2 + rng() * 0.2 });
    else if (r < 0.68) P.push({ k: 'pupil', a: rng() * TAU, rr: Math.sqrt(rng()) });
    else P.push({ k: 'arm', arm: Math.floor(rng() * 3), u: rng(), j: (rng() - 0.5) * 0.08, z: (rng() - 0.5) * 0.2 });
  }
  return {
    n,
    animate(t, o) {
      const cyc = t % 4.2, blink = 1 - 0.92 * (1 - smooth(0, 0.09, Math.abs(cyc - 3.9)));
      const look = [Math.sin(t * 0.7) * 0.16, Math.sin(t * 0.43) * 0.08];
      const dil = 0.12 + 0.04 * Math.sin(t * 1.3);
      for (let i = 0; i < n; i++) {
        const p = P[i]; let x = 0, y = 0, z = 0;
        if (p.k === 'lid') { x = p.u; y = p.s * 0.46 * (1 - p.u * p.u) * blink + p.j; }
        else if (p.k === 'iris' || p.k === 'pupil') {
          const a = p.k === 'iris' ? p.a + t * 0.6 : p.a;
          const rr = p.k === 'iris' ? p.rr : p.rr * dil;
          x = Math.cos(a) * rr + look[0]; y = Math.sin(a) * rr + look[1]; z = 0.05;
          const lid = 0.46 * (1 - x * x) * blink;
          if (Math.abs(y) > lid) y = Math.sign(y) * lid;
        } else {
          const rr = 0.62 + p.u * 0.85, a = p.arm * TAU / 3 + p.u * 3.6 + t * 0.25;
          x = Math.cos(a) * rr + p.j; y = Math.sin(a) * rr * 0.62 + p.j; z = p.z - p.u * 0.3;
        }
        o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
      }
    },
  };
}

// ── Skeptic: a faceted crystal shield with a scanning lens ──
function shield(n, rng) {
  const hex = Array.from({ length: 6 }, (_, k) => [Math.cos(k * TAU / 6 + Math.PI / 6), Math.sin(k * TAU / 6 + Math.PI / 6) * 1.08]);
  const P = [];
  for (let i = 0; i < n; i++) {
    const r = rng();
    if (r < 0.5) { const k = Math.floor(rng() * 6), u = rng(); const a = hex[k], b = hex[(k + 1) % 6]; const edge = rng() < 0.55; P.push({ k: 'edge', x: edge ? a[0] + (b[0] - a[0]) * u : a[0] * u, y: edge ? a[1] + (b[1] - a[1]) * u : a[1] * u, z: edge ? 0 : 0.32 * (1 - u) }); }
    else if (r < 0.66) { const k = Math.floor(rng() * 6), u = rng(), w = rng(); const a = hex[k], b = hex[(k + 1) % 6]; const s = Math.sqrt(u); P.push({ k: 'face', x: (a[0] * (1 - w) + b[0] * w) * s, y: (a[1] * (1 - w) + b[1] * w) * s, z: 0.32 * (1 - s) }); }
    else if (r < 0.92) P.push({ k: 'lens', a: rng() * TAU, w: (rng() - 0.5) * 0.04 });
    else P.push({ k: 'handle', u: rng() });
  }
  return {
    n,
    animate(t, o) {
      const tilt = Math.sin(t * 0.5) * 0.45, lx = Math.sin(t * 0.9) * 0.42, ly = Math.cos(t * 0.6) * 0.2;
      for (let i = 0; i < n; i++) {
        const p = P[i]; let x, y, z;
        if (p.k === 'lens') { x = lx + Math.cos(p.a) * (0.33 + p.w); y = ly + Math.sin(p.a) * (0.33 + p.w); z = 0.45; }
        else if (p.k === 'handle') { x = lx + 0.24 + p.u * 0.35; y = ly - 0.24 - p.u * 0.35; z = 0.45; }
        else { [x, z] = rotY(p.x, p.z, tilt); y = p.y; }
        o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
      }
    },
  };
}

// ── Dreamer: a whale swimming through drifting stars ──
function whale(n, rng) {
  const P = [];
  for (let i = 0; i < n; i++) {
    const r = rng();
    if (r < 0.62) P.push({ k: 'body', s: Math.pow(rng(), 0.9), a: rng() * TAU, shell: rng() < 0.8 });
    else if (r < 0.74) P.push({ k: 'fluke', u: rng(), v: rng() * 2 - 1 });
    else if (r < 0.82) P.push({ k: 'fin', u: rng(), v: rng(), side: rng() < 0.5 ? 1 : -1 });
    else P.push({ k: 'star', x: rng() * 3 - 1.5, y: rng(), z: rng() * 1.4 - 0.7, sp: 0.1 + rng() * 0.2 });
  }
  return {
    n,
    animate(t, o) {
      const turn = Math.sin(t * 0.3) * 0.5;
      for (let i = 0; i < n; i++) {
        const p = P[i]; let x, y, z, s = 0;
        if (p.k === 'star') { x = p.x; y = ((p.y + t * p.sp) % 1) * 2.2 - 1.1; z = p.z; o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z; continue; }
        if (p.k === 'body') {
          s = p.s;
          const rad = 0.3 * Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.08 + 0.02)), 0.55) * (1 - 0.5 * s);
          const rr = p.shell ? rad : rad * Math.sqrt(rng01(i));
          x = 1 - s * 2; y = Math.sin(p.a) * rr * (Math.sin(p.a) < 0 ? 0.8 : 1); z = Math.cos(p.a) * rr * 0.85;
        } else if (p.k === 'fluke') { s = 1; x = -1 - p.u * 0.35; z = p.v * (0.08 + p.u * 0.45); y = 0.05 * Math.abs(p.v); }
        else { s = 0.35; x = 0.35 - p.u * 0.3; y = -0.18 - p.v * 0.18; z = p.side * (0.22 + p.v * 0.35); }
        y += 0.13 * Math.sin(2.4 * t - 3.2 * s) * s + Math.sin(t * 0.8) * 0.06;
        [x, z] = rotY(x, z, turn - 0.25);
        o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
      }
    },
  };
}
function rng01(i) { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x); }

// ── Builder: a voxel construct that keeps assembling itself ──
function golem(n, rng) {
  const cells = [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2], [0.5, 3.1], [-1, 2], [2, 2], [-1.6, 1.4], [2.6, 1.4], [0, -1], [1, -1], [0, -2], [1, -2]];
  const S = 0.2, cx = 0.5, cy = 0.5;
  const edges = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) { edges.push([[-1, a, b], [1, a, b]], [[a, -1, b], [a, 1, b]], [[a, b, -1], [a, b, 1]]); }
  const P = [];
  for (let i = 0; i < n; i++) {
    const c = Math.floor(rng() * cells.length), e = edges[Math.floor(rng() * 12)], u = rng();
    const fill = rng() < 0.18;
    const lp = fill ? [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1] : e[0].map((v, k) => v + (e[1][k] - v) * u);
    P.push({ c, lp, dir: [rng() - 0.5, rng() - 0.5, rng() - 0.5] });
  }
  return {
    n,
    animate(t, o) {
      const cyc = (t * 0.16) % 1, spin = t * 0.35;
      for (let i = 0; i < n; i++) {
        const p = P[i], [gx, gy] = cells[p.c];
        const start = p.c / cells.length * 0.3;
        const built = smooth(start, start + 0.08, cyc) * (1 - smooth(0.93, 1, cyc));
        const fly = (1 - built) * 1.2;
        let x = (gx - cx) * S * 2.1 + p.lp[0] * S * 0.92 + p.dir[0] * fly;
        let y = (gy - cy) * S * 2.1 + p.lp[1] * S * 0.92 + p.dir[1] * fly - 0.15;
        let z = p.lp[2] * S * 0.92 + p.dir[2] * fly;
        [x, z] = rotY(x, z, spin);
        o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
      }
    },
  };
}

// ── Memory: a glowing tree standing on its own growth rings ──
function tree(n, rng) {
  const segs = [];
  (function grow(x, y, z, ang, tilt, len, depth) {
    const x2 = x + Math.sin(ang) * Math.cos(tilt) * len, y2 = y + Math.cos(ang) * len, z2 = z + Math.sin(ang) * Math.sin(tilt) * len;
    segs.push({ a: [x, y, z], b: [x2, y2, z2], d: depth });
    if (depth >= 5) return;
    const k = depth < 2 ? 2 : 3;
    for (let i = 0; i < k; i++) grow(x2, y2, z2, ang + (rng() - 0.5) * 1.9, tilt + (rng() - 0.5) * 3, len * (0.72 + rng() * 0.1), depth + 1);
  })(0, -0.95, 0, 0, 0, 0.55, 0);
  const tips = segs.filter((s) => s.d >= 4);
  const P = [];
  for (let i = 0; i < n; i++) {
    const r = rng();
    if (r < 0.42) { const s = segs[Math.floor(rng() * segs.length)]; const u = rng(); P.push({ k: 'br', p: s.a.map((v, j) => v + (s.b[j] - v) * u), w: 0.04 / (1 + s.d) }); }
    else if (r < 0.78) { const s = tips[Math.floor(rng() * tips.length)]; P.push({ k: 'leaf', p: s.b, o: [(rng() - 0.5) * 0.34, (rng() - 0.5) * 0.26, (rng() - 0.5) * 0.34], ph: rng() * TAU }); }
    else P.push({ k: 'ring', r: 0.18 + Math.floor(rng() * 6) * 0.14 + (rng() - 0.5) * 0.015, a: rng() * TAU });
  }
  return {
    n,
    animate(t, o) {
      for (let i = 0; i < n; i++) {
        const p = P[i]; let x, y, z;
        if (p.k === 'ring') { const a = p.a + t * 0.15 * (p.r > 0.5 ? -1 : 1); x = Math.cos(a) * p.r; z = Math.sin(a) * p.r * 0.5; y = -1; }
        else {
          const b = p.k === 'leaf' ? [p.p[0] + p.o[0], p.p[1] + p.o[1] + Math.sin(t * 1.5 + p.ph) * 0.02, p.p[2] + p.o[2]] : p.p;
          const sway = 0.06 * Math.sin(t * 1.1 + b[1] * 2) * (b[1] + 1);
          x = b[0] + sway; y = b[1]; z = b[2];
          [x, z] = rotY(x, z, t * 0.2);
        }
        o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
      }
    },
  };
}

// ── Jester: a tumbling Möbius strip juggling three sparks ──
function mobius(n, rng) {
  const P = [];
  for (let i = 0; i < n; i++) {
    if (rng() < 0.76) P.push({ k: 'm', u: rng() * TAU, v: (rng() - 0.5) * 0.5 });
    else P.push({ k: 'ball', b: Math.floor(rng() * 3), d: [rng() - 0.5, rng() - 0.5, rng() - 0.5].map((v) => v * 0.16) });
  }
  return {
    n,
    animate(t, o) {
      for (let i = 0; i < n; i++) {
        const p = P[i]; let x, y, z;
        if (p.k === 'm') {
          const r = 1 + p.v * Math.cos(p.u / 2);
          x = r * Math.cos(p.u) * 0.62; y = r * Math.sin(p.u) * 0.62 - 0.25; z = p.v * Math.sin(p.u / 2) * 0.62;
          [y, z] = rotX(y + 0.25, z, t * 0.5); y -= 0.25;
          [x, z] = rotY(x, z, t * 0.7);
        } else {
          const ph = t * 2.2 + p.b * TAU / 3, s = (ph % TAU) / TAU;
          x = Math.cos(ph) * 0.7 + p.d[0]; y = 0.55 + Math.sin(s * Math.PI) * 0.5 + p.d[1]; z = Math.sin(ph) * 0.2 + p.d[2];
        }
        o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
      }
    },
  };
}

// ── Self: a lotus mandala, layers turning against each other ──
function lotus(n, rng) {
  const layers = [{ k: 6, R: 0.5, z: 0.15 }, { k: 9, R: 0.8, z: 0.05 }, { k: 12, R: 1.05, z: -0.05 }];
  const P = [];
  for (let i = 0; i < n; i++) {
    const r = rng();
    if (r < 0.86) { const L = Math.floor(rng() * 3), j = Math.floor(rng() * layers[L].k), s = rng(), side = rng() < 0.5 ? 1 : -1, fill = rng() < 0.2 ? rng() : 1; P.push({ k: 'petal', L, j, s, side, fill }); }
    else P.push({ k: 'core', a: rng() * TAU, r: Math.sqrt(rng()) * 0.16, z: rng() * 0.1 });
  }
  return {
    n,
    animate(t, o) {
      const breathe = 1 + 0.05 * Math.sin(t * 1.4);
      for (let i = 0; i < n; i++) {
        const p = P[i]; let x, y, z;
        if (p.k === 'core') { const a = p.a + t; x = Math.cos(a) * p.r; y = Math.sin(a) * p.r; z = 0.25 + p.z; }
        else {
          const Lr = layers[p.L], base = p.j * TAU / Lr.k + t * 0.12 * (p.L % 2 ? -1 : 1);
          const len = (0.12 + p.s * 0.88) * Lr.R * breathe, half = Math.sin(Math.PI * p.s) * (Math.PI / Lr.k) * 0.85 * p.side * p.fill;
          const a = base + half;
          x = Math.cos(a) * len; y = Math.sin(a) * len; z = Lr.z + Math.sin(Math.PI * p.s) * 0.12;
        }
        [y, z] = rotX(y, z, -0.35);
        o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
      }
    },
  };
}

// ── Implanted personas: a creature grown from a genome (name + style) ──
export function genome(label, style) {
  const r = seeded(label + '|' + style);
  return {
    sym: 3 + Math.floor(r() * 6),
    arms: 4 + Math.floor(r() * 6),
    wave: 0.6 + r() * 1.6,
    bulge: 0.1 + r() * 0.3,
    spin: (r() - 0.5) * 0.8,
    len: 0.7 + r() * 0.6,
  };
}
function creature(n, rng, style, g) {
  const P = [];
  for (let i = 0; i < n; i++) P.push({ a: rng() * TAU, b: rng(), c: rng(), d: rng(), arm: Math.floor(rng() * g.arms), part: rng() });
  const S = g.sym;
  return {
    n,
    animate(t, o) {
      for (let i = 0; i < n; i++) {
        const p = P[i]; let x = 0, y = 0, z = 0;
        if (style === 'nerd') { // a turning wire polyhedron with orbiting electrons
          if (p.part < 0.8) {
            const V = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
            const E = [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [2, 5], [3, 4], [3, 5]];
            const e = E[Math.floor(p.b * 12)]; const u = p.c;
            [x, y, z] = V[e[0]].map((v, k) => (v + (V[e[1]][k] - v) * u) * 0.75);
          } else { const a = p.a + t * 2; x = Math.cos(a) * 1.0; y = Math.sin(a) * Math.cos(p.arm) * 1.0; z = Math.sin(a) * Math.sin(p.arm) * 1.0; }
          [x, z] = rotY(x, z, t * 0.5); [y, z] = rotX(y, z, t * 0.3);
        } else if (style === 'zen') { // ensō circles, breathing
          const ring = Math.floor(p.b * 3), gap = 0.25 + ring * 0.1;
          const a = gap + p.a * (1 - gap / TAU) + t * 0.1 * (ring % 2 ? 1 : -1);
          const rr = (0.45 + ring * 0.3) * (1 + 0.04 * Math.sin(t + ring)) + (p.c - 0.5) * 0.05 * (1 + Math.sin(a * 3));
          x = Math.cos(a) * rr; y = Math.sin(a) * rr; z = (p.d - 0.5) * 0.05;
        } else if (style === 'optimist') { // a sunburst
          if (p.part < 0.35) { const rr = Math.sqrt(p.b) * 0.35; x = Math.cos(p.a) * rr; y = Math.sin(p.a) * rr; z = 0; }
          else { const k = Math.floor(p.b * S * 2), a = k * TAU / (S * 2) + t * 0.2; const rr = 0.42 + p.c * (0.5 + 0.15 * Math.sin(t * 3 + k)); x = Math.cos(a) * rr; y = Math.sin(a) * rr; z = 0; }
        } else if (style === 'chaos') { // a turbulent knot
          const a = p.a, q = p.b * TAU;
          const rr = 0.6 + 0.25 * Math.sin(S * a + t * 1.7) + 0.15 * Math.sin(q * 3 + t * 2.3);
          x = Math.cos(a) * rr + 0.1 * Math.sin(t * 3 + p.c * 9); y = Math.sin(a) * rr * Math.cos(q * 0.5); z = Math.sin(q + t) * 0.4 * p.c;
          [x, z] = rotY(x, z, t * 0.9);
        } else if (style === 'contrarian') { // a spiky urchin
          const th = p.a, ph = Math.acos(2 * p.b - 1);
          const spike = Math.pow(Math.abs(Math.cos(S * th) * Math.sin(S * ph)), 6);
          const rr = (0.45 + spike * 0.6) * (p.part < 0.25 ? p.c : 1);
          x = Math.sin(ph) * Math.cos(th) * rr; y = Math.cos(ph) * rr; z = Math.sin(ph) * Math.sin(th) * rr;
          [x, z] = rotY(x, z, t * 0.4 + g.spin);
        } else { // poet (default): a jellyfish with flowing tentacles
          if (p.part < 0.45) {
            const th = p.a, ph = p.b * Math.PI / 2;
            const rr = 0.55 * (1 + g.bulge * Math.sin(S * th)) * (1 + 0.06 * Math.sin(t * 2));
            x = Math.sin(ph) * Math.cos(th) * rr; z = Math.sin(ph) * Math.sin(th) * rr; y = 0.25 + Math.cos(ph) * rr * 0.75;
          } else {
            const a = p.arm * TAU / g.arms, u = p.c;
            const sw = Math.sin(t * g.wave * 2 - u * 6 + p.arm) * 0.12 * u;
            x = Math.cos(a) * (0.42 - u * 0.15) + sw; z = Math.sin(a) * (0.42 - u * 0.15) + Math.cos(t * g.wave - u * 5) * 0.08 * u; y = 0.2 - u * g.len * 1.3;
          }
          [x, z] = rotY(x, z, t * 0.25 + g.spin);
          y += Math.sin(t * 1.2) * 0.06;
        }
        o[i * 3] = x; o[i * 3 + 1] = y; o[i * 3 + 2] = z;
      }
    },
  };
}

const CORE_FORMS = { curious: eye, skeptic: shield, dreamer: whale, builder: golem, memory: tree, jester: mobius, self: lotus };
export const FORM_NAMES = {
  curious: { zh: '螺旋之眼', en: 'Spiral Eye' },
  skeptic: { zh: '棱镜之盾', en: 'Lens Shield' },
  dreamer: { zh: '星海之鲸', en: 'Star Whale' },
  builder: { zh: '自组构造体', en: 'Self-Assembling Construct' },
  memory: { zh: '年轮之树', en: 'Ring Tree' },
  jester: { zh: '莫比乌斯杂耍', en: 'Möbius Juggler' },
  self: { zh: '曼陀罗之莲', en: 'Mandala Lotus' },
};
export const STYLE_FORM_NAMES = {
  poet: { zh: '浮游水母', en: 'Drifting Medusa' },
  contrarian: { zh: '逆刺海胆', en: 'Contrary Urchin' },
  nerd: { zh: '轨道多面体', en: 'Orbital Polyhedron' },
  chaos: { zh: '湍流之结', en: 'Turbulent Knot' },
  zen: { zh: '圆相', en: 'Ensō Rings' },
  optimist: { zh: '日冕', en: 'Corona' },
};

export function makeForm(agent, n) {
  const rng = seeded('form|' + agent.id);
  if (CORE_FORMS[agent.id]) return CORE_FORMS[agent.id](n, rng);
  const label = agent.implant?.label || agent.id, style = agent.style || 'poet';
  return creature(n, rng, style, genome(label, style));
}
export function formName(agent, lang) {
  return (FORM_NAMES[agent.id] || STYLE_FORM_NAMES[agent.style] || STYLE_FORM_NAMES.poet)[lang];
}
export { hashStr };

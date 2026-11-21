// Canvas renderer: wireframe head, agents, synapses and message pulses.
import { buildHead, makeProjector, bezier3, arcControl, ANCHORS } from './geometry.js';

const TAU = Math.PI * 2;
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => 1 - Math.pow(1 - t, 3);

export class MindRenderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.head = buildHead();
    this.agents = new Map();
    this.pulses = [];
    this.waves = [];
    this.zs = [];
    this.t = 0;
    this.assemble = 0;
    this.sleep = 0; this.sleepTarget = 0;
    this.mouse = { x: 0.5, y: 0.5, active: false };
    this.yaw = 0; this.pitch = -0.06;
    this.hover = null;
    this.focus = 0; // brightens the head during meetings
    this.focusTarget = 0;
    this.dust = Array.from({ length: 110 }, () => {
      const u = Math.random() * TAU, v = Math.acos(2 * Math.random() - 1), r = Math.cbrt(Math.random()) * 0.6;
      return { p: [Math.sin(v) * Math.cos(u) * r * 0.95, 0.28 + Math.cos(v) * r * 0.75, -0.05 + Math.sin(v) * Math.sin(u) * r], ph: Math.random() * TAU };
    });
    this.stars = Array.from({ length: 220 }, () => {
      const u = Math.random() * TAU, v = Math.acos(2 * Math.random() - 1), r = 5 + Math.random() * 6;
      return { p: [Math.sin(v) * Math.cos(u) * r, Math.cos(v) * r * 0.6, -Math.abs(Math.sin(v) * Math.sin(u) * r) - 1], b: Math.random() };
    });
    this.resize();
    addEventListener('resize', () => this.resize());
    addEventListener('pointermove', (e) => {
      this.mouse.x = e.clientX / innerWidth; this.mouse.y = e.clientY / innerHeight; this.mouse.active = e.pointerType === 'mouse';
      this.hover = this.hitTest(e.clientX, e.clientY);
      this.cv.style.cursor = this.hover ? 'pointer' : 'default';
    });
    this.last = performance.now();
    requestAnimationFrame((n) => this.loop(n));
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.dpr = dpr;
    this.w = innerWidth; this.h = innerHeight;
    this.cv.width = this.w * dpr; this.cv.height = this.h * dpr;
    this.cv.style.width = this.w + 'px'; this.cv.style.height = this.h + 'px';
    const wide = this.w > 960;
    this.cx = wide ? this.w * 0.42 : this.w / 2;
    this.cy = wide ? this.h * 0.43 : this.h * 0.4;
    this.scale = wide ? Math.min(this.h * 0.255, this.w * 0.2) : Math.min(this.w * 0.36, this.h * 0.2);
  }

  setAgents(list) {
    const next = new Map();
    for (const a of list) {
      const prev = this.agents.get(a.id);
      next.set(a.id, prev ? Object.assign(prev, a) : { ...a, rgb: hexRgb(a.color), act: 0, speak: 0, think: 0, birth: a.born ? 0 : 1, ph: Math.random() * TAU });
      next.get(a.id).rgb = hexRgb(a.color);
    }
    this.agents = next;
  }

  posOf(id) {
    const a = this.agents.get(id);
    if (!a) return ANCHORS[id] || [0, 0.3, 0];
    const b = Math.sin(this.t * 0.9 + a.ph) * 0.018;
    return [a.pos[0], a.pos[1] + b, a.pos[2]];
  }
  screenOf(id) {
    const a = this.agents.get(id); if (!a || !this.proj) return null;
    const p = this.proj(this.posOf(id));
    return { x: p.x, y: p.y, r: this.orbR(a, p) };
  }
  orbR(a, p) { return this.scale * p.s * 0.042 * (a.id === 'self' ? 1.25 : 1) * (0.3 + 0.7 * ease(a.birth)); }

  hitTest(x, y) {
    if (!this.proj) return null;
    let best = null, bd = 1e9;
    for (const a of this.agents.values()) {
      const p = this.proj(this.posOf(a.id));
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < Math.max(18, this.orbR(a, p) * 2) && d < bd) { bd = d; best = a.id; }
    }
    return best;
  }

  // Send a glowing message from A to B (agent ids or anchor names or raw points).
  pulse(from, to, { color = '#ffffff', dur = 0.9, size = 1, lift = 0.22, delay = 0, onArrive } = {}) {
    const res = (x) => (typeof x === 'string' ? () => this.posOf(x) : () => x);
    this.pulses.push({ a: res(from), b: res(to), to, color: hexRgb(color), dur, size, lift, t: -delay / dur, onArrive });
  }
  burst(from, to, n, opts = {}) {
    for (let i = 0; i < n; i++) this.pulse(from, to, { ...opts, delay: (opts.delay || 0) + i * (opts.gap || 0.07), size: (opts.size || 1) * (0.5 + Math.random() * 0.6), lift: (opts.lift ?? 0.22) + (Math.random() - 0.5) * 0.2 });
  }
  setSpeaking(id) { for (const a of this.agents.values()) a.speaking = a.id === id; }
  setThinking(ids) { const s = new Set(ids || []); for (const a of this.agents.values()) a.thinking = s.has(a.id); }
  flash(id, k = 1) { const a = this.agents.get(id); if (a) a.act = Math.min(1.6, a.act + k); }
  wave(id, color) { this.waves.push({ id, t: 0, rgb: hexRgb(color || this.agents.get(id)?.color || '#ffffff') }); }

  loop(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    this.t += dt;
    this.update(dt);
    this.draw();
    requestAnimationFrame((n) => this.loop(n));
  }

  update(dt) {
    this.assemble = Math.min(1, this.assemble + dt / 2.4);
    this.sleep += (this.sleepTarget - this.sleep) * Math.min(1, dt * 1.5);
    this.focus += (this.focusTarget - this.focus) * Math.min(1, dt * 2);
    // rest in a three-quarter view so the profile reads; drift and follow the pointer around it
    const sway = 0.72 + Math.sin(this.t * 0.17) * 0.32 * (1 - this.sleep * 0.6);
    const targetYaw = this.mouse.active ? 0.72 + (this.mouse.x - 0.5) * 1.6 + Math.sin(this.t * 0.17) * 0.1 : sway;
    const targetPitch = -0.06 + (this.mouse.active ? (this.mouse.y - 0.5) * 0.3 : Math.sin(this.t * 0.11) * 0.05) + this.sleep * 0.1;
    this.yaw += (targetYaw - this.yaw) * Math.min(1, dt * 2.2);
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 2.2);
    for (const a of this.agents.values()) {
      a.act *= Math.exp(-dt * 2.2);
      a.speak += ((a.speaking ? 1 : 0) - a.speak) * Math.min(1, dt * 6);
      a.think += ((a.thinking ? 1 : 0) - a.think) * Math.min(1, dt * 4);
      if (a.birth < 1) a.birth = Math.min(1, a.birth + dt / 1.2);
      if (this.sleep > 0.5 && Math.random() < dt * 0.35) this.zs.push({ id: a.id, t: 0, x: (Math.random() - 0.5) * 10 });
    }
    for (const p of this.pulses) {
      const before = p.t; p.t += dt / p.dur;
      if (before < 1 && p.t >= 1) {
        if (typeof p.to === 'string') this.flash(p.to, 0.35);
        p.onArrive?.();
      }
    }
    this.pulses = this.pulses.filter((p) => p.t < 1.25);
    for (const w of this.waves) w.t += dt / 1.1;
    this.waves = this.waves.filter((w) => w.t < 1);
    for (const z of this.zs) z.t += dt / 2.6;
    this.zs = this.zs.filter((z) => z.t < 1);
  }

  draw() {
    const { ctx, dpr, w, h } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    const proj = (this.proj = makeProjector({ yaw: this.yaw, pitch: this.pitch, scale: this.scale, cx: this.cx, cy: this.cy }));
    ctx.globalCompositeOperation = 'lighter';
    const sl = this.sleep;
    const headRgb = [Math.round(90 + 60 * sl), Math.round(210 - 90 * sl), 255];

    // stars
    for (const s of this.stars) {
      const p = proj(s.p);
      const a = (0.15 + 0.35 * s.b) * (0.6 + 0.4 * Math.sin(this.t * (0.5 + s.b) + s.b * 9));
      ctx.fillStyle = rgba([180, 210, 255], a * 0.6);
      ctx.fillRect(p.x, p.y, 1.2, 1.2);
    }

    // head wireframe, bucketed by depth
    const rings = this.head.rings, nR = rings.length, seg = this.head.seg;
    const P = rings.map((r) => r.pts.map(proj));
    const B = 7, buckets = Array.from({ length: B }, () => []);
    const reveal = this.assemble * (nR + 6);
    const baseA = (0.5 + 0.35 * this.focus) * (1 - 0.35 * sl);
    for (let i = 0; i < nR; i++) {
      const vis = clamp(reveal - i, 0, 1);
      if (vis <= 0) continue;
      const pts = P[i], fade = rings[i].fade * vis;
      const nSeg = Math.floor(seg * clamp((reveal - i) / 1.5, 0, 1));
      for (let j = 0; j < nSeg; j++) {
        const p = pts[j], q = pts[(j + 1) % seg];
        const d = (p.z + q.z) / 2;
        const depth = clamp((d + 1) / 2.1, 0, 1);
        const a = (0.05 + 0.95 * depth * depth) * fade;
        buckets[Math.min(B - 1, Math.floor(a * B))].push(p.x, p.y, q.x, q.y);
      }
      if (!rings[i].neck && i < nR - 1 && !rings[i + 1].neck && vis >= 1) {
        for (let j = 0; j < seg; j += 6) {
          const p = pts[j], q = P[i + 1][j];
          const depth = clamp(((p.z + q.z) / 2 + 1) / 2.1, 0, 1);
          const a = (0.03 + 0.5 * depth * depth) * fade;
          buckets[Math.min(B - 1, Math.floor(a * B))].push(p.x, p.y, q.x, q.y);
        }
      }
    }
    ctx.lineWidth = 1;
    for (let b = 0; b < B; b++) {
      const arr = buckets[b]; if (!arr.length) continue;
      ctx.strokeStyle = rgba(headRgb, ((b + 0.5) / B) * baseA);
      ctx.beginPath();
      for (let k = 0; k < arr.length; k += 4) { ctx.moveTo(arr[k], arr[k + 1]); ctx.lineTo(arr[k + 2], arr[k + 3]); }
      ctx.stroke();
    }
    // scanning band
    if (this.assemble >= 1) {
      const scanY = 1.15 - ((this.t * 0.32) % 2.9);
      ctx.lineWidth = 1.4;
      for (let i = 0; i < nR; i++) {
        const d = Math.abs(rings[i].y - scanY);
        if (d > 0.09) continue;
        const k = (1 - d / 0.09) * 0.55 * (1 - 0.6 * sl);
        ctx.strokeStyle = rgba([200, 245, 255], k);
        ctx.beginPath();
        const pts = P[i];
        for (let j = 0; j <= seg; j++) { const p = pts[j % seg]; if (p.z < -0.2) { ctx.moveTo(p.x, p.y); continue; } j === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); }
        ctx.stroke();
      }
    }

    // inner dust
    for (const d of this.dust) {
      const p = proj([d.p[0] + Math.sin(this.t * 0.3 + d.ph) * 0.03, d.p[1] + Math.cos(this.t * 0.25 + d.ph) * 0.03, d.p[2]]);
      const a = (0.12 + 0.18 * Math.sin(this.t * 1.3 + d.ph * 3)) * this.assemble;
      ctx.fillStyle = rgba([170, 220, 255], Math.max(0, a));
      ctx.fillRect(p.x, p.y, 1.4, 1.4);
    }

    const agents = [...this.agents.values()];
    const A = new Map(agents.map((a) => [a.id, proj(this.posOf(a.id))]));
    const appear = clamp((this.assemble - 0.55) / 0.45, 0, 1);

    // synapses (self ↔ everyone, plus a loose ring)
    const self = A.get('self');
    if (self) {
      const ring = agents.filter((a) => a.id !== 'self');
      ctx.lineWidth = 1;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], p = A.get(a.id);
        const k = (0.07 + 0.4 * Math.min(1, a.act) + 0.15 * a.speak) * appear * a.birth;
        const g = ctx.createLinearGradient(self.x, self.y, p.x, p.y);
        g.addColorStop(0, rgba([220, 240, 255], k * 0.6)); g.addColorStop(1, rgba(a.rgb, k));
        ctx.strokeStyle = g;
        ctx.beginPath(); ctx.moveTo(self.x, self.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        const nb = ring[(i + 1) % ring.length];
        if (nb && ring.length > 2) {
          const q = A.get(nb.id);
          ctx.strokeStyle = rgba(a.rgb, 0.05 * appear);
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
      }
    }

    // pulses
    for (const pu of this.pulses) {
      if (pu.t < 0) continue;
      const a = pu.a(), c = pu.b(), m = arcControl(a, c, pu.lift);
      const tt = Math.min(1, pu.t);
      const fadeOut = pu.t > 1 ? 1 - (pu.t - 1) / 0.25 : 1;
      for (let k = 9; k >= 0; k--) {
        const s = tt - k * 0.022; if (s < 0) continue;
        const p = proj(bezier3(a, m, c, ease(s)));
        const r = (2.6 - k * 0.22) * pu.size * p.s;
        ctx.fillStyle = rgba(pu.color, (k === 0 ? 0.95 : 0.5 * (1 - k / 10)) * fadeOut);
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.4, r), 0, TAU); ctx.fill();
      }
      const head = proj(bezier3(a, m, c, ease(tt)));
      const gl = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 16 * pu.size);
      gl.addColorStop(0, rgba(pu.color, 0.45 * fadeOut)); gl.addColorStop(1, rgba(pu.color, 0));
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(head.x, head.y, 16 * pu.size, 0, TAU); ctx.fill();
    }

    // shock waves
    for (const wv of this.waves) {
      const p = A.get(wv.id); if (!p) continue;
      ctx.strokeStyle = rgba(wv.rgb, (1 - wv.t) * 0.8);
      ctx.lineWidth = 2 * (1 - wv.t) + 0.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 8 + ease(wv.t) * 90 * p.s, 0, TAU); ctx.stroke();
    }

    // agents (back to front)
    agents.sort((x, y) => A.get(x.id).z - A.get(y.id).z);
    const zh = document.documentElement.lang === 'zh';
    for (const a of agents) {
      const p = A.get(a.id);
      const vis = appear * (a.birth < 1 ? ease(a.birth) : 1);
      if (vis <= 0) continue;
      const dim = 1 - sl * 0.55;
      const r = this.orbR(a, p) * (1 + 0.28 * a.speak + 0.25 * Math.min(1, a.act) + (a.birth < 1 ? Math.sin(a.birth * Math.PI) * 0.8 : 0));
      const breathe = 0.85 + 0.15 * Math.sin(this.t * (sl > 0.5 ? 0.8 : 2) + a.ph);
      const glowR = r * (3.6 + 1.6 * a.speak + 1.2 * a.think);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
      g.addColorStop(0, rgba(a.rgb, 0.55 * vis * breathe * dim)); g.addColorStop(0.35, rgba(a.rgb, 0.16 * vis * dim)); g.addColorStop(1, rgba(a.rgb, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, glowR, 0, TAU); ctx.fill();
      ctx.fillStyle = rgba(a.rgb, 0.9 * vis * dim);
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.62, 0, TAU); ctx.fill();
      ctx.fillStyle = rgba([255, 255, 255], 0.75 * vis * dim);
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.32, 0, TAU); ctx.fill();
      if (a.think > 0.02) {
        ctx.strokeStyle = rgba(a.rgb, 0.85 * a.think);
        ctx.lineWidth = 1.5;
        for (let k = 0; k < 3; k++) {
          const s0 = this.t * 3.2 + (k * TAU) / 3;
          ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.6, s0, s0 + 1.1); ctx.stroke();
        }
      }
      if (this.hover === a.id || a.speak > 0.05) {
        ctx.strokeStyle = rgba(a.rgb, 0.7 * Math.max(a.speak, this.hover === a.id ? 1 : 0));
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.2, 0, TAU); ctx.stroke();
      }
      // label
      ctx.globalCompositeOperation = 'source-over';
      const name = a.name[zh ? 'zh' : 'en'];
      ctx.font = `${Math.round(10 + 2 * p.s)}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = rgba(a.rgb, (0.35 + 0.45 * ((p.z + 1) / 2) + 0.3 * a.speak) * vis * dim);
      ctx.fillText((zh ? name : name.toUpperCase()) + ' ' + a.glyph, p.x, p.y + r * 2.4 + 12);
      ctx.globalCompositeOperation = 'lighter';
    }

    // sleep z's
    ctx.globalCompositeOperation = 'source-over';
    for (const z of this.zs) {
      const p = A.get(z.id); if (!p) continue;
      ctx.font = `${10 + z.t * 8}px "JetBrains Mono", monospace`;
      ctx.fillStyle = `rgba(190,170,255,${Math.sin(z.t * Math.PI) * 0.7})`;
      ctx.fillText('z', p.x + z.x + z.t * 14, p.y - 14 - z.t * 46);
    }
  }
}

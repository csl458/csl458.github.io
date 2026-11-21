// WebGL renderer: wireframe head, particle agents that can materialise into creatures, bloom.
// Same public surface as renderer2d.js so the meeting player doesn't care which one runs.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildHead, bezier3, arcControl, ANCHORS } from './geometry.js';
import { makeForm, formName } from './forms.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => 1 - Math.pow(1 - t, 3);
const FOV = 34;

const HEAD_VS = /* glsl */`
  uniform float uAssemble, uScanY, uBright, uFocusAmt;
  uniform vec3 uFocusPos;
  attribute float aFade; attribute float aOrder;
  varying float vA; varying float vFoc;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec3 n = normalize(mat3(modelMatrix) * (position - vec3(0.0, 0.1, -0.05)));
    float facing = dot(n, normalize(cameraPosition - wp.xyz));
    float front = smoothstep(-0.55, 1.0, facing);
    float vis = clamp((uAssemble * 1.15 - aOrder) * 8.0, 0.0, 1.0);
    float scan = (1.0 - smoothstep(0.0, 0.09, abs(position.y - uScanY))) * step(0.0, facing);
    vFoc = uFocusAmt * (1.0 - smoothstep(0.05, 0.5, distance(position, uFocusPos)));
    vA = ((0.05 + 0.6 * front * front) * uBright + scan * 0.55 * uBright) * aFade * vis + vFoc * 0.85 * vis;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const HEAD_FS = /* glsl */`
  uniform vec3 uColor, uFocusColor;
  varying float vA; varying float vFoc;
  void main() { gl_FragColor = vec4(mix(uColor, uFocusColor, clamp(vFoc * 2.0, 0.0, 1.0)), vA); }`;

const AGENT_VS = /* glsl */`
  uniform vec3 uCenter, uFormCenter;
  uniform float uFormScale, uMorph, uTime, uOrbR, uSize, uBright, uScale, uThink, uGain;
  attribute vec3 aOrb; attribute vec3 aForm; attribute float aRand;
  varying float vA;
  void main() {
    float d = clamp(uMorph * 1.7 - aRand * 0.7, 0.0, 1.0);
    d = d * d * (3.0 - 2.0 * d);
    float sw = uTime * (1.0 + 2.5 * uThink) + aRand * 6.2831;
    vec3 o = aOrb * (1.0 + 0.7 * uThink);
    o.xz = mat2(cos(sw * 0.3), -sin(sw * 0.3), sin(sw * 0.3), cos(sw * 0.3)) * o.xz;
    vec3 orb = uCenter + o * uOrbR;
    vec3 form = uFormCenter + aForm * uFormScale;
    vec3 mid = mix(orb, form, 0.5) + vec3(sin(aRand * 40.0), 0.35 + cos(aRand * 23.0) * 0.2, 0.1) * (0.2 + 0.4 * uFormScale);
    vec3 p = mix(mix(orb, mid, d), mix(mid, form, d), d);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float s = mix(1.0, 0.55 + aRand * 0.9, d);
    gl_PointSize = max(1.0, uSize * s * uScale / -mv.z);
    float tw = 0.55 + 0.45 * sin(uTime * (1.5 + aRand * 3.0) + aRand * 50.0);
    // ~1500 particles overlap inside an orb, so each one must be faint there; in a form they spread out
    vA = uBright * mix(0.022 * (1.0 - 0.6 * length(aOrb)), (0.34 + 0.42 * tw) * uGain, d);
  }`;
const AGENT_FS = /* glsl */`
  uniform vec3 uColor;
  varying float vA;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    float a = 1.0 - smoothstep(0.05, 0.5, r);
    gl_FragColor = vec4(mix(uColor, vec3(1.0), (1.0 - smoothstep(0.0, 0.25, r)) * 0.45), a * vA);
  }`;

const DOT_VS = /* glsl */`
  uniform float uScale;
  attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
  varying vec3 vC; varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, aSize * uScale / -mv.z);
    vC = aColor; vA = aAlpha;
  }`;
const DOT_FS = /* glsl */`
  varying vec3 vC; varying float vA;
  void main() { float r = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vC, (1.0 - smoothstep(0.0, 0.5, r)) * vA); }`;

const additive = { transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending };

export class MindRenderer {
  constructor(canvas) {
    this.cv = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 100);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.t = 0; this.assemble = 0;
    this.sleep = 0; this.sleepTarget = 0;
    this.focus = 0; this.focusTarget = 0;
    this.mouse = { x: 0.5, y: 0.5, active: false };
    this.yaw = 0.72; this.pitch = -0.06;
    this.hover = null;
    this.agents = new Map();
    this.pulses = []; this.waves = [];
    this.stageId = null; this.releaseTimer = null;
    this.camTarget = new THREE.Vector3(); this.camTargetGoal = new THREE.Vector3();
    this.zoom = 1; this.zoomGoal = 1; this.yawOverride = null;
    this.focusPos = new THREE.Vector3(); this.focusAmt = 0; this.focusAmtGoal = 0; this.focusColor = new THREE.Color('#ffffff');

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'label-layer';
    document.body.append(this.labelLayer);
    this.stageLabel = document.createElement('div');
    this.stageLabel.className = 'stage-label';
    this.labelLayer.append(this.stageLabel);
    this.zs = [];

    this.buildHead(); this.buildDust(); this.buildStars(); this.buildPulses(); this.buildSynapses(); this.buildWaves();

    this.composer = new EffectComposer(this.gl);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.75, 0.5, 0.18);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    addEventListener('resize', () => this.resize());
    addEventListener('pointermove', (e) => {
      this.mouse.x = e.clientX / innerWidth; this.mouse.y = e.clientY / innerHeight; this.mouse.active = e.pointerType === 'mouse';
      this.hover = this.hitTest(e.clientX, e.clientY);
      this.cv.style.cursor = this.hover ? 'pointer' : 'default';
    });
    this.last = performance.now();
    this.gl.setAnimationLoop((now) => this.loop(now));
  }

  // ── scene parts ──
  buildHead() {
    const head = buildHead({ lat: 40, seg: 128 });
    const pos = [], fade = [], order = [];
    const nR = head.rings.length;
    head.rings.forEach((ring, i) => {
      const pts = ring.pts, seg = pts.length;
      for (let j = 0; j < seg; j++) {
        const a = pts[j], b = pts[(j + 1) % seg];
        pos.push(...a, ...b); fade.push(ring.fade, ring.fade); order.push(i / nR, i / nR);
      }
      if (!ring.neck && i < nR - 1 && !head.rings[i + 1].neck) {
        for (let j = 0; j < seg; j += 8) { pos.push(...pts[j], ...head.rings[i + 1].pts[j]); fade.push(0.55, 0.55); order.push(i / nR, i / nR); }
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aFade', new THREE.Float32BufferAttribute(fade, 1));
    g.setAttribute('aOrder', new THREE.Float32BufferAttribute(order, 1));
    this.headMat = new THREE.ShaderMaterial({
      vertexShader: HEAD_VS, fragmentShader: HEAD_FS, ...additive,
      uniforms: {
        uAssemble: { value: 0 }, uScanY: { value: 1 }, uBright: { value: 0.6 },
        uColor: { value: new THREE.Color('#5ec8ff') }, uFocusPos: { value: new THREE.Vector3() }, uFocusAmt: { value: 0 }, uFocusColor: { value: new THREE.Color('#ffffff') },
      },
    });
    this.head = new THREE.LineSegments(g, this.headMat);
    this.head.frustumCulled = false;
    this.world.add(this.head);
  }
  dotMaterial() {
    return new THREE.ShaderMaterial({ vertexShader: DOT_VS, fragmentShader: DOT_FS, ...additive, uniforms: { uScale: { value: 600 } } });
  }
  makeDots(n) {
    const g = new THREE.BufferGeometry();
    const P = new Float32Array(n * 3), C = new Float32Array(n * 3), S = new Float32Array(n), A = new Float32Array(n);
    g.setAttribute('position', new THREE.BufferAttribute(P, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(C, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(S, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(A, 1).setUsage(THREE.DynamicDrawUsage));
    const m = this.dotMaterial();
    const pts = new THREE.Points(g, m); pts.frustumCulled = false;
    return { pts, P, C, S, A, g, m, n };
  }
  buildDust() {
    this.dust = this.makeDots(140);
    this.dustSeed = Array.from({ length: 140 }, () => {
      const u = Math.random() * TAU, v = Math.acos(2 * Math.random() - 1), r = Math.cbrt(Math.random()) * 0.6;
      return { p: [Math.sin(v) * Math.cos(u) * r * 0.95, 0.28 + Math.cos(v) * r * 0.75, -0.05 + Math.sin(v) * Math.sin(u) * r], ph: Math.random() * TAU };
    });
    this.world.add(this.dust.pts);
  }
  buildStars() {
    const n = 420, d = this.makeDots(n);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * TAU, v = Math.acos(2 * Math.random() - 1), r = 9 + Math.random() * 10;
      d.P.set([Math.sin(v) * Math.cos(u) * r, Math.cos(v) * r * 0.7, -Math.abs(Math.sin(v) * Math.sin(u) * r) - 2], i * 3);
      d.C.set([0.65, 0.78, 1], i * 3); d.S[i] = 0.035 + Math.random() * 0.05; d.A[i] = 0.25 + Math.random() * 0.5;
    }
    this.starSeed = Float32Array.from(d.A);
    this.stars = d; this.starGroup = new THREE.Group(); this.starGroup.add(d.pts); this.scene.add(this.starGroup);
  }
  buildPulses() { this.pdots = this.makeDots(3200); this.world.add(this.pdots.pts); }
  buildSynapses() {
    const g = new THREE.BufferGeometry();
    this.synP = new Float32Array(40 * 2 * 3); this.synC = new Float32Array(40 * 2 * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.synP, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.synC, 3).setUsage(THREE.DynamicDrawUsage));
    this.syn = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, ...additive }));
    this.syn.frustumCulled = false; this.synG = g;
    this.world.add(this.syn);
  }
  buildWaves() {
    this.wavePool = Array.from({ length: 14 }, () => {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 72), new THREE.MeshBasicMaterial({ color: '#ffffff', ...additive, opacity: 0, side: THREE.DoubleSide }));
      m.visible = false; this.scene.add(m); return m;
    });
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.w = Math.max(320, innerWidth || 0); this.h = Math.max(320, innerHeight || 0);
    this.gl.setPixelRatio(dpr);
    this.gl.setSize(this.w, this.h, false);
    this.cv.style.width = this.w + 'px'; this.cv.style.height = this.h + 'px';
    this.composer.setPixelRatio(Math.min(dpr, 1.5));
    this.composer.setSize(this.w, this.h);
    const wide = this.w > 960;
    this.cx = wide ? this.w * 0.42 : this.w / 2;
    this.cy = wide ? this.h * 0.44 : this.h * 0.41;
    this.unitPx = wide ? Math.min(this.h * 0.29, this.w * 0.21) : Math.min(this.w * 0.38, this.h * 0.21);
    this.baseDist = this.h / (2 * this.unitPx * Math.tan((FOV * Math.PI) / 360));
    this.camera.aspect = this.w / this.h;
    this.camera.setViewOffset(this.w, this.h, this.w / 2 - this.cx, this.h / 2 - this.cy, this.w, this.h);
    this.camera.updateProjectionMatrix();
    // point sizes are in the composer's render-target pixels
    this.pxScale = (this.h * 0.5) / Math.tan((FOV * Math.PI) / 360) * Math.min(dpr, 1.5);
    // background: a soft radial glow behind the head
    const c = document.createElement('canvas'); c.width = 512; c.height = Math.max(2, Math.round(512 * this.h / this.w));
    const x = c.getContext('2d');
    const gr = x.createRadialGradient(c.width * this.cx / this.w, c.height * this.cy / this.h, 0, c.width * this.cx / this.w, c.height * this.cy / this.h, c.width * 0.75);
    gr.addColorStop(0, '#0b1a33'); gr.addColorStop(0.4, '#06101f'); gr.addColorStop(1, '#02050b');
    x.fillStyle = gr; x.fillRect(0, 0, c.width, c.height);
    this.scene.background?.dispose?.();
    this.scene.background = new THREE.CanvasTexture(c);
    this.scene.background.colorSpace = THREE.SRGBColorSpace;
  }

  // ── agents ──
  setAgents(list) {
    const next = new Map();
    for (const a of list) {
      let s = this.agents.get(a.id);
      if (!s) {
        const n = a.core ? 1500 : 1100;
        const form = makeForm(a, n);
        const g = new THREE.BufferGeometry();
        const orb = new Float32Array(n * 3), F = new Float32Array(n * 3), R = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const u = Math.random() * TAU, v = Math.acos(2 * Math.random() - 1), r = Math.pow(Math.random(), 1.8);
          orb.set([Math.sin(v) * Math.cos(u) * r, Math.cos(v) * r, Math.sin(v) * Math.sin(u) * r], i * 3);
          R[i] = Math.random();
        }
        form.animate(0, F);
        g.setAttribute('position', new THREE.BufferAttribute(orb, 3));
        g.setAttribute('aOrb', new THREE.BufferAttribute(orb, 3));
        g.setAttribute('aForm', new THREE.BufferAttribute(F, 3).setUsage(THREE.DynamicDrawUsage));
        g.setAttribute('aRand', new THREE.BufferAttribute(R, 1));
        const m = new THREE.ShaderMaterial({
          vertexShader: AGENT_VS, fragmentShader: AGENT_FS, ...additive,
          uniforms: {
            uCenter: { value: new THREE.Vector3() }, uFormCenter: { value: new THREE.Vector3() }, uFormScale: { value: 0.1 },
            uMorph: { value: 0 }, uTime: { value: 0 }, uOrbR: { value: 0.05 }, uSize: { value: 0.016 }, uBright: { value: 0 },
            uScale: { value: 600 }, uThink: { value: 0 }, uGain: { value: a.id === 'self' ? 0.8 : 1 }, uColor: { value: new THREE.Color(a.color) },
          },
        });
        const pts = new THREE.Points(g, m); pts.frustumCulled = false;
        this.scene.add(pts);
        const label = document.createElement('div'); label.className = 'agent-label'; this.labelLayer.append(label);
        s = { act: 0, speak: 0, think: 0, birth: a.born ? 0 : 1, ph: Math.random() * TAU, morph: 0, morphGoal: 0, mode: 'aura',
          form, F, g, m, pts, label, n, formCenter: new THREE.Vector3(), formScale: 0.1, formT: Math.random() * 10 };
      }
      Object.assign(s, a, { color: a.color });
      s.m.uniforms.uColor.value.set(a.color);
      s.label.style.color = a.color;
      next.set(a.id, s);
    }
    for (const [id, s] of this.agents) if (!next.has(id)) { this.scene.remove(s.pts); s.g.dispose(); s.m.dispose(); s.label.remove(); if (this.stageId === id) this.stageId = null; }
    this.agents = next;
  }

  posOf(id) {
    const a = this.agents.get(id);
    if (!a) return ANCHORS[id] || [0, 0.3, 0];
    const b = Math.sin(this.t * 0.9 + a.ph) * 0.018;
    return [a.pos[0], a.pos[1] + b, a.pos[2]];
  }
  toWorld(p) { return new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(this.world.matrixWorld); }
  toScreen(v) {
    const q = v.clone().project(this.camera);
    return { x: (q.x + 1) / 2 * this.w, y: (1 - q.y) / 2 * this.h, depth: q.z };
  }
  // project a head-space point (for atlas markers); `front` says whether it faces the viewer
  project(p) {
    const v = this.toWorld(p), s = this.toScreen(v);
    const n = new THREE.Vector3(p[0], p[1] - 0.1, p[2] + 0.05).applyMatrix3(new THREE.Matrix3().setFromMatrix4(this.world.matrixWorld)).normalize();
    const facing = n.dot(this.camera.position.clone().sub(v).normalize());
    return { x: s.x, y: s.y, front: facing > -0.15 };
  }
  stageWorld() { return this.camTarget.clone().add(new THREE.Vector3(-0.05, 0.12, 1.55)); }
  pxRadius(worldPos, r) {
    const d = this.camera.position.distanceTo(worldPos);
    return (r * this.h) / (2 * d * Math.tan((FOV * Math.PI) / 360));
  }
  screenOf(id) {
    const a = this.agents.get(id); if (!a) return null;
    if (a.morph > 0.55 && a.mode === 'stage') {
      const c = a.formCenter, s = this.toScreen(c);
      return { x: s.x, y: s.y - this.pxRadius(c, a.formScale) * 0.55, r: this.pxRadius(c, a.formScale) * 0.6 };
    }
    const v = this.toWorld(this.posOf(id)), s = this.toScreen(v);
    return { x: s.x, y: s.y, r: this.pxRadius(v, 0.06) };
  }
  hitTest(x, y) {
    let best = null, bd = 1e9;
    for (const a of this.agents.values()) {
      if (a.mode === 'stage' && a.morph > 0.5) {
        const s = this.toScreen(a.formCenter), r = this.pxRadius(a.formCenter, a.formScale);
        if (Math.hypot(s.x - x, s.y - y) < r) return a.id;
      }
      const s = this.screenOf(a.id); if (!s) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < Math.max(18, s.r * 1.6) && d < bd) { bd = d; best = a.id; }
    }
    return best;
  }

  // ── effects API ──
  pulse(from, to, { color = '#ffffff', dur = 0.9, size = 1, lift = 0.22, delay = 0, onArrive } = {}) {
    const res = (x) => (typeof x === 'string' ? () => this.posOf(x) : () => x);
    this.pulses.push({ a: res(from), b: res(to), to, color: new THREE.Color(color), dur, size, lift, t: -delay / dur, onArrive });
  }
  burst(from, to, n, opts = {}) {
    for (let i = 0; i < n; i++) this.pulse(from, to, { ...opts, delay: (opts.delay || 0) + i * (opts.gap || 0.07), size: (opts.size || 1) * (0.5 + Math.random() * 0.6), lift: (opts.lift ?? 0.22) + (Math.random() - 0.5) * 0.2 });
  }
  setSpeaking(id) { for (const a of this.agents.values()) a.speaking = a.id === id; }
  setThinking(ids) { const s = new Set(ids || []); for (const a of this.agents.values()) a.thinking = s.has(a.id); }
  flash(id, k = 1) { const a = this.agents.get(id); if (a) a.act = Math.min(1.6, a.act + k); }
  wave(id, color) {
    const m = this.wavePool.find((w) => !w.visible); if (!m) return;
    m.visible = true; m.userData = { id, t: 0 }; m.material.color.set(color || this.agents.get(id)?.color || '#ffffff');
  }
  // Materialise an agent into its creature form in front of the head.
  materialize(id, holdMs) {
    const a = this.agents.get(id); if (!a) return;
    if (this.stageId && this.stageId !== id) this.release(this.stageId);
    this.stageId = id; a.mode = 'stage'; a.morphGoal = 1;
    clearTimeout(this.releaseTimer);
    if (holdMs) this.releaseTimer = setTimeout(() => this.release(id), holdMs);
  }
  release(id) {
    const a = this.agents.get(id || this.stageId); if (!a) return;
    a.morphGoal = 0;
    if (this.stageId === a.id) this.stageId = null;
  }
  isStaged(id) { return this.stageId === id; }
  // Fly the camera to a point in head space (brain atlas), or back home with null.
  focusOn(p, color) {
    if (!p) { this.camTargetGoal.set(0, 0, 0); this.zoomGoal = 1; this.yawOverride = null; this.focusAmtGoal = 0; return; }
    const r = Math.hypot(p[0], p[2]);
    this.yawOverride = r > 0.15 ? Math.atan2(-p[0], p[2]) + 0.35 : 0.5;
    this.focusPendingP = p;
    this.zoomGoal = 0.62; this.focusAmtGoal = 1;
    this.focusPos.set(p[0], p[1], p[2]); this.focusColor.set(color || '#ffffff');
  }

  loop(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    this.update(dt);
    this.draw();
  }

  update(dt) {
    this.t += dt;
    const t = this.t;
    this.assemble = Math.min(1, this.assemble + dt / 2.4);
    const k = (r) => Math.min(1, dt * r);
    this.sleep += (this.sleepTarget - this.sleep) * k(1.5);
    this.focus += (this.focusTarget - this.focus) * k(2);
    this.focusAmt += (this.focusAmtGoal - this.focusAmt) * k(3);
    this.zoom += (this.zoomGoal - this.zoom) * k(2.4);

    const sway = 0.72 + Math.sin(t * 0.17) * 0.32 * (1 - this.sleep * 0.6);
    let targetYaw = this.mouse.active ? 0.72 + (this.mouse.x - 0.5) * 1.6 + Math.sin(t * 0.17) * 0.1 : sway;
    let targetPitch = -0.06 + (this.mouse.active ? (this.mouse.y - 0.5) * 0.3 : Math.sin(t * 0.11) * 0.05) + this.sleep * 0.1;
    if (this.yawOverride != null) { targetYaw = this.yawOverride + (this.mouse.active ? (this.mouse.x - 0.5) * 0.3 : 0); targetPitch = -0.05; }
    this.yaw += (targetYaw - this.yaw) * k(2.2);
    this.pitch += (targetPitch - this.pitch) * k(2.2);
    this.world.rotation.set(this.pitch, this.yaw, 0);
    this.world.updateMatrixWorld(true);
    if (this.focusPendingP && this.focusAmtGoal > 0) this.camTargetGoal.copy(this.toWorld(this.focusPendingP)).multiplyScalar(0.9);
    this.camTarget.lerp(this.camTargetGoal, k(2.4));
    this.camera.position.set(this.camTarget.x, this.camTarget.y, this.camTarget.z + this.baseDist * this.zoom);
    this.camera.lookAt(this.camTarget);
    this.camera.updateMatrixWorld();
    this.starGroup.rotation.y = this.yaw * 0.25;

    const stage = this.stageWorld();
    const staged = this.stageId ? this.agents.get(this.stageId) : null;
    const stageAmt = staged ? staged.morph : 0;

    for (const a of this.agents.values()) {
      a.act *= Math.exp(-dt * 2.2);
      a.speak += ((a.speaking ? 1 : 0) - a.speak) * k(6);
      a.think += ((a.thinking ? 1 : 0) - a.think) * k(4);
      if (a.birth < 1) a.birth = Math.min(1, a.birth + dt / 1.2);
      if (this.stageId !== a.id) { a.mode = a.morph < 0.02 ? 'aura' : a.mode; a.morphGoal = a.speaking ? 0.42 : 0; }
      if (a.mode === 'aura' && this.stageId !== a.id) a.mode = 'aura';
      a.morph += (a.morphGoal - a.morph) * k(a.morphGoal > a.morph ? 1.6 : 2.2);
      const center = this.toWorld(this.posOf(a.id));
      const goalC = a.mode === 'stage' && this.stageId === a.id ? stage : center;
      const goalS = a.mode === 'stage' && this.stageId === a.id ? (a.core ? 0.62 : 0.58) : 0.17;
      if (a.morph < 0.02) { a.formCenter.copy(goalC); a.formScale = goalS; }
      a.formCenter.lerp(goalC, k(3)); a.formScale += (goalS - a.formScale) * k(3);
      if (a.morph > 0.01) { a.formT += dt; a.form.animate(a.formT, a.F); a.g.attributes.aForm.needsUpdate = true; }
      const appear = clamp((this.assemble - 0.55) / 0.45, 0, 1) * (a.birth < 1 ? ease(a.birth) : 1);
      const dimOthers = staged && staged !== a ? 1 - 0.55 * stageAmt : 1;
      const u = a.m.uniforms;
      u.uCenter.value.copy(center); u.uFormCenter.value.copy(a.formCenter); u.uFormScale.value = a.formScale;
      u.uMorph.value = a.morph; u.uTime.value = t; u.uThink.value = a.think; u.uScale.value = this.pxScale;
      u.uOrbR.value = (a.id === 'self' ? 0.062 : 0.05) * (1 + 0.3 * a.speak + 0.25 * Math.min(1, a.act) + (a.birth < 1 ? Math.sin(a.birth * Math.PI) * 0.9 : 0));
      u.uSize.value = 0.017 * (1 + 0.15 * a.speak);
      u.uBright.value = appear * (1 - 0.5 * this.sleep) * (0.75 + 0.35 * a.speak + 0.35 * Math.min(1, a.act) + (this.hover === a.id ? 0.25 : 0)) * dimOthers;
      if (this.sleep > 0.5 && Math.random() < dt * 0.35) this.zs.push({ id: a.id, t: 0, x: (Math.random() - 0.5) * 10 });
    }

    // head
    const hu = this.headMat.uniforms;
    hu.uAssemble.value = this.assemble;
    hu.uScanY.value = this.assemble >= 1 ? 1.15 - ((t * 0.32) % 2.9) : 5;
    hu.uBright.value = (0.62 + 0.3 * this.focus) * (1 - 0.35 * this.sleep) * (1 - 0.45 * stageAmt) * (1 - 0.35 * this.focusAmt);
    hu.uColor.value.setRGB(0.33 + 0.25 * this.sleep, 0.75 - 0.3 * this.sleep, 1);
    hu.uFocusAmt.value = this.focusAmt; hu.uFocusPos.value.copy(this.focusPos); hu.uFocusColor.value.copy(this.focusColor);

    // dust
    const D = this.dust;
    this.dustSeed.forEach((d, i) => {
      D.P.set([d.p[0] + Math.sin(t * 0.3 + d.ph) * 0.03, d.p[1] + Math.cos(t * 0.25 + d.ph) * 0.03, d.p[2]], i * 3);
      D.C.set([0.65, 0.85, 1], i * 3); D.S[i] = 0.012; D.A[i] = Math.max(0, (0.25 + 0.3 * Math.sin(t * 1.3 + d.ph * 3)) * this.assemble);
    });
    for (const n of ['position', 'aColor', 'aSize', 'aAlpha']) D.g.attributes[n].needsUpdate = true;
    D.m.uniforms.uScale.value = this.pxScale;
    for (let i = 0; i < this.stars.n; i++) this.stars.A[i] = this.starSeed[i] * (0.6 + 0.4 * Math.sin(t * (0.5 + this.starSeed[i]) + i));
    this.stars.g.attributes.aAlpha.needsUpdate = true;
    this.stars.m.uniforms.uScale.value = this.pxScale;

    // pulses
    for (const p of this.pulses) {
      const before = p.t; p.t += dt / p.dur;
      if (before < 1 && p.t >= 1) { if (typeof p.to === 'string') this.flash(p.to, 0.35); p.onArrive?.(); }
    }
    this.pulses = this.pulses.filter((p) => p.t < 1.25);
    const PD = this.pdots; let c = 0;
    for (const pu of this.pulses) {
      if (pu.t < 0) continue;
      const a = pu.a(), b = pu.b(), m = arcControl(a, b, pu.lift), tt = Math.min(1, pu.t);
      const fo = pu.t > 1 ? 1 - (pu.t - 1) / 0.25 : 1;
      for (let j = 0; j < 12 && c < PD.n; j++) {
        const s = tt - j * 0.02; if (s < 0) break;
        PD.P.set(bezier3(a, m, b, ease(s)), c * 3);
        PD.C.set([pu.color.r, pu.color.g, pu.color.b], c * 3);
        PD.S[c] = (j === 0 ? 0.05 : 0.03 * (1 - j / 13)) * pu.size;
        PD.A[c] = (j === 0 ? 1 : 0.6 * (1 - j / 12)) * fo;
        c++;
      }
    }
    PD.g.setDrawRange(0, c);
    for (const n of ['position', 'aColor', 'aSize', 'aAlpha']) PD.g.attributes[n].needsUpdate = true;
    PD.m.uniforms.uScale.value = this.pxScale;

    // synapses: Self ↔ everyone + a loose ring
    const list = [...this.agents.values()], ring = list.filter((a) => a.id !== 'self'), self = this.agents.get('self');
    let si = 0;
    const appearAll = clamp((this.assemble - 0.55) / 0.45, 0, 1);
    const pushLine = (p, q, c1, c2) => { if (si >= 40) return; this.synP.set([...p, ...q], si * 6); this.synC.set([...c1, ...c2], si * 6); si++; };
    if (self) {
      ring.forEach((a, i) => {
        const kk = (0.08 + 0.5 * Math.min(1, a.act) + 0.2 * a.speak) * appearAll * a.birth * (1 - 0.5 * this.sleep);
        const col = new THREE.Color(a.color);
        pushLine(this.posOf('self'), this.posOf(a.id), [0.8 * kk, 0.9 * kk, kk], [col.r * kk, col.g * kk, col.b * kk]);
        const nb = ring[(i + 1) % ring.length];
        if (nb && ring.length > 2) { const k2 = 0.05 * appearAll; pushLine(this.posOf(a.id), this.posOf(nb.id), [col.r * k2, col.g * k2, col.b * k2], [col.r * k2, col.g * k2, col.b * k2]); }
      });
    }
    this.synG.setDrawRange(0, si * 2);
    this.synG.attributes.position.needsUpdate = true; this.synG.attributes.color.needsUpdate = true;

    // shock waves
    for (const w of this.wavePool) {
      if (!w.visible) continue;
      w.userData.t += dt / 1.1;
      if (w.userData.t >= 1) { w.visible = false; continue; }
      const a = this.agents.get(w.userData.id); if (!a) { w.visible = false; continue; }
      const staged2 = a.mode === 'stage' && a.morph > 0.5;
      w.position.copy(staged2 ? a.formCenter : this.toWorld(this.posOf(a.id)));
      const s = (staged2 ? 0.3 : 0.04) + ease(w.userData.t) * (staged2 ? 0.9 : 0.35);
      w.scale.setScalar(s); w.quaternion.copy(this.camera.quaternion);
      w.material.opacity = (1 - w.userData.t) * 0.8;
    }

    this.updateLabels(dt, staged, stageAmt);
  }

  updateLabels(dt, staged, stageAmt) {
    const zh = document.documentElement.lang === 'zh';
    const appear = clamp((this.assemble - 0.55) / 0.45, 0, 1);
    for (const a of this.agents.values()) {
      const v = this.toWorld(this.posOf(a.id)), s = this.toScreen(v);
      const depth = clamp((v.z - this.camTarget.z + 1) / 2, 0, 1);
      const hide = a.mode === 'stage' && a.morph > 0.3;
      const op = hide ? 0 : appear * (0.35 + 0.5 * depth + 0.35 * a.speak) * (1 - 0.5 * this.sleep) * (staged && staged !== a ? 1 - 0.6 * stageAmt : 1) * (a.birth < 1 ? a.birth : 1);
      const name = a.name[zh ? 'zh' : 'en'];
      const txt = (zh ? name : name.toUpperCase()) + ' ' + a.glyph;
      if (a.label.textContent !== txt) a.label.textContent = txt;
      a.label.style.transform = `translate(${s.x}px, ${s.y + this.pxRadius(v, 0.06) * 1.6 + 6}px) translate(-50%, 0)`;
      a.label.style.opacity = op.toFixed(3);
    }
    if (staged && stageAmt > 0.4) {
      const c = this.toScreen(staged.formCenter), r = this.pxRadius(staged.formCenter, staged.formScale);
      const html = `<b>${staged.glyph} ${staged.name[zh ? 'zh' : 'en']}</b><span>${formName(staged, zh ? 'zh' : 'en')}</span>`;
      if (this.stageLabel.innerHTML !== html) this.stageLabel.innerHTML = html;
      this.stageLabel.style.setProperty('--c', staged.color);
      this.stageLabel.style.transform = `translate(${c.x}px, ${c.y + r * 1.05}px) translate(-50%, 0)`;
      this.stageLabel.style.opacity = clamp((stageAmt - 0.4) / 0.4, 0, 1).toFixed(3);
    } else this.stageLabel.style.opacity = '0';
    // sleep z's
    for (const z of this.zs) {
      z.t += dt / 2.6;
      if (!z.el) { z.el = document.createElement('i'); z.el.className = 'zz'; z.el.textContent = 'z'; this.labelLayer.append(z.el); }
      const a = this.agents.get(z.id); if (!a) { z.t = 1; continue; }
      const s = this.toScreen(this.toWorld(this.posOf(z.id)));
      z.el.style.transform = `translate(${s.x + z.x + z.t * 14}px, ${s.y - 14 - z.t * 46}px) scale(${1 + z.t * 0.8})`;
      z.el.style.opacity = (Math.sin(z.t * Math.PI) * 0.7).toFixed(3);
    }
    this.zs = this.zs.filter((z) => { if (z.t >= 1) { z.el?.remove(); return false; } return true; });
  }

  draw() { this.composer.render(); }
}

// Orbit interaction shared by both renderers: drag to rotate (with inertia), wheel to zoom,
// double-click to reset. The head holds still while the pointer rests on a voice, and only drifts
// back to its resting three-quarter view after a few seconds of no interaction.
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class OrbitControl {
  constructor(el, { home = 0.72, pitch = -0.06, onMove } = {}) {
    this.el = el; this.home = home; this.homePitch = pitch;
    this.yawGoal = home; this.pitchGoal = pitch; this.spin = 0;
    this.zoom = 1; this.zoomGoal = 1;
    this.drag = null; this.justDragged = false;
    this.now = 0; this.lastInteract = -1e9;
    el.style.touchAction = 'none';

    el.addEventListener('pointerdown', (e) => {
      if (e.button) return; // primary button / touch / pen only
      this.drag = { x: e.clientX, y: e.clientY, moved: 0, id: e.pointerId, t: performance.now() };
      this.spin = 0; this.justDragged = false; this.lastInteract = this.now;
      try { el.setPointerCapture(e.pointerId); } catch {}
    });
    el.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (d && e.pointerId === d.id) {
        const now = performance.now(), dx = e.clientX - d.x, dy = e.clientY - d.y;
        const dtm = Math.max(8, now - d.t);
        d.x = e.clientX; d.y = e.clientY; d.t = now; d.moved += Math.abs(dx) + Math.abs(dy);
        const k = 0.0065; // radians per pixel
        this.yawGoal += dx * k;
        this.pitchGoal = clamp(this.pitchGoal + dy * k * 0.6, -0.6, 0.5);
        this.spin = clamp(this.spin * 0.5 + ((dx * k) / dtm) * 1000 * 0.5, -3.5, 3.5); // rad/s, for the fling
        this.lastInteract = this.now;
        if (d.moved > 4) el.style.cursor = 'grabbing';
      }
      onMove?.(e, !!(d && d.moved > 4));
    });
    const end = (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      this.justDragged = d.moved > 6;
      // a fling keeps spinning; letting go after holding still doesn't
      if (!this.justDragged || performance.now() - d.t > 90) this.spin = 0;
      this.drag = null; this.lastInteract = this.now;
      el.style.cursor = 'grab';
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomGoal = clamp(this.zoomGoal * Math.exp(e.deltaY * 0.0012), 0.55, 1.7);
      this.lastInteract = this.now;
    }, { passive: false });
    el.addEventListener('dblclick', () => this.reset());
  }

  reset() {
    this.spin = 0; this.zoomGoal = 1; this.pitchGoal = this.homePitch;
    this.yawGoal = this.home + Math.round((this.yawGoal - this.home) / TAU) * TAU;
  }
  // after something else (a lab's camera move) took over, continue from where the head is now
  sync(yaw, pitch) { this.yawGoal = yaw; this.pitchGoal = pitch; this.spin = 0; this.lastInteract = this.now; }
  consumeDrag() { const j = this.justDragged; this.justDragged = false; return j; }

  update(dt, { hovering = false, sleep = 0 } = {}) {
    this.now += dt;
    if (!this.drag && this.spin) {
      this.yawGoal += this.spin * dt;
      this.spin *= Math.exp(-dt * 3);
      if (Math.abs(this.spin) < 0.01) this.spin = 0;
    }
    // idle: drift back to a gently swaying three-quarter view (never while you're pointing at a voice)
    if (!this.drag && !hovering && !this.spin && this.now - this.lastInteract > 6) {
      const home = this.home + Math.sin(this.now * 0.17) * 0.3 * (1 - 0.6 * sleep);
      const near = home + Math.round((this.yawGoal - home) / TAU) * TAU;
      this.yawGoal += (near - this.yawGoal) * Math.min(1, dt * 0.35);
      this.pitchGoal += (this.homePitch + 0.1 * sleep - this.pitchGoal) * Math.min(1, dt * 0.35);
    }
    this.zoom += (this.zoomGoal - this.zoom) * Math.min(1, dt * 5);
  }
}

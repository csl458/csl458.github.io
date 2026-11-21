// Pure geometry for the wireframe head. No DOM — also used by the README SVG generator.

const g = (v, s) => Math.exp(-(v / s) * (v / s));

// Deform a unit-sphere direction into a stylised human head (facing +z, up +y).
export function headPoint(dx, dy, dz) {
  let x = dx * 0.74, y = dy, z = dz * 0.86;

  // fuller cranium at the back/top
  if (z < 0) z *= 1.1 + 0.08 * Math.max(0, dy);
  if (y > 0.2) { x *= 1 + 0.04 * (y - 0.2); }

  // jaw + chin taper
  if (y < -0.12) {
    const t = Math.min(1, (-y - 0.12) / 0.88);
    x *= 1 - 0.46 * t * t;
    z *= z < 0 ? 1 - 0.6 * t : 1 - 0.1 * t;
  }

  if (z > 0) {
    const ax = Math.abs(x);
    // nose: a ridge that grows towards the tip
    const noseY = y + 0.06;
    const ridge = g(x, 0.07 + 0.03 * Math.max(0, -noseY)) * g(noseY, 0.2) * (0.6 + 0.6 * Math.max(0, -noseY + 0.1));
    z += 0.26 * ridge;
    // eye sockets
    z -= 0.075 * g(ax - 0.26, 0.11) * g(y - 0.1, 0.07);
    // brow
    z += 0.045 * g(y - 0.22, 0.06) * g(x, 0.42);
    // lips
    z += 0.05 * g(x, 0.15) * g(y + 0.47, 0.05);
    z -= 0.025 * g(x, 0.2) * g(y + 0.55, 0.03);
    // chin
    z += 0.06 * g(x, 0.2) * g(y + 0.74, 0.1);
    // cheekbones
    x += Math.sign(x) * 0.03 * g(y + 0.05, 0.12) * g(z - 0.55, 0.2);
  }
  // ears
  const ear = g(z + 0.06, 0.11) * g(y - 0.02, 0.17);
  x += Math.sign(x || 1) * 0.08 * ear;

  return [x, y, z];
}

export function buildHead({ lat = 36, seg = 120, neck = true } = {}) {
  const rings = [];
  for (let i = 1; i < lat; i++) {
    const phi = (i / lat) * Math.PI;
    const ring = [];
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      ring.push(headPoint(Math.sin(phi) * Math.sin(th), Math.cos(phi), Math.sin(phi) * Math.cos(th)));
    }
    rings.push({ pts: ring, y: Math.cos(phi), closed: true, fade: 1 });
  }
  if (neck) {
    for (let k = 0; k < 9; k++) {
      const y = -0.72 - k * 0.085;
      const ring = [];
      for (let j = 0; j < seg; j++) {
        const th = (j / seg) * Math.PI * 2;
        const flare = 1 + Math.max(0, k - 5) * 0.12;
        ring.push([Math.sin(th) * 0.3 * flare, y, Math.cos(th) * 0.3 * flare - 0.14]);
      }
      rings.push({ pts: ring, y, closed: true, fade: Math.max(0.08, 1 - k / 9), neck: true });
    }
  }
  return { rings, lat, seg };
}

// Anchor points used by animations
export const ANCHORS = {
  earR: [0.8, 0.02, -0.06],
  earL: [-0.8, 0.02, -0.06],
  mouth: [0, -0.47, 0.86],
  outside: [2.6, 0.35, 0.9],
  front: [0, -0.9, 2.2],
};

// Camera: yaw around y, pitch around x, perspective onto screen.
export function makeProjector({ yaw = 0, pitch = 0, dist = 3.4, scale = 200, cx = 0, cy = 0 }) {
  const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  return (p) => {
    const x = p[0] * cyw + p[2] * syw;
    const z0 = -p[0] * syw + p[2] * cyw;
    const y = p[1] * cp - z0 * sp;
    const z = p[1] * sp + z0 * cp;
    const s = dist / (dist - z);
    return { x: cx + x * s * scale, y: cy - y * s * scale, z, s };
  };
}

export function bezier3(a, b, c, t) {
  const u = 1 - t;
  return [
    u * u * a[0] + 2 * u * t * b[0] + t * t * c[0],
    u * u * a[1] + 2 * u * t * b[1] + t * t * c[1],
    u * u * a[2] + 2 * u * t * b[2] + t * t * c[2],
  ];
}

export function arcControl(a, c, lift = 0.22) {
  const m = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
  return [m[0] * 0.8, m[1] + lift, m[2] * 0.8];
}

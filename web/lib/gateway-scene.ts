// The 3D scene at the top of the homepage (components/gateway-scene.tsx).
//
// Old-style requests ({"customerId": …}) travel along a gold thread from an app still on version 1
// to API version 2. With Mender on, they pass through its ring and come out as version 2
// requests ({"accountId": …}) that the API accepts with 200. With Mender off, the API turns them
// away with 422 and they fall back. Moving the pointer tilts the scene, hovering a request says
// what it carries, and clicking the ring switches Mender on or off. A real call sent from the
// page joins the stream, marked in gold, with the status the API really answered.
//
// three.js is passed in, so it is only downloaded by browsers that show the scene.
import type * as Three from 'three';
import type { RoundedBoxGeometry as RoundedBoxType } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

type ThreeModule = typeof Three;
type RoundedBox = typeof RoundedBoxType;

export type Shot = { id: number; status: number; ms: number; throughMender: boolean };
export type SceneControls = { fire(shot: Shot): void; refresh(): void; dispose(): void };
export type SceneElements = { host: HTMLElement; canvas: HTMLCanvasElement; tip: HTMLElement; labels: { app: HTMLElement; ring: HTMLElement; api: HTMLElement } };
export type SceneHooks = { mender(): boolean; toggle(): void; still: boolean };

// White thread and ring on the black page; green for calls that work, red for ones that break.
const COLOR = { thread: 0xf2f4f8, threadOff: 0x3a3f48, old: 0x262a33, pass: 0x35e08f, fail: 0xff5f57, app: 0x3a404c, api: 0xf2f3f5, lamp: 0x3a3f48 };
const OLD_JSON = '{"customerId":"acct_1"}';
const NEW_JSON = '{"accountId":"acct_1"}';
const OLD_FACE = '{ customerId }';
const NEW_FACE = '{ accountId }';
const RING_AT = 0.5;
const SPEED = 0.08;
const EVERY = 2.6;

type Packet = {
  group: Three.Group;
  body: Three.Mesh<Three.BufferGeometry, Three.MeshStandardMaterial>;
  face: Three.Mesh<Three.PlaneGeometry, Three.MeshBasicMaterial>;
  u: number;
  state: 'idle' | 'travel' | 'translated' | 'arriving' | 'rejected';
  t: number;
  fall: Three.Vector3;
  real: Shot | null;
};

type Badge = { sprite: Three.Sprite; t: number; base: Three.Vector3 };

// Text drawn on a canvas, for the faces of requests and the status badges.
function textTexture(THREE: ThreeModule, text: string, { width = 760, height = 200, size = 44, color = '#ffffff', fill = '' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  if (fill) {
    g.fillStyle = fill;
    g.beginPath();
    g.roundRect(4, 4, width - 8, height - 8, height / 2 - 4);
    g.fill();
  }
  g.font = `500 ${size}px "Martian Mono", ui-monospace, Menlo, monospace`;
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, width / 2, height / 2 + 2, width - 48);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export async function buildScene(THREE: ThreeModule, RoundedBoxGeometry: RoundedBox, el: SceneElements, hooks: SceneHooks): Promise<SceneControls> {
  // The request faces are drawn once; wait (briefly) for their typeface.
  await Promise.race([document.fonts.load('500 44px "Martian Mono"'), new Promise((resolve) => setTimeout(resolve, 1500))]).catch(() => {});

  const narrow = el.host.clientWidth < 700;
  const renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, narrow ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x0a0b0d, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.1);
  sun.position.set(3, 6, 9);
  scene.add(sun);
  const world = new THREE.Group();
  scene.add(world);

  // The thread: from the app on the left to the API on the right, through the ring.
  const spread = narrow ? 0.58 : 1;
  const path = new THREE.CatmullRomCurve3([[-7, -0.55, 0], [-3.6, 0.45, 0.5], [0, 0, 0], [3.4, -0.35, -0.3], [6.4, 0.15, 0]].map(([x, y, z]) => new THREE.Vector3(x * spread, y, z)));
  const start = path.getPointAt(0);
  const end = path.getPointAt(1);
  const ringPoint = path.getPointAt(RING_AT);

  const STITCHES = narrow ? 40 : 72;
  const stitchMaterial = new THREE.MeshStandardMaterial({ color: COLOR.thread, roughness: 0.55, metalness: 0.1 });
  const stitches = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.042, 0.11, 4, 8), stitchMaterial, STITCHES);
  world.add(stitches);
  const up = new THREE.Vector3(0, 1, 0);
  const placeholder = new THREE.Object3D();
  function layStitches(shift: number) {
    for (let i = 0; i < STITCHES; i += 1) {
      const u = (((i + shift) / STITCHES) % 1 + 1) % 1;
      placeholder.position.copy(path.getPointAt(u));
      placeholder.quaternion.setFromUnitVectors(up, path.getTangentAt(u));
      placeholder.updateMatrix();
      stitches.setMatrixAt(i, placeholder.matrix);
    }
    stitches.instanceMatrix.needsUpdate = true;
  }

  // The app on version 1: a small stack of screens.
  const app = new THREE.Group();
  for (let i = 0; i < 3; i += 1) {
    const screen = new THREE.Mesh(new RoundedBoxGeometry(1.25, 1.6, 0.07, 3, 0.06), new THREE.MeshStandardMaterial({ color: COLOR.app, roughness: 0.6 }));
    screen.position.set(-i * 0.16, i * 0.12, -i * 0.32);
    app.add(screen);
  }
  app.position.set(start.x - 1.05, start.y + 0.15, start.z);
  app.rotation.y = 0.5;
  world.add(app);

  // API version 2, with a lamp that shows its last answer.
  const api = new THREE.Group();
  api.add(new THREE.Mesh(new RoundedBoxGeometry(1.35, 2.15, 1.1, 4, 0.14), new THREE.MeshStandardMaterial({ color: COLOR.api, roughness: 0.45 })));
  const lampMaterial = new THREE.MeshStandardMaterial({ color: COLOR.lamp, emissive: COLOR.lamp, emissiveIntensity: 0.2 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 24, 16), lampMaterial);
  lamp.position.set(0, 0.7, 0.56);
  api.add(lamp);
  api.position.set(end.x + 1, end.y + 0.1, end.z);
  api.rotation.y = -0.45;
  world.add(api);
  let lampGlow = 0;

  // Mender's ring.
  const ringMaterial = new THREE.MeshStandardMaterial({ color: COLOR.thread, metalness: 0.2, roughness: 0.35, emissive: COLOR.thread, emissiveIntensity: 0.25, transparent: true });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.11, 24, 96), ringMaterial);
  ring.position.copy(ringPoint);
  ring.rotation.y = Math.PI / 2 - 0.6;
  world.add(ring);
  // Mender's label stays where the ring belongs, whether the ring is there or not.
  const ringPlace = new THREE.Object3D();
  ringPlace.position.copy(ringPoint);
  world.add(ringPlace);
  let ringOn = hooks.mender() ? 1 : 0;
  let ringPulse = 0;

  // Requests.
  const oldFace = textTexture(THREE, OLD_FACE, { size: 64 });
  const newFace = textTexture(THREE, NEW_FACE, { size: 64, color: '#06130c' });
  const bodyShape = new RoundedBoxGeometry(1.86, 0.62, 0.14, 3, 0.07);
  const faceShape = new THREE.PlaneGeometry(1.74, 0.46);
  const packets: Packet[] = Array.from({ length: 10 }, () => {
    const body = new THREE.Mesh(bodyShape, new THREE.MeshStandardMaterial({ color: COLOR.old, roughness: 0.5, transparent: true }));
    const face = new THREE.Mesh(faceShape, new THREE.MeshBasicMaterial({ map: oldFace, transparent: true }));
    face.position.z = 0.072;
    const group = new THREE.Group();
    group.add(body, face);
    group.visible = false;
    world.add(group);
    return { group, body, face, u: 0, state: 'idle' as const, t: 0, fall: new THREE.Vector3(), real: null };
  });

  // Status badges that rise from the API.
  const badgeTextures = new Map<string, Three.CanvasTexture>();
  const badgeTexture = (status: number) => {
    const key = String(status);
    if (!badgeTextures.has(key)) badgeTextures.set(key, textTexture(THREE, key, { width: 300, height: 130, size: 64, color: status < 400 ? '#06130c' : '#ffffff', fill: status < 400 ? '#35e08f' : '#ff5f57' }));
    return badgeTextures.get(key)!;
  };
  const badges: Badge[] = [];
  function showBadge(status: number) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTexture(status), transparent: true, depthTest: false }));
    sprite.scale.set(0.95, 0.41, 1);
    const base = api.position.clone().add(new THREE.Vector3(0, 1.55, 0));
    sprite.position.copy(base);
    world.add(sprite);
    badges.push({ sprite, t: 0, base });
    if (badges.length > 4) dropBadge(badges[0]);
  }
  function dropBadge(badge: Badge) {
    world.remove(badge.sprite);
    badge.sprite.material.dispose();
    badges.splice(badges.indexOf(badge), 1);
  }

  function launch(real: Shot | null) {
    const packet = packets.find((p) => p.state === 'idle');
    if (!packet) return null;
    Object.assign(packet, { u: 0, t: 0, state: 'travel', real });
    packet.face.material.map = oldFace;
    packet.body.material.color.setHex(COLOR.old);
    packet.body.material.emissive.setHex(real ? COLOR.thread : 0x000000);
    packet.body.material.emissiveIntensity = real ? 0.55 : 0;
    packet.body.material.opacity = 1;
    packet.face.material.opacity = 1;
    packet.group.scale.setScalar(real ? 1.18 : 1);
    packet.group.visible = true;
    return packet;
  }

  function land(packet: Packet) {
    lampGlow = 1;
    const status = packet.real?.status ?? (packet.state === 'translated' ? 200 : 422);
    lampMaterial.color.setHex(status < 400 ? COLOR.pass : COLOR.fail);
    lampMaterial.emissive.setHex(status < 400 ? COLOR.pass : COLOR.fail);
    showBadge(status);
    if (status < 400) packet.state = 'arriving';
    else {
      packet.state = 'rejected';
      packet.body.material.color.setHex(COLOR.fail);
      packet.fall.set(-1.6, 1.4, 0.6);
    }
    packet.t = 0;
  }

  // What a request will do at the ring: a real call already knows what happened to it.
  const translates = (packet: Packet) => (packet.real ? packet.real.throughMender && packet.real.status < 400 : hooks.mender());

  function translate(packet: Packet) {
    packet.state = 'translated';
    packet.face.material.map = newFace;
    packet.body.material.color.setHex(COLOR.pass);
    ringPulse = 1;
  }

  // ---------- pointer: tilt, hover, click ----------
  const pointer = new THREE.Vector2(2, 2);
  const tilt = { x: 0, y: 0 };
  const raycaster = new THREE.Raycaster();
  let hovered: 'ring' | Packet | null = null;

  function onMove(event: PointerEvent) {
    tilt.x = (event.clientX / window.innerWidth) * 2 - 1;
    tilt.y = (event.clientY / window.innerHeight) * 2 - 1;
    el.host.style.setProperty('--lean-x', tilt.x.toFixed(3));
    el.host.style.setProperty('--lean-y', tilt.y.toFixed(3));
    const box = el.canvas.getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    pointer.set(inside ? ((event.clientX - box.left) / box.width) * 2 - 1 : 2, inside ? -((event.clientY - box.top) / box.height) * 2 + 1 : 2);
    pick(inside ? event.clientX - box.left : 0, inside ? event.clientY - box.top : 0);
  }

  function describe(target: 'ring' | Packet): [string, string] {
    if (target === 'ring') return [hooks.mender() ? 'Mender is on' : 'Mender is off', hooks.mender() ? 'Click the ring to switch it off and watch old requests fail.' : 'Click the ring to switch it back on.'];
    const real = target.real ? `Your real call: API v2 answered ${target.real.status} in ${target.real.ms} ms. ` : '';
    if (target.state === 'translated' || target.state === 'arriving') return [`${real}Translated by Mender`, `${NEW_JSON.replace('}', ',"amountCents":2500}')} is a valid version 2 request.`];
    if (target.state === 'rejected') return [`${real}Refused with 422`, 'API v2 requires accountId, and this request still sends customerId.'];
    return [`${real}Old request from an app on version 1`, `${OLD_JSON.replace('}', ',"amountCents":2500}')} ${translates(target) ? 'Mender will rename customerId to accountId.' : 'Mender is off, so API v2 will refuse it.'}`];
  }

  function pick(x: number, y: number) {
    let next: typeof hovered = null;
    if (pointer.x <= 1) {
      raycaster.setFromCamera(pointer, camera);
      const live = packets.filter((p) => p.state !== 'idle').map((p) => p.body);
      const hit = raycaster.intersectObjects([ring, ...live], false)[0];
      if (hit) next = hit.object === ring ? 'ring' : packets.find((p) => p.body === hit.object) ?? null;
    }
    hovered = next;
    el.canvas.style.cursor = hovered === 'ring' ? 'pointer' : 'default';
    if (!hovered) { el.tip.hidden = true; return; }
    const [title, detail] = describe(hovered);
    (el.tip.firstElementChild as HTMLElement).textContent = title;
    (el.tip.lastElementChild as HTMLElement).textContent = detail;
    el.tip.hidden = false;
    const flip = x > el.host.clientWidth - 320;
    el.tip.style.transform = `translate(${flip ? x - 316 : x + 16}px, ${y + 16}px)`;
  }

  function onClick() {
    if (hovered === 'ring') hooks.toggle();
  }

  // ---------- size, labels ----------
  const projected = new THREE.Vector3();
  // Labels sit above (lift > 0) or below (lift < 0) their object, and never past the edges.
  function placeLabel(label: HTMLElement, object: Three.Object3D, lift: number) {
    object.getWorldPosition(projected);
    projected.y += lift;
    projected.project(camera);
    const half = label.offsetWidth / 2 + 8;
    const x = Math.min(Math.max((projected.x * 0.5 + 0.5) * el.canvas.clientWidth, half), el.canvas.clientWidth - half);
    const y = (-projected.y * 0.5 + 0.5) * el.canvas.clientHeight;
    label.style.transform = `translate(-50%, ${lift > 0 ? '-100%' : '0'}) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  function resize() {
    const width = el.canvas.clientWidth;
    const height = el.canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const span = 13.4 * spread + (narrow ? 4.4 : 6.4);
    const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const distance = Math.max(span / (2 * half * camera.aspect), 5.6 / (2 * half), 9);
    camera.position.set(0, 1.3, distance);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    if (hooks.still) refresh();
  }

  function draw() {
    renderer.render(scene, camera);
    placeLabel(el.labels.app, app, -1.15);
    placeLabel(el.labels.ring, ringPlace, 1.35);
    placeLabel(el.labels.api, api, -1.35);
  }

  // ---------- motion ----------
  let shift = 0;
  let spawnIn = 0;
  let elapsed = 0;
  const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);
  const offColor = new THREE.Color(COLOR.threadOff);
  const onColor = new THREE.Color(COLOR.thread);

  function step(dt: number) {
    const on = hooks.mender();
    elapsed += dt;
    ringOn += ((on ? 1 : 0) - ringOn) * ease(dt, 5);
    ringPulse = Math.max(0, ringPulse - dt * 2.5);
    ring.position.set(ringPoint.x, ringPoint.y - (1 - ringOn) * 2.4, ringPoint.z);
    ring.rotation.y = Math.PI / 2 - 0.6 + Math.sin(elapsed * 0.8) * 0.12;
    ring.scale.setScalar(1 + ringPulse * 0.12);
    ringMaterial.opacity = 0.25 + ringOn * 0.75;
    ringMaterial.emissiveIntensity = 0.25 + ringPulse * 1.2;
    stitchMaterial.color.copy(offColor).lerp(onColor, ringOn);

    shift = (shift + dt * STITCHES * SPEED * 0.5) % STITCHES;
    layStitches(shift);

    world.rotation.y += (tilt.x * 0.3 - world.rotation.y) * ease(dt, 3);
    world.rotation.x += (tilt.y * 0.1 - world.rotation.x) * ease(dt, 3);

    lampGlow = Math.max(0, lampGlow - dt * 0.9);
    lampMaterial.emissiveIntensity = 0.2 + lampGlow * 1.6;

    spawnIn -= dt;
    if (spawnIn <= 0) { launch(null); spawnIn = EVERY; }

    for (const packet of packets) {
      if (packet.state === 'idle') continue;
      packet.t += dt;
      if (packet.state === 'travel' || packet.state === 'translated') {
        packet.u = Math.min(1, packet.u + SPEED * dt);
        packet.group.position.copy(path.getPointAt(packet.u));
        packet.group.position.y += Math.sin(packet.t * 2.2 + packet.u * 9) * 0.05;
        if (packet.state === 'travel' && packet.u >= RING_AT && translates(packet)) translate(packet);
        if (packet.u >= 0.985) land(packet);
      } else if (packet.state === 'arriving') {
        const k = Math.min(1, packet.t / 0.35);
        packet.group.position.lerp(api.position, ease(dt, 10));
        packet.group.scale.setScalar((packet.real ? 1.18 : 1) * (1 - k));
        if (k >= 1) retire(packet);
      } else if (packet.state === 'rejected') {
        packet.fall.y -= 4.2 * dt;
        packet.group.position.addScaledVector(packet.fall, dt);
        packet.group.rotation.z += dt * 2.2;
        const fade = Math.max(0, 1 - packet.t / 1.3);
        packet.body.material.opacity = fade;
        packet.face.material.opacity = fade;
        if (fade <= 0) retire(packet);
      }
    }

    for (const badge of [...badges]) {
      badge.t += dt;
      badge.sprite.position.set(badge.base.x, badge.base.y + badge.t * 0.45, badge.base.z);
      badge.sprite.material.opacity = Math.max(0, 1 - Math.max(0, badge.t - 0.6) / 1.1);
      if (badge.t > 1.7) dropBadge(badge);
    }
  }

  function retire(packet: Packet) {
    packet.state = 'idle';
    packet.group.visible = false;
    packet.group.rotation.set(0, 0, 0);
    if (hovered === packet) { hovered = null; el.tip.hidden = true; }
  }

  // With reduced motion: one still picture of the same story, redrawn when something changes.
  function refresh(shot: Shot | null = null) {
    if (!hooks.still) return;
    const on = hooks.mender();
    for (const packet of packets) retire(packet);
    for (const badge of [...badges]) dropBadge(badge);
    ringOn = on ? 1 : 0;
    ring.position.set(ringPoint.x, ringPoint.y - (1 - ringOn) * 2.4, ringPoint.z);
    ringMaterial.opacity = 0.25 + ringOn * 0.75;
    stitchMaterial.color.copy(offColor).lerp(onColor, ringOn);
    layStitches(0);
    const place = (u: number, real: Shot | null = null) => {
      const packet = launch(real)!;
      packet.u = u;
      packet.group.position.copy(path.getPointAt(u));
      if (u > RING_AT && translates(packet)) translate(packet);
      return packet;
    };
    place(0.2);
    place(0.68);
    const last = place(0.92, shot);
    const status = shot?.status ?? (last.state === 'translated' ? 200 : 422);
    if (status >= 400) last.body.material.color.setHex(COLOR.fail);
    lampMaterial.color.setHex(status < 400 ? COLOR.pass : COLOR.fail);
    lampMaterial.emissive.setHex(status < 400 ? COLOR.pass : COLOR.fail);
    lampMaterial.emissiveIntensity = 1;
    showBadge(status);
    draw();
  }

  // ---------- run only while visible ----------
  let frame = 0;
  let last = 0;
  let visible = true;
  function loop(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    step(dt);
    if (hovered && hovered !== 'ring' && hovered.state === 'idle') { hovered = null; el.tip.hidden = true; }
    draw();
    frame = requestAnimationFrame(loop);
  }
  function play() {
    if (hooks.still || frame || !visible || document.hidden) return;
    last = performance.now();
    frame = requestAnimationFrame(loop);
  }
  function pause() {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  const seen = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) play(); else pause(); });
  seen.observe(el.host);
  const onVisibility = () => (document.hidden ? pause() : play());
  document.addEventListener('visibilitychange', onVisibility);
  const sized = new ResizeObserver(resize);
  sized.observe(el.canvas);
  window.addEventListener('pointermove', onMove, { passive: true });
  el.canvas.addEventListener('click', onClick);

  layStitches(0);
  resize();
  if (hooks.still) refresh();
  else {
    // Start with the thread already carrying a few requests.
    spawnIn = EVERY * 0.7;
    for (const u of [0.06, 0.3, 0.56, 0.8]) {
      const packet = launch(null)!;
      packet.u = u;
      if (u > RING_AT && translates(packet)) translate(packet);
    }
    // The first picture right away, before the first animation frame.
    step(0);
    draw();
    play();
  }

  return {
    fire(shot) {
      if (hooks.still) refresh(shot);
      else launch(shot);
    },
    refresh: () => refresh(),
    dispose() {
      pause();
      seen.disconnect();
      sized.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointermove', onMove);
      el.canvas.removeEventListener('click', onClick);
      scene.traverse((object) => {
        const mesh = object as Three.Mesh;
        mesh.geometry?.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const material of materials) material.dispose();
      });
      for (const texture of [oldFace, newFace, ...badgeTextures.values()]) texture.dispose();
      renderer.dispose();
    },
  };
}

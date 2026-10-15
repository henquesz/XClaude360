// Avatar 3D do menu: um boneco laranja com olhos brancos (cara de Claude) que acompanha o mouse.
// Construído só com primitivas do three.js, sem modelo externo.
import * as THREE from './vendor/three.module.min.js';

const ORANGE = 0xd97757;
const CREAM = 0xf7f3ec;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export function createAvatar(canvas) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch (err) {
    console.warn('Avatar: WebGL indisponível', err);
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  camera.position.set(0, 1.9, 8.4);
  camera.lookAt(0, 1.75, 0);

  // --- Luzes ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xffffff, 0x303030, 0.95));
  const key = new THREE.DirectionalLight(0xfff1e0, 2.3);
  key.position.set(-2.5, 6, 4.5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -2.5, right: 2.5, top: 4.5, bottom: -1, near: 1, far: 20 });
  key.shadow.radius = 4;
  key.shadow.bias = -0.0006;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9ecbff, 1.4);
  rim.position.set(3, 3.5, -4);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(3, 1, 4);
  scene.add(fill);

  // --- Materiais e helpers -------------------------------------------------
  const skin = new THREE.MeshStandardMaterial({ color: ORANGE, roughness: 0.55, metalness: 0 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: CREAM, roughness: 0.3, metalness: 0,
    emissive: 0x2a2520, emissiveIntensity: 0.6 });
  const mesh = (geo, mat = skin) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  // --- Corpo ----------------------------------------------------------------
  const root = new THREE.Group();
  scene.add(root);

  // Chão só para receber a sombra.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.38 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Pernas e pés
  for (const side of [-1, 1]) {
    const leg = mesh(new THREE.CapsuleGeometry(0.16, 0.62, 6, 20));
    leg.position.set(side * 0.21, 0.47, 0);
    root.add(leg);
    const foot = mesh(new THREE.SphereGeometry(0.2, 24, 16));
    foot.scale.set(1, 0.55, 1.5);
    foot.position.set(side * 0.22, 0.13, 0.12);
    root.add(foot);
  }

  // Tronco
  const torso = mesh(new THREE.CapsuleGeometry(0.44, 0.75, 8, 28));
  torso.position.set(0, 1.42, 0);
  torso.scale.set(1, 1, 0.82);
  root.add(torso);

  // Braços: grupo no ombro para poder girar
  const arms = {};
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.5, 1.95, 0);
    const upper = mesh(new THREE.CapsuleGeometry(0.13, 0.5, 6, 20));
    upper.position.set(0, -0.38, 0);
    const hand = mesh(new THREE.SphereGeometry(0.16, 24, 16));
    hand.position.set(0, -0.8, 0);
    shoulder.add(upper, hand);
    shoulder.rotation.z = side * 0.2;
    root.add(shoulder);
    arms[side] = shoulder;
  }

  // Pescoço e cabeça (grupo com pivô no pescoço)
  const neck = mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.22, 20));
  neck.position.set(0, 2.25, 0);
  root.add(neck);

  const head = new THREE.Group();
  head.position.set(0, 2.3, 0);
  root.add(head);
  const skull = mesh(new THREE.SphereGeometry(0.62, 40, 32));
  skull.scale.set(1, 1.06, 0.95);
  skull.position.set(0, 0.56, 0);
  head.add(skull);

  // Olhos: duas elipses brancas, sem pupila (estilo Claude)
  const eyes = new THREE.Group();
  eyes.position.set(0, 0.6, 0.53);
  head.add(eyes);
  const eyeList = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 16), eyeMat);
    eye.scale.set(1, 1.7, 0.45);
    eye.position.set(side * 0.22, 0, 0);
    eye.rotation.y = side * 0.25; // acompanha a curvatura da cabeça
    eyes.add(eye);
    eyeList.push(eye);
  }

  // --- Estado de animação ---------------------------------------------------
  const target = { x: 0, y: 0 };   // onde o mouse está, normalizado [-1, 1]
  const look = { x: 0, y: 0 };     // valor suavizado
  let lastPointer = performance.now();
  let nextIdleLook = 0;
  let nextBlink = performance.now() + 2500;
  let blinkStart = -1;
  let waveStart = -1;
  let stopped = false;
  let raf = 0;
  let prev = performance.now();

  function onPointerMove(event) {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.42; // altura aproximada dos olhos na tela
    target.x = clamp((event.clientX - cx) / (window.innerWidth * 0.5), -1, 1);
    target.y = clamp((event.clientY - cy) / (window.innerHeight * 0.5), -1, 1);
    lastPointer = performance.now();
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true });

  function wave() {
    waveStart = performance.now();
  }
  canvas.addEventListener('click', wave);

  function resize() {
    const parent = canvas.parentElement || canvas;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement || canvas);
  resize();

  function frame(now) {
    if (stopped) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    const t = now / 1000;

    // Sem mouse por um tempo: olha para pontos aleatórios, devagar.
    if (now - lastPointer > 5000 && now > nextIdleLook) {
      target.x = (Math.random() * 2 - 1) * 0.6;
      target.y = (Math.random() * 2 - 1) * 0.3;
      nextIdleLook = now + 2000 + Math.random() * 3000;
    }

    look.x = damp(look.x, target.x, 7, dt);
    look.y = damp(look.y, target.y, 7, dt);

    // Cabeça gira mais, tronco um pouco, corpo inteiro bem pouco.
    head.rotation.y = look.x * 0.6;
    head.rotation.x = look.y * 0.38;
    head.rotation.z = -look.x * 0.06;
    torso.rotation.y = look.x * 0.18;
    root.rotation.y = look.x * 0.1;
    eyes.position.x = look.x * 0.045;
    eyes.position.y = 0.6 - look.y * 0.03;

    // Respiração e balanço discreto
    torso.scale.y = 1 + Math.sin(t * 2.0) * 0.012;
    head.position.y = 2.3 + Math.sin(t * 2.0) * 0.012;
    for (const side of [-1, 1]) {
      arms[side].rotation.x = Math.sin(t * 1.3 + side) * 0.05;
    }

    // Aceno com o braço direito (do boneco: +x)
    const waving = waveStart >= 0 && now - waveStart < 1800;
    const armZ = waving ? 2.55 + Math.sin((now - waveStart) / 1000 * 16) * 0.3 : 0.2;
    arms[1].rotation.z = damp(arms[1].rotation.z, armZ, waving ? 14 : 6, dt);
    if (!waving) waveStart = -1;

    // Piscada
    if (blinkStart < 0 && now > nextBlink) {
      blinkStart = now;
      nextBlink = now + 2500 + Math.random() * 4000;
    }
    let eyeScale = 1.7;
    if (blinkStart >= 0) {
      const p = (now - blinkStart) / 150;
      if (p >= 1) blinkStart = -1;
      else eyeScale = 1.7 * (1 - Math.sin(p * Math.PI) * 0.92);
    }
    for (const eye of eyeList) eye.scale.y = eyeScale;

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  return {
    wave,
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('click', wave);
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

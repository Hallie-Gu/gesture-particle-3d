(function () {
  "use strict";

  const THREE_VERSION = "0.160.0";
  const MEDIAPIPE_HANDS_VERSION = "0.4.1675469240";
  const HANDS_CDN_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${MEDIAPIPE_HANDS_VERSION}`;
  const DEFAULT_PARTICLE_COUNT = 3500;

  // 手掌移动旋转参数：只响应相邻检测帧的真实位移，静止时不会持续旋转。
  const HORIZONTAL_MOVEMENT_SENSITIVITY = 8.4;
  const VERTICAL_MOVEMENT_SENSITIVITY = 3.0;
  const PALM_MOVEMENT_DEAD_ZONE = 0.004;
  const MOVEMENT_DELTA_LERP = 0.68;
  const ROTATION_INCREMENT_LERP = 0.45;
  const MAX_VERTICAL_TILT = 0.72;
  const AUTO_ROTATION_SPEED = 0.12;

  // 双阈值迟滞：只产生完全展开或完全收拢两种粒子目标。
  const OPEN_GESTURE_THRESHOLD = 0.65;
  const CLOSE_GESTURE_THRESHOLD = 0.42;
  const EXPANSION_TRANSITION_DAMPING = 10;

  const HAND_DETECTION_FPS = 15;
  const HAND_DETECTION_INTERVAL_MS = 1000 / HAND_DETECTION_FPS;

  const state = {
    scene: null,
    camera: null,
    renderer: null,
    clock: null,
    particleRoot: null,
    particles: null,
    particleMaterial: null,
    basePositions: null,
    explosionDirections: null,
    explodedPositions: null,
    starField: null,
    hands: null,
    mediaStream: null,
    cameraLoopId: 0,
    cameraGeneration: 0,
    lastHandProcessAt: 0,
    cameraLoopActive: false,
    handProcessing: false,
    handVisible: false,
    lastHandSeenAt: 0,
    opennessSamples: [],
    rawOpen: 0,
    gestureExpanded: false,
    targetOpen: 0,
    smoothOpen: 0,
    previousPalmX: null,
    previousPalmY: null,
    smoothedDeltaX: 0,
    smoothedDeltaY: 0,
    pendingRotationY: 0,
    pendingRotationX: 0,
    lastOpennessUiAt: 0,
    currentPreset: "nebula",
    particleCount: DEFAULT_PARTICLE_COUNT,
    baseHue: 0.7,
    animationId: 0,
    resizeTimer: 0,
    initialized: false
  };

  const dom = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheDom();
    bindUiEvents();
    updateRangeProgress();

    if (window.__criticalLoadError) {
      showError(window.__criticalLoadError, false);
      return;
    }

    updateAccentColor(dom.colorPicker.value);

    if (!isSecureLocalContext()) {
      setStatus("摄像头或模型加载失败", "error");
      showError("必须通过 VS Code 的 Live Server 打开本页面，不能直接双击 index.html（file:// 无法安全调用摄像头）。", false);
      return;
    }

    if (typeof window.THREE === "undefined") {
      showError(`Three.js ${THREE_VERSION} 未能加载，请检查 CDN 网络连接后刷新页面。`, false);
      return;
    }

    try {
      initThreeScene();
      rebuildParticleGeometry(DEFAULT_PARTICLE_COUNT);
      createBackgroundStars();
      state.initialized = true;
      if (!document.hidden) animate();
    } catch (error) {
      console.error(error);
      showError(`3D 场景初始化失败：${friendlyError(error)}`, false);
      return;
    }

    if (typeof window.Hands === "undefined") {
      showError(`MediaPipe Hands ${MEDIAPIPE_HANDS_VERSION} 加载失败。粒子仍可自动旋转，请检查网络后刷新或重试。`, true);
      return;
    }

    await initializeHandTracking();
  }

  function cacheDom() {
    dom.canvas = document.getElementById("sceneCanvas");
    dom.statusBadge = document.getElementById("statusBadge");
    dom.statusText = document.getElementById("statusText");
    dom.opennessText = document.getElementById("opennessText");
    dom.colorPicker = document.getElementById("colorPicker");
    dom.colorValue = document.getElementById("colorValue");
    dom.densitySlider = document.getElementById("densitySlider");
    dom.densityValue = document.getElementById("densityValue");
    dom.fullscreenButton = document.getElementById("fullscreenButton");
    dom.fullscreenText = document.getElementById("fullscreenText");
    dom.cameraPanel = document.getElementById("cameraPanel");
    dom.cameraVideo = document.getElementById("cameraVideo");
    dom.cameraPlaceholder = document.getElementById("cameraPlaceholder");
    dom.messagePanel = document.getElementById("messagePanel");
    dom.messageText = document.getElementById("messageText");
    dom.retryCameraButton = document.getElementById("retryCameraButton");
    dom.closeMessageButton = document.getElementById("closeMessageButton");
  }

  function bindUiEvents() {
    document.querySelectorAll(".preset-button").forEach((button) => {
      button.addEventListener("click", () => switchPreset(button.dataset.preset, button));
    });

    dom.colorPicker.addEventListener("input", () => updateAccentColor(dom.colorPicker.value));

    dom.densitySlider.addEventListener("input", () => {
      dom.densityValue.textContent = Number(dom.densitySlider.value).toLocaleString("zh-CN");
      updateRangeProgress();
      window.clearTimeout(state.resizeTimer);
      state.resizeTimer = window.setTimeout(() => rebuildParticleGeometry(Number(dom.densitySlider.value)), 140);
    });

    dom.fullscreenButton.addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", syncFullscreenButton);
    dom.retryCameraButton.addEventListener("click", initializeHandTracking);
    dom.closeMessageButton.addEventListener("click", () => { dom.messagePanel.hidden = true; });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("resize", handleResize, { passive: true });
    window.addEventListener("beforeunload", disposeApp);
    setupCameraResizeHandles();
  }

  function isSecureLocalContext() {
    if (location.protocol === "https:") return true;
    return location.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  }

  function initThreeScene() {
    state.scene = new THREE.Scene();
    state.scene.fog = new THREE.FogExp2(0x050713, 0.022);

    state.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 180);
    state.camera.position.set(0, 0.2, 15.5);

    state.renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    state.renderer.setSize(window.innerWidth, window.innerHeight, false);
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    state.renderer.outputColorSpace = THREE.SRGBColorSpace;
    state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    state.renderer.toneMappingExposure = 1.1;

    state.clock = new THREE.Clock();
    state.particleRoot = new THREE.Group();
    state.particleRoot.position.x = window.innerWidth > 820 ? -0.55 : 0;
    state.scene.add(state.particleRoot);
  }

  function createParticleMaterial() {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uHue: { value: state.baseHue },
        uSpread: { value: 0.01 },
        uPointSize: { value: 3.05 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.75) }
      },
      vertexShader: `
        attribute float aHue;
        attribute float aSeed;
        uniform float uTime;
        uniform float uSpread;
        uniform float uPointSize;
        uniform float uPixelRatio;
        varying float vHue;
        varying float vAlpha;

        void main() {
          vec3 direction = normalize(position + vec3(0.0001));
          float pulse = sin(uTime * 1.7 + aSeed * 18.0) * 0.035;
          vec3 expanded = position + direction * uSpread * (0.35 + aSeed * 0.85) + direction * pulse;
          vec4 mvPosition = modelViewMatrix * vec4(expanded, 1.0);
          float perspective = clamp(24.0 / max(2.0, -mvPosition.z), 0.55, 2.2);
          gl_PointSize = uPointSize * uPixelRatio * perspective * (0.62 + aSeed * 0.86);
          gl_Position = projectionMatrix * mvPosition;
          vHue = aHue;
          vAlpha = 0.52 + aSeed * 0.48;
        }
      `,
      fragmentShader: `
        uniform float uHue;
        varying float vHue;
        varying float vAlpha;

        vec3 hsl2rgb(vec3 c) {
          vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
          return c.z + c.y * (rgb - 0.5) * (1.0 - abs(2.0 * c.z - 1.0));
        }

        void main() {
          vec2 p = gl_PointCoord - vec2(0.5);
          float d = length(p);
          if (d > 0.5) discard;
          float core = smoothstep(0.22, 0.0, d);
          float glow = smoothstep(0.5, 0.08, d);
          vec3 color = hsl2rgb(vec3(fract(uHue + vHue), 0.88, 0.62));
          color = mix(color, vec3(1.0), core * 0.82);
          float alpha = (glow * 0.42 + core * 0.46) * vAlpha;
          gl_FragColor = vec4(color, alpha);
        }
      `
    });
  }

  function rebuildParticleGeometry(count) {
    if (!state.particleRoot) return;

    const geometry = new THREE.BufferGeometry();
    const basePositions = generatePresetPositions(state.currentPreset, count);
    const explosionData = createExplosionData(basePositions, state.currentPreset, count);
    const positions = createInterpolatedPositions(basePositions, explosionData.explodedPositions, state.smoothOpen);
    const hues = new Float32Array(count);
    const seeds = new Float32Array(count);
    const random = mulberry32(count * 97 + 31);

    for (let i = 0; i < count; i += 1) {
      hues[i] = random() * 0.34 + (i % 7) * 0.012;
      seeds[i] = random();
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aHue", new THREE.BufferAttribute(hues, 1));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    geometry.computeBoundingSphere();

    if (!state.particleMaterial) state.particleMaterial = createParticleMaterial();
    const nextParticles = new THREE.Points(geometry, state.particleMaterial);
    nextParticles.frustumCulled = false;
    state.particleRoot.add(nextParticles);

    if (state.particles) {
      state.particleRoot.remove(state.particles);
      state.particles.geometry.dispose();
    }

    state.particles = nextParticles;
    state.basePositions = basePositions;
    state.explosionDirections = explosionData.explosionDirections;
    state.explodedPositions = explosionData.explodedPositions;
    state.particleCount = count;
  }

  function createExplosionData(basePositions, presetName, count) {
    const explosionDirections = new Float32Array(basePositions.length);
    const explodedPositions = new Float32Array(basePositions.length);
    const presetSeed = { nebula: 5101, fireworks: 6203, saturn: 7307, flower: 8419 }[presetName];
    const random = mulberry32(presetSeed + count * 13);
    let modelRadius = 0;

    for (let i = 0; i < basePositions.length; i += 3) {
      modelRadius = Math.max(modelRadius, Math.hypot(basePositions[i], basePositions[i + 1], basePositions[i + 2]));
    }
    modelRadius = Math.max(modelRadius, 1);

    for (let i = 0; i < basePositions.length; i += 3) {
      const bx = basePositions[i];
      const by = basePositions[i + 1];
      const bz = basePositions[i + 2];
      const baseLength = Math.hypot(bx, by, bz);

      const theta = random() * Math.PI * 2;
      const randomZ = random() * 2 - 1;
      const randomRadius = Math.sqrt(Math.max(0, 1 - randomZ * randomZ));
      const randomX = randomRadius * Math.cos(theta);
      const randomY = randomRadius * Math.sin(theta);

      const invBaseLength = baseLength > 0.0001 ? 1 / baseLength : 0;
      let directionX = bx * invBaseLength * 0.72 + randomX * 0.58;
      let directionY = by * invBaseLength * 0.72 + randomY * 0.58;
      let directionZ = bz * invBaseLength * 0.72 + randomZ * 0.58;
      let directionLength = Math.hypot(directionX, directionY, directionZ);

      if (directionLength < 0.0001) {
        directionX = randomX;
        directionY = randomY;
        directionZ = randomZ;
        directionLength = 1;
      }

      directionX /= directionLength;
      directionY /= directionLength;
      directionZ /= directionLength;

      // 每个粒子的爆发距离和偏移均预先生成，最大张开时达到原模型约 2.5～3.6 倍范围。
      const explosionDistance = modelRadius * (1.55 + random() * 1.05);
      const jitterScale = modelRadius * 0.18;
      const deltaX = directionX * explosionDistance + (random() - 0.5) * jitterScale;
      const deltaY = directionY * explosionDistance + (random() - 0.5) * jitterScale;
      const deltaZ = directionZ * explosionDistance + (random() - 0.5) * jitterScale;
      const deltaLength = Math.max(Math.hypot(deltaX, deltaY, deltaZ), 0.0001);

      explosionDirections[i] = deltaX / deltaLength;
      explosionDirections[i + 1] = deltaY / deltaLength;
      explosionDirections[i + 2] = deltaZ / deltaLength;
      explodedPositions[i] = bx + deltaX;
      explodedPositions[i + 1] = by + deltaY;
      explodedPositions[i + 2] = bz + deltaZ;
    }

    return { explosionDirections, explodedPositions };
  }

  function createInterpolatedPositions(basePositions, explodedPositions, openness) {
    const positions = new Float32Array(basePositions.length);
    for (let i = 0; i < positions.length; i += 1) {
      positions[i] = basePositions[i] + (explodedPositions[i] - basePositions[i]) * openness;
    }
    return positions;
  }

  function generatePresetPositions(name, count) {
    const generators = {
      nebula: generateNebula,
      fireworks: generateFireworks,
      saturn: generateSaturn,
      flower: generateFlower
    };
    return generators[name](count);
  }

  function generateNebula(count) {
    const result = new Float32Array(count * 3);
    const random = mulberry32(count + 1103);
    const arms = 5;

    for (let i = 0; i < count; i += 1) {
      const radius = Math.pow(random(), 0.58) * 5.1;
      const arm = i % arms;
      const angle = arm / arms * Math.PI * 2 + radius * 1.25 + gaussian(random) * 0.22;
      const thickness = (0.16 + radius * 0.055) * gaussian(random);
      result[i * 3] = Math.cos(angle) * radius + Math.cos(angle + Math.PI / 2) * thickness;
      result[i * 3 + 1] = Math.sin(angle) * radius + Math.sin(angle + Math.PI / 2) * thickness;
      result[i * 3 + 2] = gaussian(random) * (0.1 + radius * 0.045);
    }
    return result;
  }

  function generateFireworks(count) {
    const result = new Float32Array(count * 3);
    const random = mulberry32(count + 2207);
    const centers = [
      [-2.8, 1.0, 0.3], [0.2, 2.2, -0.6], [2.8, 0.65, 0.5], [-1.0, -1.8, 0.1], [2.0, -2.0, -0.8]
    ];

    for (let i = 0; i < count; i += 1) {
      const center = centers[i % centers.length];
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      const shell = 0.35 + Math.pow(random(), 0.35) * 1.65;
      const streak = Math.floor(i / centers.length) % 18;
      const streakAngle = streak / 18 * Math.PI * 2 + (i % 3) * 0.11;
      const blend = random() < 0.72 ? 0.82 : 0.18;
      const dx = blend * Math.sin(phi) * Math.cos(theta) + (1 - blend) * Math.cos(streakAngle);
      const dy = blend * Math.cos(phi) + (1 - blend) * Math.sin(streakAngle);
      const dz = blend * Math.sin(phi) * Math.sin(theta) + gaussian(random) * 0.08;
      const trail = 1 - Math.pow(random(), 2.1) * 0.32;
      result[i * 3] = center[0] + dx * shell * trail;
      result[i * 3 + 1] = center[1] + dy * shell * trail - (1 - trail) * 2.2;
      result[i * 3 + 2] = center[2] + dz * shell * trail;
    }
    return result;
  }

  function generateSaturn(count) {
    const result = new Float32Array(count * 3);
    const random = mulberry32(count + 3301);
    const sphereCount = Math.floor(count * 0.43);

    for (let i = 0; i < count; i += 1) {
      if (i < sphereCount) {
        const y = random() * 2 - 1;
        const theta = random() * Math.PI * 2;
        const radius = 2.15 * Math.cbrt(0.72 + random() * 0.28);
        const horizontal = Math.sqrt(1 - y * y);
        result[i * 3] = radius * horizontal * Math.cos(theta);
        result[i * 3 + 1] = radius * y * 0.92;
        result[i * 3 + 2] = radius * horizontal * Math.sin(theta);
      } else {
        const angle = random() * Math.PI * 2;
        const radius = 2.75 + Math.pow(random(), 0.8) * 2.35;
        const band = gaussian(random) * 0.055;
        result[i * 3] = Math.cos(angle) * radius;
        result[i * 3 + 1] = band + Math.sin(angle) * radius * 0.18;
        result[i * 3 + 2] = Math.sin(angle) * radius * 0.55 - Math.sin(angle) * radius * 0.05;
      }
    }
    return result;
  }

  function generateFlower(count) {
    const result = new Float32Array(count * 3);
    const random = mulberry32(count + 4409);
    const petals = 7;

    for (let i = 0; i < count; i += 1) {
      const t = random() * Math.PI * 2;
      const fill = Math.sqrt(random());
      const petalRadius = 1.2 + 3.1 * Math.abs(Math.sin(petals * t * 0.5));
      const radius = petalRadius * fill;
      const curl = 0.22 * Math.sin(t * 3 + fill * 6);
      result[i * 3] = Math.cos(t) * radius;
      result[i * 3 + 1] = Math.sin(t) * radius;
      result[i * 3 + 2] = (1 - fill) * 1.15 + curl + gaussian(random) * 0.07;
    }
    return result;
  }

  function createBackgroundStars() {
    const count = window.innerWidth < 700 ? 1100 : 2100;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    const random = mulberry32(987654);

    for (let i = 0; i < count; i += 1) {
      const radius = 24 + random() * 60;
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
      sizes[i] = 0.6 + Math.pow(random(), 3) * 2.8;
      alphas[i] = 0.2 + random() * 0.65;
      const tint = random();
      colors[i * 3] = 0.62 + tint * 0.38;
      colors[i * 3 + 1] = 0.68 + random() * 0.3;
      colors[i * 3 + 2] = 0.82 + random() * 0.18;
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1));
    geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.75) } },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        uniform float uPixelRatio;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPixelRatio * clamp(44.0 / max(8.0, -mvPosition.z), 0.35, 2.2);
          gl_Position = projectionMatrix * mvPosition;
          vAlpha = aAlpha;
          vColor = aColor;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          float d = distance(gl_PointCoord, vec2(0.5));
          if (d > 0.5) discard;
          float alpha = smoothstep(0.5, 0.0, d) * vAlpha;
          gl_FragColor = vec4(vColor, alpha);
        }
      `
    });

    state.starField = new THREE.Points(geometry, material);
    state.scene.add(state.starField);
  }

  function switchPreset(name, selectedButton) {
    if (!state.particles || name === state.currentPreset) return;
    state.currentPreset = name;
    state.basePositions = generatePresetPositions(name, state.particleCount);
    const explosionData = createExplosionData(state.basePositions, name, state.particleCount);
    state.explosionDirections = explosionData.explosionDirections;
    state.explodedPositions = explosionData.explodedPositions;
    document.querySelectorAll(".preset-button").forEach((button) => {
      const active = button === selectedButton;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  async function initializeHandTracking() {
    dom.messagePanel.hidden = true;
    stopCameraLoop();
    stopMediaStream();
    state.handVisible = false;
    state.rawOpen = 0;
    state.gestureExpanded = false;
    state.targetOpen = 0;
    state.opennessSamples.length = 0;
    resetHandMotionTracking();

    if (!isSecureLocalContext()) {
      showError("摄像头只能在 localhost、127.0.0.1 或 HTTPS 页面中启用。请用 Live Server 打开。", false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      showError("当前浏览器不支持摄像头访问，请使用最新版 Chrome 或 Edge。", false);
      return;
    }
    if (typeof window.Hands === "undefined") {
      showError(`MediaPipe Hands ${MEDIAPIPE_HANDS_VERSION} 尚未加载，请检查 CDN 网络后刷新页面。`, true);
      return;
    }

    setStatus("正在初始化", "loading");
    try {
      if (!state.hands) {
        state.hands = new window.Hands({
          locateFile: (file) => `${HANDS_CDN_ROOT}/${file}`
        });
        state.hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 1,
          minDetectionConfidence: 0.65,
          minTrackingConfidence: 0.62,
          selfieMode: false
        });
        state.hands.onResults(handleHandResults);
      }

      setStatus("等待摄像头授权", "loading");
      state.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 960 },
          height: { ideal: 540 },
          frameRate: { ideal: 30, max: 30 }
        }
      });
      dom.cameraVideo.srcObject = state.mediaStream;
      await dom.cameraVideo.play();
      dom.cameraPlaceholder.classList.add("hidden");
      dom.cameraPanel.classList.add("streaming");
      setStatus("未识别到手", "idle");
      startCameraLoop();
    } catch (error) {
      console.warn("摄像头初始化未完成：", error);
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      const message = denied
        ? "摄像头权限被拒绝。请点击浏览器地址栏左侧的权限图标，允许摄像头后，再点击下方按钮。"
        : `摄像头或模型初始化失败：${friendlyError(error)}`;
      showError(message, true);
      setStatus("摄像头或模型加载失败", "error");
    }
  }

  function startCameraLoop() {
    if (state.cameraLoopActive) return;
    state.cameraLoopActive = true;
    state.cameraGeneration += 1;
    state.lastHandProcessAt = 0;
    scheduleNextCameraFrame(state.cameraGeneration);
  }

  function scheduleNextCameraFrame(generation) {
    if (!state.cameraLoopActive || generation !== state.cameraGeneration) return;
    if (typeof dom.cameraVideo.requestVideoFrameCallback === "function") {
      state.cameraLoopId = dom.cameraVideo.requestVideoFrameCallback((now) => processCameraFrame(generation, now));
    } else {
      state.cameraLoopId = window.setTimeout(() => processCameraFrame(generation, performance.now()), 34);
    }
  }

  async function processCameraFrame(generation, now) {
    if (!state.cameraLoopActive || generation !== state.cameraGeneration) return;
    const detectionDue = now - state.lastHandProcessAt >= HAND_DETECTION_INTERVAL_MS;
    if (detectionDue && !state.handProcessing && dom.cameraVideo.readyState >= 2 && state.hands) {
      state.lastHandProcessAt = now;
      state.handProcessing = true;
      try {
        await state.hands.send({ image: dom.cameraVideo });
      } catch (error) {
        console.error(error);
        stopCameraLoop();
        showError(`手部模型运行失败：${friendlyError(error)}。请检查网络后重新尝试。`, true);
        setStatus("摄像头或模型加载失败", "error");
      } finally {
        state.handProcessing = false;
      }
    }
    scheduleNextCameraFrame(generation);
  }

  function stopCameraLoop() {
    state.cameraLoopActive = false;
    state.cameraGeneration += 1;
    if (typeof dom.cameraVideo?.cancelVideoFrameCallback === "function") {
      dom.cameraVideo.cancelVideoFrameCallback(state.cameraLoopId);
    } else {
      window.clearTimeout(state.cameraLoopId);
    }
    state.cameraLoopId = 0;
  }

  function stopMediaStream() {
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((track) => track.stop());
      state.mediaStream = null;
    }
    if (dom.cameraVideo) dom.cameraVideo.srcObject = null;
    dom.cameraPanel?.classList.remove("streaming");
    dom.cameraPlaceholder?.classList.remove("hidden");
  }

  function handleHandResults(results) {
    const landmarks = results.multiHandLandmarks?.[0];
    if (!landmarks) {
      if (performance.now() - state.lastHandSeenAt > 180) {
        if (state.handVisible) {
          setStatus("未识别到手", "idle");
          state.opennessSamples.length = 0;
          resetHandMotionTracking();
        }
        state.handVisible = false;
        state.rawOpen = 0;
      }
      return;
    }

    const wasHandVisible = state.handVisible;
    state.lastHandSeenAt = performance.now();
    state.handVisible = true;

    const openness = calculateHandOpenness(landmarks);
    state.opennessSamples.push(openness);
    if (state.opennessSamples.length > 5) state.opennessSamples.shift();
    const averageOpen = state.opennessSamples.reduce((sum, value) => sum + value, 0) / state.opennessSamples.length;
    state.rawOpen = averageOpen;

    const previousGestureExpanded = state.gestureExpanded;
    state.gestureExpanded = resolveExpandedGesture(averageOpen, state.gestureExpanded);
    state.targetOpen = state.gestureExpanded ? 1 : 0;

    if (!wasHandVisible || previousGestureExpanded !== state.gestureExpanded) {
      setStatus(
        state.gestureExpanded ? "手掌张开 · 粒子完全展开" : "手掌合拢 · 粒子完全收拢",
        "success"
      );
    }

    const palm = averageLandmarks(landmarks, [0, 5, 9, 13, 17]);
    // 画面使用镜像，因此反转 X，使模型方向与用户看到的移动一致。
    const mirroredX = 1 - palm.x;

    if (state.previousPalmX !== null && state.previousPalmY !== null) {
      const deltaX = mirroredX - state.previousPalmX;
      const deltaY = palm.y - state.previousPalmY;
      state.smoothedDeltaX = smoothMovementDelta(deltaX, state.smoothedDeltaX);
      state.smoothedDeltaY = smoothMovementDelta(deltaY, state.smoothedDeltaY);
      state.pendingRotationY += state.smoothedDeltaX * HORIZONTAL_MOVEMENT_SENSITIVITY;
      state.pendingRotationX += state.smoothedDeltaY * VERTICAL_MOVEMENT_SENSITIVITY;
    }

    state.previousPalmX = mirroredX;
    state.previousPalmY = palm.y;
  }

  function calculateHandOpenness(landmarks) {
    const palm = averageLandmarks(landmarks, [0, 5, 9, 13, 17]);
    const palmWidth = Math.max(distance3D(landmarks[5], landmarks[17]), 0.025);
    const tipIndices = [8, 12, 16, 20];
    let normalizedScore = 0;

    for (const tipIndex of tipIndices) {
      const tipToPalm = distance3D(landmarks[tipIndex], palm) / palmWidth;
      const tipToWrist = distance3D(landmarks[tipIndex], landmarks[0]) / palmWidth;
      normalizedScore += tipToPalm * 0.68 + tipToWrist * 0.32;
    }

    normalizedScore /= tipIndices.length;
    // 放宽自然张手的上限区间，让正常张开即可接近 100%，仍以掌宽消除远近影响。
    return clamp((normalizedScore - 0.72) / 0.86, 0, 1);
  }

  function averageLandmarks(landmarks, indices) {
    const point = { x: 0, y: 0, z: 0 };
    indices.forEach((index) => {
      point.x += landmarks[index].x;
      point.y += landmarks[index].y;
      point.z += landmarks[index].z;
    });
    point.x /= indices.length;
    point.y /= indices.length;
    point.z /= indices.length;
    return point;
  }

  function smoothMovementDelta(delta, previousSmoothedDelta) {
    if (Math.abs(delta) <= PALM_MOVEMENT_DEAD_ZONE) {
      return previousSmoothedDelta * 0.12;
    }
    return lerp(previousSmoothedDelta, delta, MOVEMENT_DELTA_LERP);
  }

  function resolveExpandedGesture(rawOpenness, previousExpandedState) {
    if (rawOpenness > OPEN_GESTURE_THRESHOLD) return true;
    if (rawOpenness < CLOSE_GESTURE_THRESHOLD) return false;
    return previousExpandedState;
  }

  function resetHandMotionTracking() {
    state.previousPalmX = null;
    state.previousPalmY = null;
    state.smoothedDeltaX = 0;
    state.smoothedDeltaY = 0;
    state.pendingRotationX = 0;
    state.pendingRotationY = 0;
  }

  function animate() {
    state.animationId = requestAnimationFrame(animate);
    const delta = Math.min(state.clock.getDelta(), 0.05);
    const elapsed = state.clock.elapsedTime;

    state.smoothOpen = damp(state.smoothOpen, state.targetOpen, EXPANSION_TRANSITION_DAMPING, delta);

    if (state.particles && state.basePositions && state.explodedPositions) {
      const current = state.particles.geometry.attributes.position.array;
      const morphFactor = 1 - Math.pow(0.0005, delta);
      for (let i = 0; i < current.length; i += 1) {
        const explodedOffset = state.explodedPositions[i] - state.basePositions[i];
        const desiredPosition = state.basePositions[i] + explodedOffset * state.smoothOpen;
        current[i] += (desiredPosition - current[i]) * morphFactor;
      }
      state.particles.geometry.attributes.position.needsUpdate = true;
    }

    const handRecentlyVisible = state.handVisible && performance.now() - state.lastHandSeenAt < 280;
    if (handRecentlyVisible) {
      const incrementLerpFactor = 1 - Math.pow(1 - ROTATION_INCREMENT_LERP, delta * 60);
      const rotationIncrementY = state.pendingRotationY * incrementLerpFactor;
      const rotationIncrementX = state.pendingRotationX * incrementLerpFactor;
      state.pendingRotationY -= rotationIncrementY;
      state.pendingRotationX -= rotationIncrementX;

      // 累加相邻检测帧的位移增量，可超过 360°；手静止后待应用增量会快速归零。
      state.particleRoot.rotation.y += rotationIncrementY;
      state.particleRoot.rotation.x = clamp(
        state.particleRoot.rotation.x + rotationIncrementX,
        -MAX_VERTICAL_TILT,
        MAX_VERTICAL_TILT
      );
    } else {
      state.handVisible = false;
      resetHandMotionTracking();
      state.particleRoot.rotation.y += AUTO_ROTATION_SPEED * delta;
      state.particleRoot.rotation.x = damp(state.particleRoot.rotation.x, Math.sin(elapsed * 0.22) * 0.14, 1.1, delta);
    }

    const targetScale = 1 + state.smoothOpen * 0.08;
    const scale = damp(state.particleRoot.scale.x, targetScale, 5.2, delta);
    state.particleRoot.scale.setScalar(scale);

    if (state.particleMaterial) {
      state.particleMaterial.uniforms.uTime.value = elapsed;
      state.particleMaterial.uniforms.uSpread.value = damp(state.particleMaterial.uniforms.uSpread.value, 0.01 + state.smoothOpen * 0.05, 4.4, delta);
      state.particleMaterial.uniforms.uPointSize.value = damp(state.particleMaterial.uniforms.uPointSize.value, 2.5 + state.smoothOpen * 0.55, 4.2, delta);
      state.particleMaterial.uniforms.uHue.value = (state.baseHue + state.particleRoot.rotation.y / (Math.PI * 2) + elapsed * 0.008) % 1;
    }

    if (performance.now() - state.lastOpennessUiAt > 90) {
      state.lastOpennessUiAt = performance.now();
      dom.opennessText.textContent = state.handVisible
        ? `原始开合 ${Math.round(state.rawOpen * 100)}%`
        : "原始开合 --";
    }

    if (state.starField) {
      state.starField.rotation.y += delta * 0.006;
      state.starField.rotation.x = Math.sin(elapsed * 0.035) * 0.06;
    }

    state.renderer.render(state.scene, state.camera);
  }

  function updateAccentColor(hex) {
    const color = new THREE.Color(hex);
    const hsl = {};
    color.getHSL(hsl);
    state.baseHue = hsl.h;
    const rgb = `${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}`;
    document.documentElement.style.setProperty("--accent", hex);
    document.documentElement.style.setProperty("--accent-rgb", rgb);
    dom.colorValue.textContent = hex.toUpperCase();
    if (state.particleMaterial) state.particleMaterial.uniforms.uHue.value = state.baseHue;
  }

  function updateRangeProgress() {
    const min = Number(dom.densitySlider.min);
    const max = Number(dom.densitySlider.max);
    const value = Number(dom.densitySlider.value);
    dom.densitySlider.style.setProperty("--range-progress", `${((value - min) / (max - min)) * 100}%`);
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
      syncFullscreenButton();
      window.setTimeout(syncFullscreenButton, 260);
    } catch (error) {
      syncFullscreenButton();
      showError(`无法切换全屏：${friendlyError(error)}`, false);
    }
  }

  function syncFullscreenButton() {
    const active = Boolean(document.fullscreenElement);
    dom.fullscreenText.textContent = active ? "退出全屏" : "全屏";
    dom.fullscreenButton.setAttribute("aria-label", active ? "退出全屏" : "进入全屏");
    dom.fullscreenButton.title = active ? "退出全屏" : "进入全屏";
  }

  function setupCameraResizeHandles() {
    document.querySelectorAll(".resize-handle").forEach((handle) => {
      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        const edge = handle.dataset.edge;
        const startX = event.clientX;
        const startY = event.clientY;
        const startWidth = dom.cameraPanel.offsetWidth;
        const startHeight = dom.cameraPanel.offsetHeight;

        const onMove = (moveEvent) => {
          let width = startWidth;
          let height = startHeight;
          if (edge.includes("e")) width = startWidth + moveEvent.clientX - startX;
          if (edge.includes("n")) height = startHeight + startY - moveEvent.clientY;
          width = clamp(width, 190, Math.min(window.innerWidth * 0.52, 520));
          height = clamp(height, 126, Math.min(window.innerHeight * 0.46, 350));
          dom.cameraPanel.style.width = `${width}px`;
          dom.cameraPanel.style.height = `${height}px`;
        };

        const onUp = () => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
        };

        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      });
    });
  }

  function handleResize() {
    if (!state.renderer || !state.camera) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    state.camera.aspect = width / height;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(width, height, false);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
    state.renderer.setPixelRatio(pixelRatio);
    state.particleRoot.position.x = width > 820 ? -0.55 : 0;
    if (state.particleMaterial) state.particleMaterial.uniforms.uPixelRatio.value = pixelRatio;
    if (state.starField) state.starField.material.uniforms.uPixelRatio.value = pixelRatio;
    syncFullscreenButton();
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      cancelAnimationFrame(state.animationId);
      state.animationId = 0;
      stopCameraLoop();
      return;
    }

    if (state.initialized && state.animationId === 0) {
      state.clock.getDelta();
      animate();
    }
    if (state.mediaStream && !state.cameraLoopActive) startCameraLoop();
  }

  function setStatus(text, stateName) {
    dom.statusText.textContent = text;
    dom.statusBadge.dataset.state = stateName;
  }

  function showError(message, canRetry) {
    dom.messageText.textContent = message;
    dom.retryCameraButton.hidden = !canRetry;
    dom.messagePanel.hidden = false;
    setStatus("摄像头或模型加载失败", "error");
  }

  function disposeApp() {
    cancelAnimationFrame(state.animationId);
    state.animationId = 0;
    stopCameraLoop();
    stopMediaStream();
    if (state.hands?.close) state.hands.close();
    if (state.particles) state.particles.geometry.dispose();
    if (state.particleMaterial) state.particleMaterial.dispose();
    if (state.starField) {
      state.starField.geometry.dispose();
      state.starField.material.dispose();
    }
    if (state.renderer) state.renderer.dispose();
  }

  function friendlyError(error) {
    return error?.message || error?.name || "未知错误";
  }

  function distance3D(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
  }

  function lerp(a, b, amount) {
    return a + (b - a) * amount;
  }

  function damp(current, target, lambda, delta) {
    return THREE.MathUtils.damp(current, target, lambda, delta);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function gaussian(random) {
    const u = Math.max(random(), 1e-7);
    const v = Math.max(random(), 1e-7);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function mulberry32(seed) {
    return function () {
      let value = seed += 0x6D2B79F5;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }
})();

"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

import { EDGE_COLOR_HEX, ZONE_PALETTES } from "@/lib/graph";
import type {
  CompanyNode,
  GraphEdge as GraphEdgeT,
  RelationshipType,
} from "@/lib/types";

type Props = {
  companies: Record<string, CompanyNode>;
  edges: GraphEdgeT[];
  selectedDomain: string | null;
  onSelect: (domain: string | null) => void;
};

type ZoneKey = keyof typeof ZONE_PALETTES;

// Numeric versions of edge colors for three.js (hex ints).
const EDGE_COLOR_NUM: Record<RelationshipType, number> = {
  partner: 0x00e5ff,
  competitor: 0xff8c64,
  investor: 0xb19cff,
  downstream: 0x5dcaa5,
  talent: 0xf0c978,
  none: 0x394b6a,
};

// ---------- node factory ----------

type NodeUser = {
  domain: string;
  displayName: string;
  body: THREE.Mesh;
  bodyMat: THREE.ShaderMaterial;
  halo: THREE.Sprite;
  bulbGlow: THREE.Mesh;
  light: THREE.PointLight;
  bobPhase: number;
  bobFreq: number;
  bobAmp: number;
  spinOffset: number;
  home: THREE.Vector3;
  diameter: number;
};

type EdgeObj = {
  edge: GraphEdgeT;
  a: THREE.Group;
  b: THREE.Group;
  aDomain: string;
  bDomain: string;
  line: Line2;
  lineGeom: LineGeometry;
  lineMat: LineMaterial;
  segPositions: Float32Array;
  particles: THREE.Points;
  pPos: Float32Array;
  pCount: number;
  conf: number;
  color: number;
  phase: number;
  curveOffset: number;
  curve?: THREE.QuadraticBezierCurve3;
};

function randSpherePosition(i: number, total: number): THREE.Vector3 {
  const phi = Math.acos(1 - (2 * (i + 0.5)) / total);
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;
  const r = 11 + (i % 3) * 0.6;
  return new THREE.Vector3(
    Math.cos(theta) * Math.sin(phi) * r,
    Math.sin(theta) * Math.sin(phi) * r * 0.6,
    (Math.cos(phi) * r - 2) * 0.7,
  );
}

let cachedGlowTex: THREE.Texture | null = null;
function makeGlowTexture(): THREE.Texture {
  if (cachedGlowTex) return cachedGlowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.2, "rgba(255,255,255,0.6)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.18)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  cachedGlowTex = tex;
  return tex;
}

function createAnglerfishNode(
  company: CompanyNode,
  pos: THREE.Vector3,
  pal: (typeof ZONE_PALETTES)[ZoneKey],
  glow: number,
): THREE.Group {
  const group = new THREE.Group();
  group.position.copy(pos);

  const pageCount = company.pageCount ?? 10;
  const diameter = 0.9 + Math.min(1.4, Math.sqrt(Math.max(1, pageCount)) / 7);

  // body
  const bodyGeo = new THREE.SphereGeometry(diameter, 42, 32);
  const bodyMat = new THREE.ShaderMaterial({
    uniforms: {
      uBody: { value: new THREE.Color(pal.body) },
      uRim: { value: new THREE.Color(pal.rim) },
      uTime: { value: 0 },
      uGlow: { value: glow },
      uSelected: { value: 0 },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewPos;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uBody; uniform vec3 uRim;
      uniform float uTime; uniform float uGlow; uniform float uSelected;
      varying vec3 vNormal; varying vec3 vViewPos;
      void main() {
        vec3 v = normalize(vViewPos);
        float fres = pow(1.0 - max(dot(vNormal, v), 0.0), 2.0);
        // Stronger fresnel mix so the rim actually reads in the dark scene
        vec3 col = mix(uBody, uRim, clamp(fres * 1.15 * uGlow, 0.0, 1.0));
        // Small top-down cheat light so the body has some base brightness
        float topLight = max(vNormal.y, 0.0) * 0.25;
        col += uRim * topLight * 0.4;
        float n = sin(vNormal.x*6.0 + uTime*0.3) * sin(vNormal.y*5.0) * 0.04;
        col += n;
        col += uRim * fres * uSelected * 0.9;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  group.add(body);

  // lure arc
  const lureLen = diameter * 1.25;
  const arcPts: THREE.Vector3[] = [];
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = (Math.PI * 0.5) * t;
    arcPts.push(
      new THREE.Vector3(
        Math.sin(a) * lureLen * 0.55,
        Math.cos(a) * lureLen + diameter * 0.2,
        0,
      ),
    );
  }
  const curve = new THREE.CatmullRomCurve3(arcPts);
  const tubeGeo = new THREE.TubeGeometry(curve, 30, 0.035, 6, false);
  const tubeMat = new THREE.MeshBasicMaterial({
    color: 0x15243f,
    transparent: true,
    opacity: 0.85,
  });
  group.add(new THREE.Mesh(tubeGeo, tubeMat));

  const tipPos = arcPts[arcPts.length - 1].clone();

  // bulb core + glow halo + point light
  const bulbCore = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  bulbCore.position.copy(tipPos);
  group.add(bulbCore);

  const bulbGlow = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 20, 16),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(pal.lure) },
        uIntensity: { value: 1 },
      },
      vertexShader: `
        varying vec3 vNormal; varying vec3 vView;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uIntensity;
        varying vec3 vNormal; varying vec3 vView;
        void main() {
          float f = pow(1.0 - abs(dot(normalize(vView), vNormal)), 3.0);
          gl_FragColor = vec4(uColor * uIntensity, f);
        }`,
    }),
  );
  bulbGlow.position.copy(tipPos);
  group.add(bulbGlow);

  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      color: pal.lure,
      transparent: true,
      opacity: 0.75 * glow,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  halo.scale.set(1.6, 1.6, 1);
  halo.position.copy(tipPos);
  group.add(halo);

  const light = new THREE.PointLight(pal.lure, 0.9 * glow, 6, 2);
  light.position.copy(tipPos);
  group.add(light);

  // fins
  const finMat = new THREE.MeshBasicMaterial({
    color: 0x0a1025,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
  });
  for (const sideSign of [-1, 1] as const) {
    const fin = new THREE.Mesh(
      new THREE.PlaneGeometry(diameter * 0.8, diameter * 0.5),
      finMat,
    );
    fin.position.set(sideSign * diameter * 0.85, -diameter * 0.1, 0);
    fin.rotation.z = sideSign * 0.4;
    fin.rotation.y = sideSign * 0.2;
    group.add(fin);
  }

  const userData: NodeUser = {
    domain: company.domain,
    displayName: company.name,
    body,
    bodyMat,
    halo,
    bulbGlow,
    light,
    bobPhase: Math.random() * Math.PI * 2,
    bobFreq: 0.4 + Math.random() * 0.3,
    bobAmp: 0.15 + Math.random() * 0.2,
    spinOffset: Math.random() * 0.4 - 0.2,
    home: pos.clone(),
    diameter,
  };
  group.userData = userData;
  return group;
}

// ---------- component ----------

export default function GraphCanvas({
  companies,
  edges,
  selectedDomain,
  onSelect,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelLayerRef = useRef<HTMLDivElement | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // World refs — single instance across the component lifetime
  const worldRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    fog: THREE.FogExp2;
    ambient: THREE.AmbientLight;
    nodesGroup: THREE.Group;
    edgesGroup: THREE.Group;
    ambientGroup: THREE.Group;
    nodes: Map<string, THREE.Group>;
    labels: Map<string, HTMLDivElement>;
    edgeObjs: EdgeObj[];
    snow: THREE.Points | null;
    rays: THREE.Mesh[];
    raycaster: THREE.Raycaster;
    nodeMeshes: THREE.Object3D[];
    camYaw: number;
    camPitch: number;
    camYawTarget: number;
    camPitchTarget: number;
    camRadius: number;
    camRadiusTarget: number;
    selectedDomain: string | null;
    animFrame: number | null;
    clock: THREE.Clock;
    glow: number;
  } | null>(null);

  // ---- init (run once) ----
  useEffect(() => {
    if (!canvasRef.current || !hostRef.current) return;
    const pal = ZONE_PALETTES.abyss;
    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.55;

    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    camera.position.set(0, 0, 28);

    const fog = new THREE.FogExp2(pal.fog, pal.fogDens);
    scene.fog = fog;

    const ambient = new THREE.AmbientLight(pal.ambient, 1.35);
    scene.add(ambient);

    const topLight = new THREE.DirectionalLight(0x9bc4f0, 0.55);
    topLight.position.set(0.4, 1, 0.3);
    scene.add(topLight);

    // Fill: a warm rim-light from behind-right so nodes read with depth
    const fill = new THREE.DirectionalLight(0x4a6fa8, 0.35);
    fill.position.set(-0.6, -0.2, -0.8);
    scene.add(fill);

    const nodesGroup = new THREE.Group();
    const edgesGroup = new THREE.Group();
    const ambientGroup = new THREE.Group();
    scene.add(ambientGroup, edgesGroup, nodesGroup);

    // marine snow
    const snowCount = 240;
    const snowGeom = new THREE.BufferGeometry();
    const snowPos = new Float32Array(snowCount * 3);
    const snowVel = new Float32Array(snowCount * 3);
    for (let i = 0; i < snowCount; i++) {
      snowPos[3 * i] = (Math.random() - 0.5) * 70;
      snowPos[3 * i + 1] = (Math.random() - 0.5) * 50;
      snowPos[3 * i + 2] = (Math.random() - 0.5) * 60 - 5;
      snowVel[3 * i] = (Math.random() - 0.5) * 0.015;
      snowVel[3 * i + 1] = -0.008 - Math.random() * 0.015;
      snowVel[3 * i + 2] = (Math.random() - 0.5) * 0.01;
    }
    snowGeom.setAttribute("position", new THREE.BufferAttribute(snowPos, 3));
    snowGeom.setAttribute("aVel", new THREE.BufferAttribute(snowVel, 3));
    const snow = new THREE.Points(
      snowGeom,
      new THREE.PointsMaterial({
        color: pal.particles,
        size: 0.08,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ambientGroup.add(snow);

    worldRef.current = {
      renderer,
      scene,
      camera,
      fog,
      ambient,
      nodesGroup,
      edgesGroup,
      ambientGroup,
      nodes: new Map(),
      labels: new Map(),
      edgeObjs: [],
      snow,
      rays: [],
      raycaster: new THREE.Raycaster(),
      nodeMeshes: [],
      camYaw: 0,
      camPitch: 0,
      camYawTarget: 0,
      camPitchTarget: 0,
      camRadius: 28,
      camRadiusTarget: 28,
      selectedDomain: null,
      animFrame: null,
      clock: new THREE.Clock(),
      glow: 1.0,
    };

    // resize
    const resize = () => {
      if (!hostRef.current || !worldRef.current) return;
      const w = hostRef.current.clientWidth;
      const h = hostRef.current.clientHeight;
      worldRef.current.renderer.setSize(w, h, false);
      worldRef.current.camera.aspect = w / h;
      worldRef.current.camera.updateProjectionMatrix();
      // Line2 materials need the canvas resolution to compute screen-space width.
      worldRef.current.edgeObjs.forEach((eo) => {
        eo.lineMat.resolution.set(w, h);
      });
    };
    resize();
    window.addEventListener("resize", resize);

    // Click-drag to pan the camera; a click without meaningful drag selects a node.
    const host = hostRef.current;
    host.style.cursor = "grab";
    let isDragging = false;
    let lastX = 0;
    let lastY = 0;
    let downX = 0;
    let downY = 0;
    const DRAG_THRESHOLD_PX = 4;

    const onDown = (e: MouseEvent) => {
      isDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      downX = e.clientX;
      downY = e.clientY;
      host.style.cursor = "grabbing";
    };
    const onMove = (e: MouseEvent) => {
      if (!isDragging || !worldRef.current) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      // Drag-rate: full canvas width ≈ 0.9 radians of yaw (~50°). Y axis inverted so
      // dragging down tilts the camera down.
      const w = worldRef.current;
      const rect = host.getBoundingClientRect();
      w.camYawTarget -= (dx / rect.width) * 1.8;
      w.camPitchTarget = Math.max(
        -0.9,
        Math.min(0.9, w.camPitchTarget - (dy / rect.height) * 1.2),
      );
    };
    const onUp = (e: MouseEvent) => {
      if (!worldRef.current || !hostRef.current) return;
      const wasDragging = isDragging;
      isDragging = false;
      host.style.cursor = "grab";

      const totalDx = e.clientX - downX;
      const totalDy = e.clientY - downY;
      if (Math.hypot(totalDx, totalDy) < DRAG_THRESHOLD_PX && wasDragging) {
        const w = worldRef.current;
        const r = hostRef.current.getBoundingClientRect();
        const mx = ((e.clientX - r.left) / r.width) * 2 - 1;
        const my = -((e.clientY - r.top) / r.height) * 2 + 1;
        w.raycaster.setFromCamera(new THREE.Vector2(mx, my), w.camera);
        const hits = w.raycaster.intersectObjects(w.nodeMeshes, true);
        if (hits.length) {
          const domain = hits[0].object.userData.nodeDomain as string | undefined;
          if (domain) onSelectRef.current(domain);
        } else {
          onSelectRef.current(null);
        }
      }
    };
    const onLeave = () => {
      isDragging = false;
      host.style.cursor = "grab";
    };
    // Wheel = trackpad two-finger scroll or pinch zoom (browsers deliver pinches as
    // wheel events with ctrlKey=true). Treat both as zoom.
    const onWheel = (e: WheelEvent) => {
      if (!worldRef.current) return;
      e.preventDefault();
      // Pinch deltas are small (<5); scroll deltas can be huge. Normalize both.
      const scale = 1 + Math.max(-0.15, Math.min(0.15, e.deltaY * 0.0025));
      worldRef.current.camRadiusTarget = Math.max(
        10,
        Math.min(70, worldRef.current.camRadiusTarget * scale),
      );
    };
    host.addEventListener("mousedown", onDown);
    host.addEventListener("mousemove", onMove);
    host.addEventListener("mouseup", onUp);
    host.addEventListener("mouseleave", onLeave);
    host.addEventListener("wheel", onWheel, { passive: false });

    // animation loop
    const tmp = new THREE.Vector3();
    const animate = () => {
      if (!worldRef.current) return;
      const w = worldRef.current;
      const t = w.clock.getElapsedTime();

      // node bob + lure pulse
      w.nodes.forEach((g) => {
        const u = g.userData as NodeUser;
        g.position.y = u.home.y + Math.sin(t * u.bobFreq + u.bobPhase) * u.bobAmp;
        g.position.x = u.home.x + Math.cos(t * u.bobFreq * 0.7 + u.bobPhase) * u.bobAmp * 0.5;
        g.position.z = u.home.z + Math.sin(t * u.bobFreq * 0.5 + u.bobPhase) * u.bobAmp * 0.3;
        g.rotation.y = Math.sin(t * 0.3 + u.bobPhase) * 0.15 + u.spinOffset;
        u.bodyMat.uniforms.uTime.value = t;
        const pulse = 0.8 + 0.35 * Math.sin(t * 1.6 + u.bobPhase * 2);
        (u.bulbGlow.material as THREE.ShaderMaterial).uniforms.uIntensity.value =
          pulse * w.glow;
        (u.halo.material as THREE.SpriteMaterial).opacity =
          (0.45 + 0.35 * pulse) * w.glow;
        u.light.intensity = pulse * 0.9 * w.glow;
      });

      // edges (geometry + particle flow)
      const sel = w.selectedDomain;
      w.edgeObjs.forEach((eo) => {
        const a = eo.a.position;
        const b = eo.b.position;
        const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
        const dir = new THREE.Vector3().subVectors(b, a);
        const perp = new THREE.Vector3(-dir.y, dir.x, 0).normalize();
        mid.add(perp.multiplyScalar(eo.curveOffset * 0.5));
        mid.z += 1.2 + eo.curveOffset * 0.3;
        const curve = new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
        eo.curve = curve;

        for (let i = 0; i <= 24; i++) {
          const p = curve.getPoint(i / 24);
          eo.segPositions[3 * i] = p.x;
          eo.segPositions[3 * i + 1] = p.y;
          eo.segPositions[3 * i + 2] = p.z;
        }
        eo.lineGeom.setPositions(eo.segPositions);
        eo.line.computeLineDistances();

        for (let i = 0; i < eo.pCount; i++) {
          const frac = (t * 0.25 + i / eo.pCount + eo.phase) % 1;
          const p = curve.getPoint(frac);
          eo.pPos[3 * i] = p.x;
          eo.pPos[3 * i + 1] = p.y;
          eo.pPos[3 * i + 2] = p.z;
        }
        eo.particles.geometry.attributes.position.needsUpdate = true;

        const isSel =
          sel !== null && (eo.aDomain === sel || eo.bDomain === sel);
        const base = 0.55 + eo.conf * 0.35;
        eo.lineMat.opacity = base * (isSel ? 1.6 : 1) * (sel && !isSel ? 0.4 : 1);
        (eo.particles.material as THREE.PointsMaterial).opacity =
          isSel ? 1 : sel ? 0.45 : 1;
      });

      // marine snow drift
      if (w.snow) {
        const pos = w.snow.geometry.attributes.position.array as Float32Array;
        const vel = w.snow.geometry.attributes.aVel.array as Float32Array;
        for (let i = 0; i < pos.length / 3; i++) {
          pos[3 * i] += vel[3 * i];
          pos[3 * i + 1] += vel[3 * i + 1];
          pos[3 * i + 2] += vel[3 * i + 2];
          if (pos[3 * i + 1] < -25) {
            pos[3 * i + 1] = 25;
            pos[3 * i] = (Math.random() - 0.5) * 70;
          }
          if (Math.abs(pos[3 * i]) > 36) pos[3 * i] *= -0.95;
        }
        w.snow.geometry.attributes.position.needsUpdate = true;
      }

      // camera easing (yaw, pitch, zoom)
      w.camYaw += (w.camYawTarget - w.camYaw) * 0.08;
      w.camPitch += (w.camPitchTarget - w.camPitch) * 0.08;
      w.camRadius += (w.camRadiusTarget - w.camRadius) * 0.1;
      w.camera.position.x = Math.sin(w.camYaw) * w.camRadius;
      w.camera.position.z = Math.cos(w.camYaw) * w.camRadius;
      w.camera.position.y = Math.sin(w.camPitch) * w.camRadius * 0.6;
      w.camera.lookAt(0, 0, 0);

      // project labels
      if (hostRef.current && labelLayerRef.current) {
        const rect = hostRef.current.getBoundingClientRect();
        w.labels.forEach((el, domain) => {
          const g = w.nodes.get(domain);
          if (!g) {
            el.style.display = "none";
            return;
          }
          g.getWorldPosition(tmp);
          tmp.y -= (g.userData as NodeUser).diameter + 0.15;
          tmp.project(w.camera);
          if (tmp.z > 1 || tmp.z < -1) {
            el.style.display = "none";
            return;
          }
          const x = (tmp.x * 0.5 + 0.5) * rect.width;
          const y = (-tmp.y * 0.5 + 0.5) * rect.height;
          el.style.display = "block";
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
        });
      }

      w.renderer.render(w.scene, w.camera);
      w.animFrame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      window.removeEventListener("resize", resize);
      host.removeEventListener("mousedown", onDown);
      host.removeEventListener("mousemove", onMove);
      host.removeEventListener("mouseup", onUp);
      host.removeEventListener("mouseleave", onLeave);
      host.removeEventListener("wheel", onWheel);
      if (worldRef.current?.animFrame !== null && worldRef.current?.animFrame !== undefined) {
        cancelAnimationFrame(worldRef.current.animFrame);
      }
      worldRef.current?.renderer.dispose();
      worldRef.current?.labels.forEach((el) => el.remove());
      worldRef.current = null;
    };
  }, []);

  // ---- sync companies → nodes ----
  useEffect(() => {
    const w = worldRef.current;
    if (!w || !labelLayerRef.current) return;
    const pal = ZONE_PALETTES.abyss;
    const wantedDomains = new Set(Object.keys(companies));
    const totalWanted = wantedDomains.size;

    // remove gone
    for (const [domain, g] of Array.from(w.nodes.entries())) {
      if (!wantedDomains.has(domain)) {
        w.nodesGroup.remove(g);
        g.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry?.dispose();
            if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
            else (o.material as THREE.Material).dispose();
          }
        });
        w.nodes.delete(domain);
        const lab = w.labels.get(domain);
        if (lab) {
          lab.remove();
          w.labels.delete(domain);
        }
      }
    }

    // add new in a deterministic order so positions are stable
    const ordered = Object.values(companies).sort((a, b) =>
      a.domain.localeCompare(b.domain),
    );
    ordered.forEach((c, i) => {
      if (w.nodes.has(c.domain)) return;
      const pos = randSpherePosition(i, Math.max(totalWanted, 4));
      const g = createAnglerfishNode(c, pos, pal, w.glow);
      g.userData = { ...(g.userData as NodeUser), domain: c.domain };
      g.traverse((o) => {
        o.userData.nodeDomain = c.domain;
      });
      w.nodes.set(c.domain, g);
      w.nodesGroup.add(g);

      const lab = document.createElement("div");
      lab.className = "node-label";
      lab.innerHTML = `${c.name}${
        c.status !== "completed" ? ` <span class="st">· ${c.status}</span>` : ""
      }`;
      labelLayerRef.current!.appendChild(lab);
      w.labels.set(c.domain, lab);
    });

    // update labels (status text) for existing nodes
    w.labels.forEach((el, domain) => {
      const c = companies[domain];
      if (!c) return;
      el.innerHTML = `${c.name}${
        c.status !== "completed" ? ` <span class="st">· ${c.status}</span>` : ""
      }`;
    });

    // refresh raycast list
    w.nodeMeshes = [];
    w.nodes.forEach((g) => {
      g.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) w.nodeMeshes.push(o);
      });
    });
  }, [companies]);

  // ---- sync edges ----
  useEffect(() => {
    const w = worldRef.current;
    if (!w) return;

    // tear down old
    w.edgeObjs.forEach((eo) => {
      w.edgesGroup.remove(eo.line);
      w.edgesGroup.remove(eo.particles);
      eo.lineGeom.dispose();
      eo.lineMat.dispose();
      eo.particles.geometry.dispose();
      (eo.particles.material as THREE.Material).dispose();
    });
    w.edgeObjs = [];

    // Build a name → domain resolver from the current companies prop so we can
    // translate SSE edges (which use display names) back to the node keys (domains).
    const nameToDomain = new Map<string, string>();
    Object.values(companies).forEach((c) => nameToDomain.set(c.name, c.domain));

    const canvasW = w.renderer.domElement.clientWidth;
    const canvasH = w.renderer.domElement.clientHeight;

    edges.forEach((edge) => {
      const aDomain = nameToDomain.get(edge.source);
      const bDomain = nameToDomain.get(edge.target);
      if (!aDomain || !bDomain) return;
      const a = w.nodes.get(aDomain);
      const b = w.nodes.get(bDomain);
      if (!a || !b) return;

      const color = EDGE_COLOR_NUM[edge.type];
      const conf =
        edge.confidence === "high" ? 1 : edge.confidence === "medium" ? 0.65 : 0.38;

      // Thick screen-space line. `linewidth` is pixels when worldUnits=false.
      // Base was effectively 1px; 5× → 5px for high, scaled down for lower confidence.
      const segCount = 24;
      const segPositions = new Float32Array((segCount + 1) * 3);
      const lineGeom = new LineGeometry();
      lineGeom.setPositions(segPositions);
      const lineMat = new LineMaterial({
        color,
        linewidth: 2.5 + conf * 2.5,
        transparent: true,
        opacity: 0.55 + conf * 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        worldUnits: false,
        dashed: false,
      });
      lineMat.resolution.set(canvasW, canvasH);
      const line = new Line2(lineGeom, lineMat);
      line.computeLineDistances();
      w.edgesGroup.add(line);

      const pCount = Math.round(10 + conf * 16);
      const pGeom = new THREE.BufferGeometry();
      const pPos = new Float32Array(pCount * 3);
      pGeom.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
      const particles = new THREE.Points(
        pGeom,
        new THREE.PointsMaterial({
          color,
          size: 0.32,
          transparent: true,
          opacity: 1,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          map: makeGlowTexture(),
        }),
      );
      w.edgesGroup.add(particles);

      w.edgeObjs.push({
        edge,
        a,
        b,
        aDomain,
        bDomain,
        line,
        lineGeom,
        lineMat,
        segPositions,
        particles,
        pPos,
        pCount,
        conf,
        color,
        phase: Math.random() * 10,
        curveOffset: (Math.random() - 0.5) * 2.5,
      });
    });
  }, [edges, companies]);

  // ---- sync selection ----
  useEffect(() => {
    const w = worldRef.current;
    if (!w) return;
    w.selectedDomain = selectedDomain;
    w.nodes.forEach((g, domain) => {
      const u = g.userData as NodeUser;
      u.bodyMat.uniforms.uSelected.value = domain === selectedDomain ? 1 : 0;
    });
    w.labels.forEach((el, domain) => {
      el.classList.toggle("selected", domain === selectedDomain);
    });
  }, [selectedDomain]);

  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden rounded-[18px] border border-[rgba(140,200,255,0.08)] bg-[radial-gradient(ellipse_120%_80%_at_50%_0%,_#061228_0%,_#020615_60%,_#000105_100%)]">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div ref={labelLayerRef} className="pointer-events-none absolute inset-0" />
      {/* crosshair */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[26px] w-[26px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[rgba(0,229,255,0.18)]">
        <span className="absolute left-1/2 -top-[6px] -bottom-[6px] w-[1px] -translate-x-1/2 bg-[rgba(0,229,255,0.18)]" />
        <span className="absolute top-1/2 -left-[6px] -right-[6px] h-[1px] -translate-y-1/2 bg-[rgba(0,229,255,0.18)]" />
      </div>
    </div>
  );
}


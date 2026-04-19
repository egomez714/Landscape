"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

import { ZONE_PALETTES } from "@/lib/graph";
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

// Numeric versions of edge colors for three.js (hex ints). Mirrors EDGE_COLOR
// in lib/graph.ts — keep in sync.
const EDGE_COLOR_NUM: Record<RelationshipType, number> = {
  partner: 0x00e5ff,
  competitor: 0xff8c64,
  uses: 0x5dcaa5,
  customer: 0xb19cff,
  none: 0x394b6a,
};

// ---------- node factory ----------

type Filament = {
  line: THREE.Line;
  pts: THREE.Vector3[];
  baseAng: number;
};

type NodeUser = {
  domain: string;
  displayName: string;
  body: THREE.Mesh;
  bodyMat: THREE.ShaderMaterial;
  halo: THREE.Sprite;
  bulbCore: THREE.Mesh;
  bulbGlow: THREE.Mesh;
  light: THREE.PointLight;
  tube: THREE.Mesh;
  tubeMat: THREE.MeshBasicMaterial;
  eye: THREE.Mesh;
  eyeGlint: THREE.Mesh;
  teethGroup: THREE.Group;
  caudal: THREE.Mesh;
  pectL: THREE.Mesh;
  pectR: THREE.Mesh;
  pelvic: THREE.Mesh;
  tailStub: THREE.Mesh;
  filaments: Filament[];
  filamentGroup: THREE.Group;
  tipPos: THREE.Vector3;
  bobPhase: number;
  bobFreq: number;
  bobAmp: number;
  spinOffset: number;
  home: THREE.Vector3;
  diameter: number;
  fishYaw: number;
};

type EdgeObj = {
  edge: GraphEdgeT;
  a: THREE.Group;
  b: THREE.Group;
  aDomain: string;
  bDomain: string;
  ribbon: THREE.Mesh;
  ribbonGeom: THREE.BufferGeometry;
  ribbonMat: THREE.ShaderMaterial;
  ribbonVerts: Float32Array;
  conf: number;
  color: number;
  phase: number;
  curveOffset: number;
  curve?: THREE.QuadraticBezierCurve3;
};

const EDGE_SEGS = 30;

function randSpherePosition(i: number, total: number): THREE.Vector3 {
  // Fibonacci-spiral distribution on a lens-shaped surface.
  // Base radius scales with sqrt(total) so 20 companies don't crowd like 4 do.
  const phi = Math.acos(1 - (2 * (i + 0.5)) / total);
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;
  const r = 8 + Math.sqrt(Math.max(1, total)) * 2.6 + (i % 3) * 0.6;
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
  idx: number,
  pal: (typeof ZONE_PALETTES)[ZoneKey],
  glow: number,
): THREE.Group {
  const group = new THREE.Group();
  group.position.copy(pos);

  const pageCount = company.pageCount ?? 10;
  const diameter = 0.9 + Math.min(1.4, Math.sqrt(Math.max(1, pageCount)) / 7);
  const D = diameter;

  const fishYaw = (idx * 0.83) % (Math.PI * 2);
  group.rotation.y = fishYaw;

  // BODY — egg-shaped, tapered toward tail.
  const bodyGeo = new THREE.SphereGeometry(D, 48, 36);
  {
    const p = bodyGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i);
      let y = p.getY(i);
      let z = p.getZ(i);
      const fwd = x / D;
      const taper = 1 - Math.max(0, -fwd) * 0.55;
      y *= taper;
      z *= taper;
      if (y < 0 && fwd > 0.1) y += y * 0.25 * fwd;
      if (y > 0 && fwd > 0.05 && fwd < 0.65)
        y += Math.sin((fwd * Math.PI) / 0.6) * 0.08 * D;
      x *= 1.35;
      p.setXYZ(i, x, y, z);
    }
    bodyGeo.computeVertexNormals();
  }

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
      varying vec3 vObjPos;
      void main(){
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = -mv.xyz;
        vObjPos = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uBody; uniform vec3 uRim;
      uniform float uTime; uniform float uGlow; uniform float uSelected;
      varying vec3 vNormal; varying vec3 vViewPos; varying vec3 vObjPos;
      float hash(vec2 p){return fract(sin(dot(p, vec2(41.3,289.1)))*43758.5453);}
      float noise(vec2 p){
        vec2 i=floor(p), f=fract(p);
        float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
        vec2 u=f*f*(3.0-2.0*f);
        return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y;
      }
      void main(){
        vec3 v = normalize(vViewPos);
        float fres = pow(1.0 - max(dot(vNormal, v), 0.0), 2.2);
        vec3 col = mix(uBody, uRim, clamp(fres * 0.85 * uGlow, 0.0, 1.0));
        float sc = noise(vObjPos.xy * 14.0) * noise(vObjPos.yz * 11.0);
        col += (sc - 0.5) * 0.12;
        float belly = smoothstep(-0.2, -0.9, vObjPos.y);
        col += belly * vec3(0.02, 0.04, 0.06);
        col += uRim * fres * uSelected * 0.7;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  group.add(body);

  // MOUTH — dark cavity at head
  const mouthGeo = new THREE.SphereGeometry(
    D * 0.58,
    20,
    16,
    0,
    Math.PI * 0.9,
    Math.PI * 0.3,
    Math.PI * 0.5,
  );
  const mouthMat = new THREE.MeshBasicMaterial({
    color: 0x050309,
    side: THREE.DoubleSide,
  });
  const mouth = new THREE.Mesh(mouthGeo, mouthMat);
  mouth.position.set(D * 1.18, -D * 0.08, 0);
  mouth.rotation.set(-Math.PI / 2, 0, -0.1);
  group.add(mouth);

  // TEETH
  const teethMat = new THREE.MeshBasicMaterial({ color: 0xe8ecf5 });
  const teethGroup = new THREE.Group();
  const JAW_R = D * 0.62;
  const mouthAng = Math.PI * 0.9;
  const toothCount = 9;
  for (let i = 0; i < toothCount; i++) {
    const t = i / (toothCount - 1);
    const a = (t - 0.5) * mouthAng;
    const up = new THREE.Mesh(
      new THREE.ConeGeometry(0.04 * D, 0.22 * D * (1 - Math.abs(t - 0.5) * 0.6), 4),
      teethMat,
    );
    up.position.set(D * 1.3 + Math.cos(a) * 0.02, -D * 0.02, Math.sin(a) * JAW_R * 0.95);
    up.rotation.x = Math.PI;
    up.rotation.z = Math.sin(a) * 0.3;
    teethGroup.add(up);
    const lo = new THREE.Mesh(
      new THREE.ConeGeometry(0.035 * D, 0.18 * D * (1 - Math.abs(t - 0.5) * 0.6), 4),
      teethMat,
    );
    lo.position.set(D * 1.26 + Math.cos(a) * 0.02, -D * 0.2, Math.sin(a) * JAW_R * 0.9);
    lo.rotation.z = Math.sin(a) * 0.3;
    teethGroup.add(lo);
  }
  group.add(teethGroup);

  // Jaw ring
  const jawRing = new THREE.Mesh(
    new THREE.TorusGeometry(D * 0.55, 0.03 * D, 6, 24, Math.PI * 0.9),
    new THREE.MeshBasicMaterial({ color: 0x020308 }),
  );
  jawRing.position.set(D * 1.17, -D * 0.1, 0);
  jawRing.rotation.set(Math.PI / 2, 0, -Math.PI / 2);
  group.add(jawRing);

  // EYE
  const eyeSocket = new THREE.Mesh(
    new THREE.SphereGeometry(D * 0.14, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x02040a }),
  );
  eyeSocket.position.set(D * 0.85, D * 0.25, D * 0.48);
  group.add(eyeSocket);
  const eye = new THREE.Mesh(
    new THREE.SphereGeometry(D * 0.1, 16, 12),
    new THREE.ShaderMaterial({
      uniforms: { uCol: { value: new THREE.Color(pal.lure).multiplyScalar(1.3) } },
      vertexShader: `varying vec3 vN; varying vec3 vV;
        void main(){ vN = normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vV=-mv.xyz; gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `uniform vec3 uCol; varying vec3 vN; varying vec3 vV;
        void main(){ float f = pow(max(dot(normalize(vV), vN),0.0), 2.0); vec3 c = mix(vec3(0.01), uCol, f); gl_FragColor=vec4(c,1.0); }`,
    }),
  );
  eye.position.set(D * 0.88, D * 0.27, D * 0.56);
  group.add(eye);
  const eyeGlint = new THREE.Mesh(
    new THREE.SphereGeometry(D * 0.028, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  eyeGlint.position.set(D * 0.93, D * 0.32, D * 0.6);
  group.add(eyeGlint);

  // DORSAL SPINES
  const spineMat = new THREE.MeshBasicMaterial({ color: 0x04070f });
  for (let i = 0; i < 6; i++) {
    const u = i / 5;
    const spine = new THREE.Mesh(
      new THREE.ConeGeometry(0.04 * D, 0.22 * D * (1 - Math.abs(u - 0.5) * 0.8), 4),
      spineMat,
    );
    spine.position.set(
      D * (0.5 - u * 1.4),
      D * 0.92 + Math.sin(u * Math.PI) * 0.15 * D,
      0,
    );
    spine.rotation.z = 0;
    group.add(spine);
  }

  // PECTORAL FINS
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.lineTo(D * 0.9, D * 0.1);
  finShape.lineTo(D * 0.75, -D * 0.05);
  finShape.lineTo(D * 0.55, -D * 0.22);
  finShape.lineTo(D * 0.25, -D * 0.12);
  finShape.lineTo(0, 0);
  const finGeo = new THREE.ShapeGeometry(finShape);
  const finMat = new THREE.MeshBasicMaterial({
    color: 0x060a18,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
  });
  const pectL = new THREE.Mesh(finGeo, finMat);
  pectL.position.set(D * 0.2, -D * 0.15, D * 0.55);
  pectL.rotation.y = Math.PI / 2;
  pectL.rotation.z = -0.3;
  group.add(pectL);
  const pectR = pectL.clone();
  pectR.position.set(D * 0.2, -D * 0.15, -D * 0.55);
  pectR.rotation.y = -Math.PI / 2;
  pectR.rotation.z = -0.3;
  group.add(pectR);

  // PELVIC FIN
  const pelvicShape = new THREE.Shape();
  pelvicShape.moveTo(0, 0);
  pelvicShape.lineTo(D * 0.5, D * 0.05);
  pelvicShape.lineTo(D * 0.4, -D * 0.15);
  pelvicShape.lineTo(0, 0);
  const pelvicGeo = new THREE.ShapeGeometry(pelvicShape);
  const pelvic = new THREE.Mesh(pelvicGeo, finMat);
  pelvic.position.set(-D * 0.3, -D * 0.85, 0);
  pelvic.rotation.x = Math.PI / 2;
  pelvic.rotation.z = -0.4;
  group.add(pelvic);

  // TAIL + CAUDAL FAN
  const tailStub = new THREE.Mesh(
    new THREE.ConeGeometry(D * 0.25, D * 0.5, 12),
    bodyMat,
  );
  tailStub.position.set(-D * 1.45, 0, 0);
  tailStub.rotation.z = -Math.PI / 2;
  group.add(tailStub);

  const caudalShape = new THREE.Shape();
  caudalShape.moveTo(0, 0);
  caudalShape.lineTo(-D * 0.7, D * 0.55);
  caudalShape.lineTo(-D * 0.55, 0);
  caudalShape.lineTo(-D * 0.7, -D * 0.55);
  caudalShape.lineTo(0, 0);
  const caudalGeo = new THREE.ShapeGeometry(caudalShape);
  const caudal = new THREE.Mesh(caudalGeo, finMat);
  caudal.position.set(-D * 1.7, 0, 0);
  group.add(caudal);

  // LURE — curved illicium stalk
  const lureLen = D * 1.6;
  const arcPts: THREE.Vector3[] = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = D * 0.55 + Math.sin(t * Math.PI * 0.8) * lureLen * 0.55;
    const y = D * 0.95 + t * lureLen * 0.85 - Math.sin(t * Math.PI) * lureLen * 0.15;
    arcPts.push(new THREE.Vector3(x, y, 0));
  }
  const curve = new THREE.CatmullRomCurve3(arcPts);
  const tubeGeo = new THREE.TubeGeometry(curve, 32, 0.04 * D, 6, false);
  const tubeMat = new THREE.MeshBasicMaterial({
    color: 0x1a2740,
    transparent: true,
    opacity: 0.95,
  });
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  group.add(tube);

  const tipPos = arcPts[arcPts.length - 1].clone();

  const bulbCore = new THREE.Mesh(
    new THREE.SphereGeometry(0.11 * D, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  bulbCore.position.copy(tipPos);
  group.add(bulbCore);

  const bulbGlow = new THREE.Mesh(
    new THREE.SphereGeometry(0.3 * D, 20, 16),
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
        void main(){
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          vView = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uIntensity;
        varying vec3 vNormal; varying vec3 vView;
        void main(){
          float f = pow(1.0 - abs(dot(normalize(vView), vNormal)), 3.0);
          gl_FragColor = vec4(uColor * uIntensity, f);
        }`,
    }),
  );
  bulbGlow.position.copy(tipPos);
  group.add(bulbGlow);

  // Filaments from lure tip
  const filamentGroup = new THREE.Group();
  const filMat = new THREE.LineBasicMaterial({
    color: pal.lure,
    transparent: true,
    opacity: 0.75,
  });
  const filaments: Filament[] = [];
  for (let f = 0; f < 4; f++) {
    const segs = 8;
    const pts: THREE.Vector3[] = [];
    const baseAng = (f / 4) * Math.PI * 2;
    for (let s = 0; s <= segs; s++) {
      const u = s / segs;
      const x = Math.cos(baseAng) * u * 0.18 * D;
      const y = -u * 0.6 * D;
      const z = Math.sin(baseAng) * u * 0.18 * D;
      pts.push(new THREE.Vector3(x, y, z));
    }
    const lg = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(lg, filMat);
    line.position.copy(tipPos);
    filamentGroup.add(line);
    const bead = new THREE.Mesh(
      new THREE.SphereGeometry(0.03 * D, 8, 6),
      new THREE.MeshBasicMaterial({
        color: pal.lure,
        transparent: true,
        opacity: 0.9,
      }),
    );
    bead.position.copy(tipPos).add(pts[pts.length - 1]);
    filamentGroup.add(bead);
    filaments.push({ line, pts, baseAng });
  }
  group.add(filamentGroup);

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
  halo.scale.set(2.2 * D, 2.2 * D, 1);
  halo.position.copy(tipPos);
  group.add(halo);

  const light = new THREE.PointLight(pal.lure, 1.4 * glow, 10, 2);
  light.position.copy(tipPos);
  group.add(light);

  // tilt fish slightly so the camera catches the profile nicely
  group.rotation.x = -0.05;

  const userData: NodeUser = {
    domain: company.domain,
    displayName: company.name,
    body,
    bodyMat,
    halo,
    bulbCore,
    bulbGlow,
    light,
    tube,
    tubeMat,
    eye,
    eyeGlint,
    teethGroup,
    caudal,
    pectL,
    pectR,
    pelvic,
    tailStub,
    filaments,
    filamentGroup,
    tipPos: tipPos.clone(),
    bobPhase: Math.random() * Math.PI * 2,
    bobFreq: 0.4 + Math.random() * 0.3,
    bobAmp: 0.15 + Math.random() * 0.2,
    spinOffset: Math.random() * 0.4 - 0.2,
    home: pos.clone(),
    diameter,
    fishYaw,
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
    nextSpiralIndex: number;
    selectedDomain: string | null;
    animFrame: number | null;
    clock: THREE.Clock;
    glow: number;
  } | null>(null);

  // ---- init (run once) ----
  useEffect(() => {
    if (!canvasRef.current || !hostRef.current) return;
    const pal = ZONE_PALETTES.sunlit;
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
      camRadius: 34,
      camRadiusTarget: 34,
      nextSpiralIndex: 0,
      selectedDomain: null,
      animFrame: null,
      clock: new THREE.Clock(),
      glow: 2.1,
    };

    // resize
    const resize = () => {
      if (!hostRef.current || !worldRef.current) return;
      const w = hostRef.current.clientWidth;
      const h = hostRef.current.clientHeight;
      worldRef.current.renderer.setSize(w, h, false);
      worldRef.current.camera.aspect = w / h;
      worldRef.current.camera.updateProjectionMatrix();
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

      // node bob + lure pulse + fin/tail/filament animation
      w.nodes.forEach((g) => {
        const u = g.userData as NodeUser;
        g.position.y = u.home.y + Math.sin(t * u.bobFreq + u.bobPhase) * u.bobAmp;
        g.position.x = u.home.x + Math.cos(t * u.bobFreq * 0.7 + u.bobPhase) * u.bobAmp * 0.5;
        g.position.z = u.home.z + Math.sin(t * u.bobFreq * 0.5 + u.bobPhase) * u.bobAmp * 0.3;
        g.rotation.y = u.fishYaw + Math.sin(t * 0.3 + u.bobPhase) * 0.15 + u.spinOffset;
        // tail swish
        u.caudal.rotation.y = Math.sin(t * 2.0 + u.bobPhase) * 0.35;
        u.tailStub.rotation.x = Math.sin(t * 2.0 + u.bobPhase) * 0.15;
        // pectoral fin flap
        u.pectL.rotation.z = -0.3 + Math.sin(t * 1.4 + u.bobPhase) * 0.15;
        u.pectR.rotation.z = -0.3 + Math.sin(t * 1.4 + u.bobPhase + Math.PI) * 0.15;
        // filament sway
        u.filaments.forEach((f, fi) => {
          const g2 = f.line.geometry.attributes.position as THREE.BufferAttribute;
          for (let s = 0; s < f.pts.length; s++) {
            const u2 = s / (f.pts.length - 1);
            const sway = Math.sin(t * 1.2 + fi + u2 * 3) * 0.08 * u.diameter;
            g2.setX(s, f.pts[s].x + sway * Math.cos(f.baseAng));
            g2.setZ(s, f.pts[s].z + sway * Math.sin(f.baseAng));
          }
          g2.needsUpdate = true;
        });
        u.bodyMat.uniforms.uTime.value = t;
        const pulse = 0.85 + 0.35 * Math.sin(t * 1.6 + u.bobPhase * 2);
        (u.bulbGlow.material as THREE.ShaderMaterial).uniforms.uIntensity.value =
          pulse * w.glow * 1.4;
        (u.halo.material as THREE.SpriteMaterial).opacity = Math.min(
          1,
          (0.55 + 0.35 * pulse) * w.glow,
        );
        u.light.intensity = pulse * 1.4 * w.glow;
      });

      // edges (ribbon geometry + flowing-gradient shader + midpoint plaque)
      const sel = w.selectedDomain;
      const up = new THREE.Vector3(0, 0, 1);
      w.edgeObjs.forEach((eo) => {
        // Skip degenerate edges: self-loops (both endpoints map to the same
        // domain — happens when entity resolution collides, e.g. "AWS" and
        // "AWS AI Services" both resolving to aws.amazon.com) or edges whose
        // endpoints have collapsed onto the same position. Either case makes
        // the perp/side vectors zero-length and poisons the ribbon geometry
        // with NaN, which three.js surfaces as a noisy computeBoundingSphere
        // warning every frame.
        if (eo.aDomain === eo.bDomain) return;
        const a = eo.a.position;
        const b = eo.b.position;
        if (a.distanceToSquared(b) < 1e-6) return;

        const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
        const dir = new THREE.Vector3().subVectors(b, a);
        const perpRaw = new THREE.Vector3(-dir.y, dir.x, 0);
        const perp = perpRaw.lengthSq() > 1e-8
          ? perpRaw.normalize()
          : new THREE.Vector3(1, 0, 0);
        mid.add(perp.multiplyScalar(eo.curveOffset * 0.5));
        mid.z += 1.2 + eo.curveOffset * 0.3;
        const curve = new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
        eo.curve = curve;

        const ribbonWidth = 0.22 + eo.conf * 0.22;
        const rv = eo.ribbonVerts;
        for (let i = 0; i <= EDGE_SEGS; i++) {
          const tt = i / EDGE_SEGS;
          const p = curve.getPoint(tt);
          const tan = curve.getTangent(tt);
          const sideRaw = new THREE.Vector3().crossVectors(tan, up);
          const side = sideRaw.lengthSq() > 1e-8
            ? sideRaw.normalize()
            : new THREE.Vector3(1, 0, 0);
          // Flare the tape toward the midpoint so ends taper to a point.
          const ww = ribbonWidth * Math.sin(tt * Math.PI);
          rv[i * 6 + 0] = p.x + side.x * ww;
          rv[i * 6 + 1] = p.y + side.y * ww;
          rv[i * 6 + 2] = p.z + side.z * ww;
          rv[i * 6 + 3] = p.x - side.x * ww;
          rv[i * 6 + 4] = p.y - side.y * ww;
          rv[i * 6 + 5] = p.z - side.z * ww;
        }
        eo.ribbonGeom.attributes.position.needsUpdate = true;
        eo.ribbonGeom.computeBoundingSphere();

        const isSel =
          sel !== null && (eo.aDomain === sel || eo.bDomain === sel);
        const dim = sel && !isSel ? 0.3 : 1;
        eo.ribbonMat.uniforms.uTime.value = t + eo.phase;
        eo.ribbonMat.uniforms.uSelected.value = isSel ? 1 : 0;
        eo.ribbonMat.opacity = dim; // actual alpha is driven by the shader
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
    const pal = ZONE_PALETTES.sunlit;
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

    // Place new nodes on a stable Fibonacci spiral using a monotonically-increasing
    // counter that persists across expansions. Existing nodes never move (their
    // userData.home is set once at insertion). Using a fixed VIRTUAL_TOTAL instead
    // of the current count prevents new nodes from colliding with old ones — each
    // new node just takes the next slot on a large, sparse spiral.
    const VIRTUAL_TOTAL = 24;
    const ordered = Object.values(companies).sort((a, b) =>
      a.domain.localeCompare(b.domain),
    );
    ordered.forEach((c) => {
      if (w.nodes.has(c.domain)) return;
      const spiralIdx = w.nextSpiralIndex++;
      const pos = randSpherePosition(spiralIdx, VIRTUAL_TOTAL);
      const g = createAnglerfishNode(c, pos, spiralIdx, pal, w.glow);
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
      w.edgesGroup.remove(eo.ribbon);
      eo.ribbonGeom.dispose();
      eo.ribbonMat.dispose();
    });
    w.edgeObjs = [];

    // Build a name → domain resolver from the current companies prop so we can
    // translate SSE edges (which use display names) back to the node keys (domains).
    const nameToDomain = new Map<string, string>();
    Object.values(companies).forEach((c) => nameToDomain.set(c.name, c.domain));

    edges.forEach((edge) => {
      const aDomain = nameToDomain.get(edge.source);
      const bDomain = nameToDomain.get(edge.target);
      if (!aDomain || !bDomain) return;
      const a = w.nodes.get(aDomain);
      const b = w.nodes.get(bDomain);
      if (!a || !b) return;

      const color = EDGE_COLOR_NUM[edge.type];
      const color3 = new THREE.Color(color);
      const conf =
        edge.confidence === "high" ? 1 : edge.confidence === "medium" ? 0.65 : 0.38;

      // Flat ribbon: (EDGE_SEGS+1) pairs of verts, one above/below the curve.
      const ribbonGeom = new THREE.BufferGeometry();
      const ribbonVerts = new Float32Array((EDGE_SEGS + 1) * 2 * 3);
      const ribbonUV = new Float32Array((EDGE_SEGS + 1) * 2 * 2);
      const ribbonIdx: number[] = [];
      for (let i = 0; i < EDGE_SEGS; i++) {
        const a0 = i * 2;
        const b0 = i * 2 + 1;
        const a1 = (i + 1) * 2;
        const b1 = (i + 1) * 2 + 1;
        ribbonIdx.push(a0, b0, b1, a0, b1, a1);
      }
      for (let i = 0; i <= EDGE_SEGS; i++) {
        const u = i / EDGE_SEGS;
        ribbonUV[i * 4 + 0] = u;
        ribbonUV[i * 4 + 1] = 0;
        ribbonUV[i * 4 + 2] = u;
        ribbonUV[i * 4 + 3] = 1;
      }
      ribbonGeom.setAttribute(
        "position",
        new THREE.BufferAttribute(ribbonVerts, 3),
      );
      ribbonGeom.setAttribute("uv", new THREE.BufferAttribute(ribbonUV, 2));
      ribbonGeom.setIndex(ribbonIdx);

      const ribbonMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: color3.clone() },
          uTime: { value: 0 },
          uConf: { value: conf },
          uSelected: { value: 0 },
        },
        vertexShader: `
          varying vec2 vUV;
          void main(){
            vUV = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 uColor; uniform float uTime; uniform float uConf; uniform float uSelected;
          varying vec2 vUV;
          void main(){
            float edge = smoothstep(0.0, 0.4, vUV.y) * smoothstep(1.0, 0.6, vUV.y);
            float flow = sin((vUV.x - uTime*0.15)*18.0)*0.5 + 0.5;
            flow = pow(flow, 2.5);
            float taper = smoothstep(0.0, 0.12, vUV.x) * smoothstep(1.0, 0.88, vUV.x);
            float a = edge * taper * (0.18 + 0.55 * flow * (0.35 + uConf*0.65));
            a *= (1.0 + uSelected * 1.4);
            vec3 c = uColor * (0.7 + 0.6 * flow);
            gl_FragColor = vec4(c, a);
          }`,
      });
      const ribbon = new THREE.Mesh(ribbonGeom, ribbonMat);
      w.edgesGroup.add(ribbon);

      w.edgeObjs.push({
        edge,
        a,
        b,
        aDomain,
        bDomain,
        ribbon,
        ribbonGeom,
        ribbonMat,
        ribbonVerts,
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
    </div>
  );
}


import * as THREE from 'three';

/**
 * Cheap contact shadow ("blob"): a soft radial-gradient decal under feet.
 * Grounds characters/NPCs/props on every preset — including LOW, where real shadows are off.
 * One shared texture + material for the whole game.
 */
let mat: THREE.MeshBasicMaterial | null = null;
let geo: THREE.PlaneGeometry | null = null;

export function blobMaterial(): THREE.MeshBasicMaterial {
  if (mat) return mat;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.28)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: true });
  return mat;
}

/** Unit plane lying on the ground (diameter 1). */
export function blobGeometry(): THREE.PlaneGeometry {
  if (!geo) geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  return geo;
}

export function blobMesh(diameter: number): THREE.Mesh {
  const m = new THREE.Mesh(blobGeometry(), blobMaterial());
  m.scale.setScalar(diameter);
  m.position.y = 0.03;
  m.renderOrder = -1;
  return m;
}

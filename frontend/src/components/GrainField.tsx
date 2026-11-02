import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

const GrainField = () => {
  const mountRef = useRef<HTMLDivElement>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch (error) {
      console.warn('3D login background is unavailable:', error);
      setUnavailable(true);
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 3.2, 8.5);
    camera.lookAt(0, 0, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const terrainGeometry = new THREE.PlaneGeometry(15, 11, 40, 30);
    const positions = terrainGeometry.getAttribute('position');
    for (let index = 0; index < positions.count; index += 1) {
      const x = positions.getX(index);
      const y = positions.getY(index);
      const ridge = Math.sin(x * 0.72) * 0.26 + Math.cos(y * 0.58) * 0.17;
      const hill = Math.max(0, 1 - Math.hypot(x + 2.4, y - 0.6) / 5.2) * 0.68;
      positions.setZ(index, ridge + hill);
    }
    positions.needsUpdate = true;
    terrainGeometry.computeVertexNormals();

    const terrain = new THREE.Mesh(
      terrainGeometry,
      new THREE.MeshStandardMaterial({
        color: '#48794d',
        flatShading: true,
        roughness: 0.94,
        transparent: true,
        opacity: 0.82,
      }),
    );
    terrain.rotation.x = -Math.PI / 2.45;
    terrain.position.set(0, -0.5, -1.7);
    scene.add(terrain);

    const seedGeometry = new THREE.IcosahedronGeometry(0.055, 0);
    const seedMaterial = new THREE.MeshStandardMaterial({
      color: '#F59E0B',
      flatShading: true,
      roughness: 0.8,
    });
    const seedField = new THREE.Group();
    for (let index = 0; index < 85; index += 1) {
      const seed = new THREE.Mesh(seedGeometry, seedMaterial);
      const x = ((index * 37) % 120) / 10 - 6;
      const z = ((index * 61) % 90) / 10 - 4.5;
      seed.position.set(x, Math.sin(x * 0.7) * 0.12 + 0.1, z);
      seed.scale.setScalar(0.7 + ((index * 13) % 7) / 10);
      seedField.add(seed);
    }
    scene.add(seedField);
    scene.add(new THREE.AmbientLight('#e5f1dd', 2));
    const light = new THREE.DirectionalLight('#fff0c2', 2.2);
    light.position.set(-3, 7, 5);
    scene.add(light);

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    const renderFrame = () => {
      if (!reducedMotion) {
        seedField.rotation.y += 0.0007;
        terrain.rotation.z = Math.sin(performance.now() * 0.00008) * 0.008;
      }
      renderer.render(scene, camera);
      if (!reducedMotion) frame = window.requestAnimationFrame(renderFrame);
    };
    renderFrame();

    const resizeObserver = new ResizeObserver(() => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    });
    resizeObserver.observe(mount);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      terrainGeometry.dispose();
      seedGeometry.dispose();
      seedMaterial.dispose();
      terrain.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      className={`grain-field${unavailable ? ' grain-field-fallback' : ''}`}
      aria-hidden="true"
    />
  );
};

export default GrainField;

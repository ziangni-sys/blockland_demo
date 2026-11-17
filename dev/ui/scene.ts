/**
 * Fake "3D view" behind the UI in the harness: a bright daytime voxel landscape painted with
 * canvas 2D, so HUD contrast can be judged over a realistic (and deliberately busy) image.
 */
export function paintScene(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return;
  const sky = g.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#4f8fd6');
  sky.addColorStop(1, '#cfe6f7');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255, 250, 220, 0.95)';
  g.beginPath();
  g.arc(w * 0.78, h * 0.16, h * 0.05, 0, Math.PI * 2);
  g.fill();
  // Clouds: blocky slabs.
  g.fillStyle = 'rgba(255, 255, 255, 0.85)';
  const u = Math.max(8, Math.round(h / 40));
  for (const [cx, cy, n] of [[0.18, 0.12, 7], [0.5, 0.2, 5], [0.86, 0.3, 6]] as const) {
    for (let i = 0; i < n; i++) g.fillRect(w * cx + i * u * 1.6, h * cy + ((i * 7) % 3) * u * 0.4, u * 2.2, u * 0.9);
  }
  // Hills: stepped voxel silhouettes.
  const hills = [
    { y: 0.5, amp: 0.08, col: '#7aa36a', seed: 1 },
    { y: 0.58, amp: 0.06, col: '#5f9e45', seed: 2 },
  ];
  for (const hl of hills) {
    g.fillStyle = hl.col;
    for (let x = 0; x < w; x += u) {
      const t = x / w;
      const yy = h * (hl.y - hl.amp * Math.abs(Math.sin(t * 6.3 * hl.seed + hl.seed)) * (0.6 + 0.4 * Math.sin(t * 17)));
      g.fillRect(x, Math.round(yy / u) * u, u + 1, h);
    }
  }
  // Water band and a beach.
  g.fillStyle = '#2f6fb0';
  g.fillRect(0, h * 0.7, w, h * 0.3);
  g.fillStyle = 'rgba(255, 255, 255, 0.25)';
  for (let i = 0; i < 40; i++) g.fillRect(((i * 997) % w), h * 0.72 + ((i * 131) % Math.floor(h * 0.26)), u * 1.5, 2 * dpr);
  g.fillStyle = '#dccb8f';
  g.fillRect(0, h * 0.66, w * 0.45, h * 0.05);
  // A little raft with a windmill (the game's subject) in the middle distance.
  const rx = w * 0.55;
  const ry = h * 0.69;
  g.fillStyle = '#b98d55';
  g.fillRect(rx, ry - u, u * 8, u);
  g.fillStyle = '#6d4f2e';
  g.fillRect(rx + u * 3.5, ry - u * 6, u, u * 5);
  g.fillStyle = '#e8dcc0';
  g.fillRect(rx + u * 4, ry - u * 9, u * 0.8, u * 3);
  g.fillRect(rx + u * 1.3, ry - u * 6, u * 2.2, u * 0.8);
  g.fillRect(rx + u * 3.2, ry - u * 5.2, u * 0.8, u * 3);
  g.fillRect(rx + u * 4.5, ry - u * 6.6, u * 2.4, u * 0.8);
}

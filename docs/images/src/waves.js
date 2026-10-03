// Deterministic voice-note waveforms.
document.querySelectorAll('.wave').forEach((w, k) => {
  let seed = 7 + k * 13
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280)
  for (let i = 0; i < (+w.dataset.n || 30); i++) {
    const bar = document.createElement('i')
    bar.style.height = 4 + Math.round(Math.abs(Math.sin(i / 3 + k)) * 12 + rnd() * 9) + 'px'
    w.appendChild(bar)
  }
})

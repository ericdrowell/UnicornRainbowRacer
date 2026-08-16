// Sonant-X instrument definitions. Waveforms: 0 sin, 1 square, 2 saw, 3 tri.
// Envelope times are in samples at 44100.
const base = {
  osc1_oct: 8, osc1_det: 0, osc1_detune: 0, osc1_xenv: 0, osc1_vol: 0, osc1_waveform: 1,
  osc2_oct: 8, osc2_det: 0, osc2_detune: 0, osc2_xenv: 0, osc2_vol: 0, osc2_waveform: 1,
  noise_fader: 0, env_attack: 50, env_sustain: 1000, env_release: 3000, env_master: 100,
  fx_filter: 0, fx_freq: 11025, fx_resonance: 255, fx_delay_time: 0, fx_delay_amt: 0,
  fx_pan_freq: 0, fx_pan_amt: 0, lfo_osc1_freq: 0, lfo_fx_freq: 0, lfo_freq: 0, lfo_amt: 0, lfo_waveform: 0,
};
export const INSTRUMENTS = {
  // Fat detuned square, an octave doubled — the classic chiptune bass.
  bass: { ...base, osc1_oct: 7, osc1_vol: 200, osc1_waveform: 1,
    osc2_oct: 7, osc2_det: 0, osc2_detune: 6, osc2_vol: 170, osc2_waveform: 2,
    env_attack: 30, env_sustain: 2600, env_release: 3800, env_master: 120,
    fx_filter: 2, fx_freq: 2400, fx_resonance: 170 },
  // Lead: a detuned pair of squares, bright and forward. Three quarters of the
  // line sits above C6, which is a lot of top end — see the mellow variant in
  // the notes if it reads as shrill on real speakers.
  lead: { ...base, osc1_oct: 8, osc1_vol: 165, osc1_waveform: 1,
    osc2_oct: 8, osc2_det: 0, osc2_detune: 10, osc2_vol: 110, osc2_waveform: 1,
    env_attack: 20, env_sustain: 1800, env_release: 5200, env_master: 96,
    fx_filter: 2, fx_freq: 8600, fx_resonance: 120,
    fx_delay_time: 3, fx_delay_amt: 60, fx_pan_freq: 5, fx_pan_amt: 70 },
  // Softer triangle underneath, for chords and counter-lines.
  harmony: { ...base, osc1_oct: 8, osc1_vol: 130, osc1_waveform: 3,
    osc2_oct: 8, osc2_det: -12, osc2_detune: 4, osc2_vol: 80, osc2_waveform: 1,
    env_attack: 180, env_sustain: 2200, env_release: 6000, env_master: 74,
    fx_filter: 2, fx_freq: 5200, fx_resonance: 130,
    fx_pan_freq: 4, fx_pan_amt: 110 },
  // Kick: a sine whose pitch collapses with the envelope.
  kick: { ...base, osc1_oct: 4, osc1_vol: 255, osc1_waveform: 0, osc1_xenv: 1,
    env_attack: 8, env_sustain: 200, env_release: 3400, env_master: 205,
    fx_filter: 2, fx_freq: 1200, fx_resonance: 200 },
  // Snare: noise plus a little body.
  snare: { ...base, osc1_oct: 6, osc1_vol: 90, osc1_waveform: 0, osc1_xenv: 1,
    noise_fader: 130, env_attack: 6, env_sustain: 350, env_release: 2600, env_master: 150,
    fx_filter: 1, fx_freq: 1900, fx_resonance: 60 },
  // Hat: brief bright noise.
  hat: { ...base, osc1_vol: 0, noise_fader: 90,
    env_attack: 4, env_sustain: 80, env_release: 700, env_master: 96,
    fx_filter: 1, fx_freq: 8200, fx_resonance: 40, fx_pan_freq: 6, fx_pan_amt: 120 },
};

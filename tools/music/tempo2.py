import warnings, json, numpy as np, librosa
warnings.filterwarnings('ignore')
D='stems4/htdemucs/The 8-bit Round (Short)/'
y,sr=librosa.load(D+'drums.wav', sr=22050, mono=True)
tempo,beats=librosa.beat.beat_track(y=y, sr=sr, trim=False)
bt=librosa.frames_to_time(beats, sr=sr)
print(f'librosa on the DRUM stem: {float(np.atleast_1d(tempo)[0]):.2f} bpm, {len(bt)} beats')
if len(bt)>2:
    d=np.diff(bt); print(f'  beat spacing median {np.median(d)*1000:.0f}ms -> {60/np.median(d):.2f} bpm')
    print(f'  first beats: '+' '.join(f'{t:.3f}' for t in bt[:8]))
# Independent: onset envelope + tempogram
oenv=librosa.onset.onset_strength(y=y, sr=sr)
tg=librosa.feature.tempogram(onset_envelope=oenv, sr=sr)
ac=librosa.autocorrelate(oenv, max_size=len(oenv)//2)
cands=librosa.beat.tempo(onset_envelope=oenv, sr=sr, aggregate=None)
print(f'  per-frame tempo estimates: median {np.median(cands):.1f}, 25-75% {np.percentile(cands,25):.1f}-{np.percentile(cands,75):.1f}')

# Now fit BOTH tempo and phase directly to Basic Pitch's note onsets, which are
# the times we actually have to hit.
bp=json.load(open('bp-notes.json'))
onsets=np.array(sorted([n[0] for n in bp['bass']]+[n[0] for n in bp['other']]))
best=None
for bpm in np.arange(60,200,0.05):
    step=60/bpm/4
    # optimal phase via circular mean of onsets mod step
    ang=2*np.pi*(onsets%step)/step
    ph=(np.angle(np.mean(np.exp(1j*ang)))/(2*np.pi))*step
    k=(onsets-ph)/step
    err=np.mean(np.abs(k-np.round(k)))
    if best is None or err<best[0]: best=(err,bpm,ph%step)
print(f'\nfit to Basic Pitch onsets: {best[1]:.2f} bpm, phase {best[2]:.4f}s, mean offset {best[0]:.3f} of a 16th')
for bpm in [best[1]/2, best[1], best[1]*2, 135.0]:
    step=60/bpm/4
    ang=2*np.pi*(onsets%step)/step
    ph=(np.angle(np.mean(np.exp(1j*ang)))/(2*np.pi))*step
    k=(onsets-ph)/step
    print(f'   {bpm:7.2f} bpm -> offset {np.mean(np.abs(k-np.round(k))):.3f}   rowLen {round(60*44100/4/bpm)}')

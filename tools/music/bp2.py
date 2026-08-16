import warnings, json, numpy as np
warnings.filterwarnings('ignore')
from basic_pitch.inference import predict
D = 'stems4/htdemucs/The 8-bit Round (Short)/'
NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
nm=lambda m: NAMES[m%12]+str(m//12-1)
out={}
for stem, kw in [('bass', dict(onset_threshold=0.4, frame_threshold=0.25, minimum_note_length=120)),
                 ('other', dict(onset_threshold=0.6, frame_threshold=0.4, minimum_note_length=120))]:
    _, _, notes = predict(D+stem+'.wav', **kw)
    ns = sorted([(float(a),float(b),int(p),float(amp)) for a,b,p,amp,*_ in notes], key=lambda n:n[0])
    out[stem]=ns
    if not ns:
        print(f'{stem}: NO NOTES'); continue
    d=np.array([n[1]-n[0] for n in ns]); p=np.array([n[2] for n in ns])
    print(f'{stem}: {len(ns)} notes, {len(ns)/88:.2f}/s, median {np.median(d)*1000:.0f}ms, midi {p.min()}-{p.max()}, {len(set(p.tolist()))} distinct')
    # pitch-class histogram, to read the key
    pc=np.zeros(12)
    for a,b,q,amp in ns: pc[q%12]+=(b-a)
    top=np.argsort(-pc)[:7]
    print('   most-used pitch classes: '+' '.join(NAMES[i] for i in top))
    print('   first bars: '+' '.join(f'{n[0]:.2f}:{nm(n[2])}' for n in ns[:12]))
json.dump(out, open('bp-notes.json','w'))
print('\nwrote bp-notes.json')

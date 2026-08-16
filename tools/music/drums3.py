import warnings, json, numpy as np, librosa
warnings.filterwarnings('ignore')
D='stems4/htdemucs/The 8-bit Round (Short)/'
y,sr=librosa.load(D+'drums.wav', sr=22050, mono=True)
BPM=135.0; ROW=60/BPM/4; ROWS=792; CYCLE=32; PHASE=0.0283
on=librosa.onset.onset_detect(y=y, sr=sr, backtrack=True, units='time', hop_length=128,
                              pre_max=3, post_max=3, delta=0.08, wait=2)
feat=[]
for t in on:
    i=int(t*sr); seg=y[i:i+int(0.04*sr)]
    if len(seg)<256: feat.append((0,0,0)); continue
    S=np.abs(np.fft.rfft(seg*np.hanning(len(seg)))); f=np.fft.rfftfreq(len(seg),1/sr)
    tot=S.sum()+1e-9
    feat.append((float((S*f).sum()/tot), float(S[f<250].sum()/tot), float(np.abs(seg).max())))
feat=np.array(feat); cent, low, amp = feat[:,0], feat[:,1], feat[:,2]
print('low-band ratio percentiles: '+' '.join(f'{p}%:{np.percentile(low,p):.2f}' for p in [10,25,50,75,90]))
print('centroid  percentiles: '+' '.join(f'{p}%:{np.percentile(cent,p):.0f}' for p in [10,25,50,75,90]))
# Thirds by timbre: lowest = kick, highest = hat, middle = snare.
kick = low >= np.percentile(low, 70)
hat  = (~kick) & (cent >= np.percentile(cent[~kick], 62))
snare= (~kick) & (~hat)
print(f'kick {kick.sum()}  snare {snare.sum()}  hat {hat.sum()}')

rows_all = np.round((on-PHASE)/ROW).astype(int)
# Rotate the 2-bar window so the kick lands on beat one.
def fold(mask, cyc=CYCLE):
    r=rows_all[mask]; r=r[(r>=0)&(r<ROWS)]
    c=np.zeros(cyc)
    for x in r: c[x%cyc]+=1
    return c
kc=fold(kick)
rot=0  # keep absolute rows: notes and drums must share one origin
print('kick fold: '+' '.join(str(int(v)) for v in kc))
out={'phase':float(PHASE),'origin':rot}
passes=ROWS//CYCLE
for name,mask in [('kick',kick),('snare',snare),('hat',hat)]:
    c=fold(mask); keep=[bool(c[(i+rot)%CYCLE] >= max(2, passes*0.30)) for i in range(CYCLE)]
    out[name]=keep
    print(f'  {name:6s} '+''.join('X' if k else '.' for k in keep)+f'  ({sum(keep)} per 2 bars)')
json.dump(out, open('drumloop.json','w'))

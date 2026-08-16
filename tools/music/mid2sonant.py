# MIDI -> Sonant-X.
#
# The note data is already exact, so nothing here infers anything: tracks map
# onto channels, seconds onto rows, and each channel's envelope is fitted to how
# long that part's notes actually are — a pad and a lead want very different
# ones, and using a single envelope for both is what makes a conversion sound
# like a machine playing rather than an arrangement.
import warnings, json, sys, numpy as np, pretty_midi
warnings.filterwarnings('ignore')
src, out = sys.argv[1], sys.argv[2]
LIMIT = float(sys.argv[3]) if len(sys.argv)>3 else None   # seconds to keep
pm = pretty_midi.PrettyMIDI(src)
tempi = pm.get_tempo_changes()[1]
BPM = float(np.median(tempi)) if len(tempi) else 120.0
ROW = 60/BPM/4
ROW_LEN = int(round(60*44100/4/BPM))
END = min(pm.get_end_time(), LIMIT) if LIMIT else pm.get_end_time()
ROWS = int(np.ceil(np.ceil(END/ROW)/32)*32)
print(f'{src}\n  {BPM:.0f}bpm  keeping {END:.0f}s of {pm.get_end_time():.0f}s  ->  {ROWS} rows, {ROWS//32} patterns, rowLen {ROW_LEN}')

def clip(inst):
    inst.notes=[n for n in inst.notes if n.start < END]
    return inst
for _i in pm.instruments: clip(_i)
pitched=[i for i in pm.instruments if i.notes and not i.is_drum]
drumtracks=[i for i in pm.instruments if i.notes and i.is_drum]

def rows_of(inst):
    """Highest note per row. Sonant channels are monophonic; on a chord track
    the top note is the one carrying the line."""
    r=[0]*ROWS
    for n in inst.notes:
        k=int(round(n.start/ROW))
        if 0<=k<ROWS and n.pitch+75>r[k]: r[k]=n.pitch+75
    return r

# GM programme numbers say what a part is meant to be; register breaks ties.
def role_of(inst):
    p, avg = inst.program, np.mean([n.pitch for n in inst.notes])
    if 32<=p<=39 or avg<48: return 'bass'
    if 80<=p<=87: return 'lead'
    if 48<=p<=55 or 88<=p<=95: return 'pad'
    return 'harm'

def envelope(inst):
    """Attack/sustain/release in samples, from this part's own note lengths."""
    d=np.median([n.end-n.start for n in inst.notes])
    sus=int(np.clip(d*44100*0.55, 120, 40000))
    rel=int(np.clip(d*44100*0.9, 900, 60000))
    return sus, rel

def sq(o1,v1,o2,v2,det,A,S,R,M,filt=0,ff=11025,res=0,dt=0,da=0,pf=0,pa=0,w1=1,w2=1):
    return dict(osc1_oct=o1,osc1_det=0,osc1_detune=0,osc1_xenv=0,osc1_vol=v1,osc1_waveform=w1,
      osc2_oct=o2,osc2_det=0,osc2_detune=det,osc2_xenv=0,osc2_vol=v2,osc2_waveform=w2,
      noise_fader=0,env_attack=A,env_sustain=S,env_release=R,env_master=M,
      fx_filter=filt,fx_freq=ff,fx_resonance=res,fx_delay_time=dt,fx_delay_amt=da,
      fx_pan_freq=pf,fx_pan_amt=pa,lfo_osc1_freq=0,lfo_fx_freq=0,lfo_freq=0,lfo_amt=0,lfo_waveform=0)
BASE={
 'bass': lambda S,R: sq(7,215,7,150,6, 15,S,R,140, filt=2,ff=2600,res=120),
 'lead': lambda S,R: sq(8,225,9,110,12, 10,S,R,150, dt=6,da=60,pf=5,pa=50),
 'harm': lambda S,R: sq(8,150,8, 95, 9, 25,S,R,105, pf=4,pa=85),
 'pad':  lambda S,R: sq(7,120,8, 90, 7,900,S,R, 80, filt=2,ff=4200,res=90,pf=3,pa=110),
}
REF=json.load(open('reference-song.json'))['songData']
strip=lambda d:{k:v for k,v in d.items() if k not in ('p','c')}
KIT={'kick':strip(REF[3]),'snare':strip(REF[6]),'hat':strip(REF[2])}

KICK={35,36,41,43}; SNARE={37,38,39,40}
kick=[0]*ROWS; snare=[0]*ROWS; hat=[0]*ROWS
for d in drumtracks:
    for n in d.notes:
        k=int(round(n.start/ROW))
        if not (0<=k<ROWS): continue
        if n.pitch in KICK: kick[k]=147
        elif n.pitch in SNARE: snare[k]=147
        else: hat[k]=147

def patternise(rows):
    c=[];p=[];seen={}
    for i in range(ROWS//32):
        n=rows[i*32:(i+1)*32]
        if not any(n): p.append(0); continue
        t=tuple(n)
        if t not in seen: c.append({'n':n}); seen[t]=len(c)
        p.append(seen[t])
    return p,c

# Choosing which tracks get a channel.
#
# Not simply the busiest: a square lead can be sparse and still be the tune,
# and dropping it for a dense inner voice guts the arrangement. So the bass and
# the lead are claimed by role first, and only then is the rest filled by
# activity.
def signature(inst):
    return tuple((round(n.start,3), n.pitch) for n in sorted(inst.notes, key=lambda x:(x.start,x.pitch))[:400])
seen_sig=set(); uniq=[]
for inst in pitched:
    sg=signature(inst)
    if sg in seen_sig:
        print(f'  (skipping "{inst.name.strip()[:16]}" prog{inst.program} — same notes as a track already taken)')
        continue
    seen_sig.add(sg); uniq.append(inst)

def is_bass(i): return 32<=i.program<=39 or np.mean([n.pitch for n in i.notes])<48
def is_lead(i): return 80<=i.program<=87

chosen=[]
bass_c=[i for i in uniq if is_bass(i)]
if bass_c: chosen.append((max(bass_c,key=lambda i:len(i.notes)),'bass'))
lead_c=[i for i in uniq if is_lead(i) and i not in [c[0] for c in chosen]]
if not lead_c:
    rest=[i for i in uniq if i not in [c[0] for c in chosen]]
    lead_c=[max(rest,key=lambda i:np.mean([n.pitch for n in i.notes]))] if rest else []
if lead_c: chosen.append((max(lead_c, key=lambda i: len(i.notes)), 'lead'))
rest=[i for i in uniq if i not in [c[0] for c in chosen]]
rest.sort(key=lambda i:-len(i.notes))
for inst in rest:
    if len(chosen)>=5: break
    chosen.append((inst, 'pad' if (48<=inst.program<=55 and np.median([n.end-n.start for n in inst.notes])>0.4) else 'harm'))

used=[]; channels=[]
for inst,role in chosen:
    S,R=envelope(inst)
    p,c=patternise(rows_of(inst))
    channels.append({**BASE[role](S,R),'p':p,'c':c})
    print(f'  ch{len(channels)-1}: {role:5s} <- "{inst.name.strip()[:16]}" prog{inst.program:<3d} {len(inst.notes):5d} notes  sustain {S} release {R}')
for name,rows in [('kick',kick),('snare',snare),('hat',hat)]:
    if not any(rows): continue
    p,c=patternise(rows)
    channels.append({**KIT[name],'p':p,'c':c})
    print(f'  ch{len(channels)-1}: {name:5s} <- kit, {sum(1 for v in rows if v)} hits')
song={'songLen':int(np.ceil(ROWS*ROW_LEN/44100)),'songData':channels,'rowLen':ROW_LEN,'endPattern':ROWS//32-1}
json.dump(song, open(out,'w'))
print(f'  -> {out}  {len(json.dumps(song))/1024:.1f} kB, {len(channels)} channels, {song["songLen"]}s')

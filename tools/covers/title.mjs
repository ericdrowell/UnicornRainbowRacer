// Uses the game's own atlas baker, including its rainbow rim and inset lettering.
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
process.chdir(root);
const deps=process.env.COVER_DEPS || '/tmp/urr329-validation/node_modules';
const {createCanvas,loadImage,GlobalFonts}=await import(`${deps}/@napi-rs/canvas/index.js`);
GlobalFonts.registerFromPath('/System/Library/Fonts/Supplemental/Tahoma.ttf','Tahoma');
GlobalFonts.registerFromPath('/System/Library/Fonts/Supplemental/Tahoma Bold.ttf','Tahoma');
const game=fs.readFileSync('src/game.js','utf8');
const context=vm.createContext({document:{createElement:()=>createCanvas(1,1)}});
const run=s=>vm.runInContext(s,context);
run(fs.readFileSync('src/unicorns.js','utf8')+'\n'+fs.readFileSync('src/circuits.js','utf8')+'\n'+fs.readFileSync('src/text.js','utf8'));
run('const CELL=4,ROW_H=12,CARD_W=WIDE*CELL+2;');
let baker=game.slice(game.indexOf('  const NAME_ROW ='),game.indexOf('  const cardTex = bmTexture(card, 1);'));
baker=baker.replace('LINES.forEach((text, row) => {','LINES.forEach((text, row) => { if(row!==0 && row!==29)return;');
run(baker);
const {card,atlasRows,CARD_W,ROW_H}=run('({card,atlasRows,CARD_W,ROW_H})');
const canvas=createCanvas(1600,1000),g=canvas.getContext('2d');
g.drawImage(await loadImage('artifacts/covers/current/03-wide-sweep-scene.png'),0,0,1600,1000);
for(const [row,centerY,scale] of [[0,40,7],[29,107,11]]){
 const column=Math.floor(row/atlasRows)*CARD_W,top=(row%atlasRows)*ROW_H;
 g.drawImage(card,column*18,top*18,CARD_W*18,ROW_H*18,(400-CARD_W*scale/2)*2,(centerY-ROW_H*scale/2)*2,CARD_W*scale*2,ROW_H*scale*2);
}
const output=createCanvas(800,500);output.getContext('2d').drawImage(canvas,0,0,800,500);
fs.writeFileSync('artifacts/covers/current/03-wide-sweep.png',output.toBuffer('image/png'));
console.log('Saved 800 × 500 cover');

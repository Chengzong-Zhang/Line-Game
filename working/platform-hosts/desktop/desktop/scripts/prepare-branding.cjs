// Original geometric artwork. No external images or font files are consumed.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
app.disableHardwareAcceleration();
const root = path.resolve(__dirname, "../..");
const assets = path.join(root, "desktop/assets");
const marketing = path.join(root, "desktop/release/marketing-art");
const ink = "#243f42", teal = "#16848b", red = "#c06448", paper = "#f8f0df";
const glyphs = {
  L: "M0 0V100H60", I: "M0 0H50M25 0V100M0 100H50", F: "M60 0H0V100M0 45H48",
  E: "M60 0H0V100H60M0 45H48", N: "M0 100V0L62 100V0"
};
function wordmark(x, y, width, color = ink) {
  const letters = [..."LIFELINE"], scale = width / 690;
  return `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="square" stroke-linejoin="miter">${letters.map((letter, i) => `<path transform="translate(${i * 88} 0)" d="${glyphs[letter]}"/>`).join("")}</g>`;
}
function board(x, y, width) {
  const step = 90, dy = step * Math.sqrt(3) / 2, point = (r, c) => [r * step / 2 + c * step, r * dy];
  const nodes = [], edges = [];
  for (let r = 0; r <= 6; r++) for (let c = 0; c <= 6 - r; c++) {
    const [px, py] = point(r, c);
    for (const [rr, cc] of [[r, c + 1], [r + 1, c], [r + 1, c - 1]]) if (rr <= 6 && cc >= 0 && cc <= 6 - rr) {
      const [qx, qy] = point(rr, cc);
      edges.push(`<path d="M${px} ${py}L${qx} ${qy}"/>`);
    }
    nodes.push(`<circle cx="${px}" cy="${py}" r="4"/>`);
  }
  const track = (coords, color) => `<g stroke="${color}" stroke-width="13" fill="${paper}" stroke-linecap="round" stroke-linejoin="round"><polyline fill="none" points="${coords.map(([r,c]) => point(r,c).join(",")).join(" ")}"/>${coords.map(([r,c]) => { const [px,py]=point(r,c); return `<circle cx="${px}" cy="${py}" r="11"/>`; }).join("")}</g>`;
  return `<g transform="translate(${x} ${y}) scale(${width/540})"><g stroke="${ink}" stroke-width="1.3" opacity=".18">${edges.join("")}</g><g fill="${ink}" opacity=".25">${nodes.join("")}</g><path d="M0 0H180L90 156Z" fill="${teal}" opacity=".13"/><path d="M540 0H360L450 156Z" fill="${red}" opacity=".13"/>${track([[0,0],[0,1],[1,1],[2,0],[1,0],[0,0]],teal)}${track([[0,6],[1,5],[2,3],[1,3],[0,4],[0,5],[0,6]],red)}${track([[2,0],[3,0],[4,0]],teal)}${track([[2,3],[3,2],[4,1]],red)}</g>`;
}
function svg(width,height,content,bg=paper) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${bg ? `<rect width="${width}" height="${height}" fill="${bg}"/>` : ""}${content}</svg>`;
}
function icon(size) {
  return svg(size,size,`<g transform="scale(${size/256})"><rect x="8" y="8" width="240" height="240" rx="50" fill="${ink}"/><path d="M56 174L128 50L200 174Z" fill="none" stroke="${paper}" stroke-opacity=".28" stroke-width="4"/><path d="M56 174L92 112L128 174" fill="none" stroke="#74d6d4" stroke-width="13" stroke-linejoin="round"/><path d="M128 50L164 112L200 174" fill="none" stroke="#eea281" stroke-width="13"/>${[[56,174,"#74d6d4"],[92,112,"#74d6d4"],[128,174,"#74d6d4"],[128,50,"#eea281"],[164,112,"#eea281"],[200,174,"#eea281"]].map(([x,y,color])=>`<circle cx="${x}" cy="${y}" r="10" fill="${ink}" stroke="${color}" stroke-width="6"/>`).join("")}</g>`,null);
}
function ico(images) {
  const header=Buffer.alloc(6+16*images.length); header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);
  let offset=header.length;
  images.forEach(({size,buffer},i)=>{const at=6+i*16;header[at]=size===256?0:size;header[at+1]=size===256?0:size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(buffer.length,at+8);header.writeUInt32LE(offset,at+12);offset+=buffer.length;});
  return Buffer.concat([header,...images.map(i=>i.buffer)]);
}
app.whenReady().then(async()=>{
  fs.mkdirSync(assets,{recursive:true});fs.mkdirSync(marketing,{recursive:true});
  const win=new BrowserWindow({show:false,transparent:true,backgroundColor:"#00000000",width:512,height:512,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const render=async(source,width,height)=>{win.setContentSize(width,height);await win.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent(`<style>html,body{margin:0;background:transparent;overflow:hidden}</style>${source}`));await new Promise(r=>setTimeout(r,350));return (await win.webContents.capturePage()).toPNG();};
  const iconImage = require("electron").nativeImage.createFromBuffer(await render(icon(256),256,256));
  const images=[];for(const size of [16,24,32,48,64,128,256])images.push({size,buffer:iconImage.resize({width:size,height:size,quality:"best"}).toPNG()});
  fs.writeFileSync(path.join(assets,"lifeline.ico"),ico(images));fs.writeFileSync(path.join(assets,"lifeline.svg"),icon(256));
  fs.writeFileSync(path.join(marketing,"app-icon.png"),iconImage.resize({width:256,height:256,quality:"best"}).toPNG());
  const items=[
    ["header",920,430,wordmark(60,155,475)+board(580,65,330)],
    ["library-header",920,430,wordmark(60,155,475)+board(580,65,330)],
    ["small",462,174,wordmark(30,57,400)],
    ["main",1232,706,wordmark(95,80,1020)+board(350,300,560)],
    ["vertical",748,896,wordmark(62,85,625)+board(65,350,620)],
    ["library-capsule",600,900,wordmark(45,85,518)+board(42,370,515)],
    ["library-hero",3840,1240,board(1440,140,970)],
    ["library-logo",1280,240,wordmark(25,25,1230),null]
  ];
  const manifest=[];
  for(const [name,width,height,content,bg] of items){const source=svg(width,height,content,bg===null?null:paper);const buffer=await render(source,width,height);fs.writeFileSync(path.join(marketing,`${name}.svg`),source);fs.writeFileSync(path.join(marketing,`${name}.png`),buffer);manifest.push({name,width,height,sha256:crypto.createHash("sha256").update(buffer).digest("hex")});}
  fs.writeFileSync(path.join(marketing,"art-manifest.json"),JSON.stringify({status:"LOCAL_ART_DRAFT",generator:"desktop/scripts/prepare-branding.cjs",artwork:"original geometric source; no external image or font files",items:manifest},null,2));
  win.destroy();console.log(JSON.stringify({status:"BRANDING_RENDERED",assets,marketing,items:manifest.length}));app.quit();
}).catch(error=>{console.error(error);app.exit(1);});

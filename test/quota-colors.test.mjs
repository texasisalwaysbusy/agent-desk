import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
const source = await readFile(new URL("../inject/codex-quota-display.user.js", import.meta.url), "utf8");
const dom = new JSDOM("<!doctype html><html></html>", { runScripts: "outside-only", url: "app://codex/" });
dom.window.eval(source);
const api = dom.window.__codexTaskboardQuotaDisplay__;
test.after(() => { api.cleanup(); dom.window.close(); });
const channels = color => color.match(/[\d.]+/g).slice(0,3).map(Number);
const distance = (a,b) => Math.hypot(...a.map((v,i)=>v-b[i]));
const luminance = rgb => rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4)
  .reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
const contrast = (a,b) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
test("quota palette is finite, continuous at every tenth-percent and full-blue endpoint", () => {
  assert.ok(distance(channels(api.appearance(100).base),[56,189,248])<.01);
  assert.ok(distance(channels(api.appearance(100).base),channels(api.appearance(99).base))<5);
  let previous=channels(api.appearance(0).base);
  for(let n=0;n<=1000;n++) {
    const colors=api.appearance(n/10),current=channels(colors.base);
    for(const field of ["base","top","bottom","textLight","textDark"])
      assert.ok(channels(colors[field]).every(v=>Number.isFinite(v)&&v>=0&&v<=255));
    assert.ok(distance(current,previous)<3,`Discontinuity at ${n/10}%`); previous=current;
  }
  assert.equal(api.appearance(-5).percentage,0);assert.equal(api.appearance(105).percentage,100);
  for(const value of [NaN,Infinity,"60",null])assert.equal(api.appearance(value),null);
});
test("healthy plateau stays green; warning changes faster; low quota reaches dense red", () => {
  for(let p=45;p<=75;p++) { const [r,g,b]=channels(api.appearance(p).base);assert.ok(g>r*1.5&&g>b*1.1,`${p}% is not green`); }
  assert.ok(distance(channels(api.appearance(35).base),channels(api.appearance(25).base))>
    3*distance(channels(api.appearance(60).base),channels(api.appearance(50).base)));
  const [r,g,b]=channels(api.appearance(5).base);assert.ok(r>g*3&&r>b*2);
  assert.ok(luminance(channels(api.appearance(0).base))<luminance(channels(api.appearance(15).base)));
  assert.equal(api.appearance(25).tone,"critical");assert.equal(api.appearance(45).tone,"healthy");
});
test("percentage text stays readable on light and dark backgrounds at every percentage", () => {
  for(let p=0;p<=100;p++) {
    const a=api.appearance(p);
    assert.ok(contrast(channels(a.textLight),[249,250,251])>=4.59,`Light ${p}%`);
    assert.ok(contrast(channels(a.textDark),[32,33,36])>=4.59,`Dark ${p}%`);
  }
});
test("material has one current hue, vertical shading and static highlights without animation", () => {
  assert.match(source,/linear-gradient\(180deg, color-mix\(in srgb, var\(--quota-base\) 68%, white\), var\(--quota-base\) 48%, color-mix\(in srgb, var\(--quota-base\) 90%, #102838\)\)/);
  assert.doesNotMatch(source,/linear-gradient\((?:90deg|to right)|animation:|transition:/);
  assert.match(source,/@media \(forced-colors:active\)/);
  assert.doesNotMatch(source,/fetch\(|WebSocket|https?:\/\//);
});

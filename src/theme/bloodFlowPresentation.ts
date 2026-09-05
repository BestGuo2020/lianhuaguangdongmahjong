import type { TableThemeName } from '../components/table/three/tableTheme'
import type { BloodFlowCue, WinTier } from '../game/variants/lotus/bloodFlow/presentation'
const traits={
  jade:{color:0xffd46a,sparks:[0xffe8a4,0x9cdabd],shape:'diamond',font:'"SimSun", serif',angle:-3,overshoot:1.65,arc:1,bend:.08},
  rosewood:{color:0xeeb16e,sparks:[0xffcc87,0xe57852],shape:'diamond',font:'"FangSong", "SimSun", serif',angle:2,overshoot:1.5,arc:.7,bend:0},
  happyMahjong:{color:0xffcf3f,sparks:[0xffc43f,0x64dcff,0xff7c75],shape:'confetti',font:'"Microsoft YaHei UI", sans-serif',angle:-10,overshoot:1.9,arc:1.5,bend:.32},
  llm:{color:0x6cecff,sparks:[0x6cecff,0xb6ffff],shape:'square',font:'"Cascadia Mono", "Microsoft YaHei", monospace',angle:0,overshoot:1.45,arc:.65,bend:-.15},
  llmAnime:{color:0xff8dbc,sparks:[0xffa4cf,0x83e9ff,0xffefa9],shape:'diamond',font:'"Microsoft YaHei", sans-serif',angle:-7,overshoot:1.8,arc:1.25,bend:.2},
} as const
export function bloodFlowImpactProfile(theme:TableThemeName,tier:WinTier,compact=false,reduced=false){
  const trait=traits[theme],strength=compact?.85:1
  // Restore the first visible win baseline (40 sparks / 8.5-unit beam).
  // Cooldown reduces only the extra high-tier accent, never the ordinary hit.
  return {...trait,particleCount:reduced?0:40+Math.round([0,8,20,32][tier]*strength),particleSpeed:(theme==='llm'?1.2:1)*strength,
    beamHeight:reduced?0:8.5+[0,.5,1.5,2.5][tier]*strength,beamRadius:theme==='llm'?.045:theme==='happyMahjong'?.13:.075,
    intensity:reduced?.4:.75+[0,.07,.17,.25][tier]*strength,starburstScale:1+[0,.3,.7,1.2][tier]*strength,
    cameraStrength:reduced||tier<2?0:(compact?.22:1),dimming:reduced||compact||tier<2?0:tier===3?.36:.2,
    effectVolume:[.28,.4,.58,.72][tier]*(compact?.75:1)}
}
const clamp=(v:number)=>Math.max(0,Math.min(1,v))
export function bloodFlowTitleMotion(cue:BloodFlowCue,now:number,theme:TableThemeName,reduced=false){
  const e=Math.max(0,now-cue.startedAt),m=cue.phaseMarks,p=bloodFlowImpactProfile(theme,cue.tier,cue.compact,reduced)
  if(reduced)return {scale:1,rotation:0,y:0,opacity:e<m.exit?1:clamp((cue.duration-e)/(cue.duration-m.exit)),dimming:0}
  const points=[{at:0,scale:.45,y:26,rotation:p.angle,opacity:0},{at:m.impact*.6,scale:1.06,y:0,rotation:p.angle*.35,opacity:1},
    {at:m.impact,scale:p.overshoot,y:-5,rotation:-p.angle*.2,opacity:1},{at:m.readable*.86,scale:.96,y:2,rotation:0,opacity:1},
    {at:m.readable,scale:1,y:0,rotation:0,opacity:1},{at:m.exit,scale:1,y:0,rotation:0,opacity:1},{at:cue.duration,scale:.9,y:-13,rotation:p.angle*.12,opacity:0}]
  let a=points[0],b=points.at(-1)!
  for(let i=1;i<points.length;i++)if(e<=points[i].at){a=points[i-1];b=points[i];break}
  const t=clamp((e-a.at)/Math.max(1,b.at-a.at)),ease=t*t*(3-2*t)
  const mix=(k:'scale'|'y'|'rotation'|'opacity')=>a[k]+(b[k]-a[k])*ease
  return {scale:mix('scale'),y:mix('y'),rotation:mix('rotation'),opacity:mix('opacity'),dimming:p.dimming*clamp(e/m.impact)*clamp((m.score-e)/Math.max(1,m.score-m.readable))}
}

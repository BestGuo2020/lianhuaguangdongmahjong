/** Small fixed-penalty offline model, fitted in score points. No hyperparameter search. */
export interface RidgeModel { center:number[]; scale:number[]; weights:number[]; intercept:number; paired:boolean; lambda:number }
export function fitRidge(x:number[][],y:number[],paired:boolean):RidgeModel{
  if(!x.length||x.length!==y.length)throw new Error('Empty or mismatched training data')
  const d=x[0].length,n=x.length,center=Array(d).fill(0),scale=Array(d).fill(1)
  if(x.some(r=>r.length!==d||r.some(v=>!Number.isFinite(v)))||y.some(v=>!Number.isFinite(v)))throw new Error('Nonfinite training input')
  const intercept=paired?0:y.reduce((a,b)=>a+b,0)/n
  for(let j=0;j<d;j++){
    center[j]=paired?0:x.reduce((s,r)=>s+r[j],0)/n
    scale[j]=Math.sqrt(x.reduce((s,r)=>s+(r[j]-center[j])**2,0)/n)||1
  }
  const z=x.map(r=>r.map((v,j)=>(v-center[j])/scale[j]))
  const a=Array.from({length:d},()=>Array(d+1).fill(0))
  for(let j=0;j<d;j++){
    for(let k=0;k<d;k++)a[j][k]=z.reduce((s,r)=>s+r[j]*r[k],0)/n+Number(j===k)
    a[j][d]=z.reduce((s,r,i)=>s+r[j]*(y[i]-intercept),0)/n
  }
  // Partial-pivot elimination; positive ridge penalty keeps the system nonsingular.
  for(let j=0;j<d;j++){
    let pivot=j;for(let i=j+1;i<d;i++)if(Math.abs(a[i][j])>Math.abs(a[pivot][j]))pivot=i
    ;[a[j],a[pivot]]=[a[pivot],a[j]]
    const value=a[j][j];if(Math.abs(value)<1e-12)throw new Error('Singular model')
    for(let k=j;k<=d;k++)a[j][k]/=value
    for(let i=0;i<d;i++)if(i!==j){const factor=a[i][j];for(let k=j;k<=d;k++)a[i][k]-=factor*a[j][k]}
  }
  return {center,scale,weights:a.map(r=>r[d]),intercept,paired,lambda:1}
}
export function predictRidge(model:RidgeModel,x:number[]){
  if(x.length!==model.weights.length||x.some(v=>!Number.isFinite(v)))throw new Error('Bad feature vector')
  const result=model.intercept+x.reduce((s,v,j)=>s+(v-model.center[j])/model.scale[j]*model.weights[j],0)
  return model.paired?result:Math.max(0,result)
}

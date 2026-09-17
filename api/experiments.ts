import { ZodError } from 'zod/v4';
import { requireWorkspaceAccess, jsonResponse } from '../src/lib/authz.js';
import { corsPreflight } from '../src/lib/cors.js';
import { InsufficientCreditsError } from '../src/lib/credits.js';
import { ExperimentError, Id, Estimate } from '../src/experiments/schema.js';
import { createExperiment, estimate, mutate } from '../src/experiments/service.js';
import { load, list, remove, serialize } from '../src/experiments/store.js';
import { deleteObjects, thumbBucket } from '../src/lib/storage.js';

export const OPTIONS=async(request:Request)=>corsPreflight(request);
async function body(request:Request):Promise<Record<string,unknown>> {
  const reader=request.body?.getReader();if(!reader)throw new ExperimentError(400,'body_required');
  let text='';let bytes=0;const decoder=new TextDecoder();
  try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>128000)throw new ExperimentError(413,'body_too_large');text+=decoder.decode(r.value,{stream:true});}}
  finally{await reader.cancel().catch(()=>{});}
  let value:unknown;try{value=JSON.parse(text+decoder.decode());}catch{throw new ExperimentError(400,'invalid_json');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ExperimentError(400,'invalid_body');
  return value as Record<string,unknown>;
}
async function handle(request:Request):Promise<Response> {
  try{
    const url=new URL(request.url);
    const match=/^\/api\/experiments(?:\/([^/]+))?(?:\/(estimate|plan|generate|cancel|retry)|\/variants\/([^/]+))?$/.exec(url.pathname);
    if(!match)return jsonResponse(404,{error:'not_found'},request);
    const id=match[1]?Id.parse(match[1]):null;const action=match[2];const variantId=match[3]?Id.parse(match[3]):undefined;
    const b=request.method==='GET'?null:await body(request);
    const workspaceId=Id.parse(b?.workspaceId??url.searchParams.get('workspaceId'));
    const auth=await requireWorkspaceAccess(request,workspaceId);if(!auth.ok)return auth.response;
    let response:unknown;
    if(request.method==='GET'&&!action&&!variantId)response=id?{experiment:serialize(await load(workspaceId,id))}:{experiments:(await list(workspaceId)).map(serialize)};
    else if(request.method==='POST'&&!id)response={experiment:serialize(await createExperiment(b))};
    else if(request.method==='POST'&&id&&action==='estimate'){
      const parsed=Estimate.parse(b);response={estimate:await estimate(await load(workspaceId,id),parsed.stage,parsed.variantIds,parsed.taskIds)};
    }else if(request.method==='POST'&&id&&action)response={experiment:serialize(await mutate(workspaceId,id,action,b))};
    else if(request.method==='PATCH'&&id&&variantId)response={experiment:serialize(await mutate(workspaceId,id,'edit',b,variantId))};
    else if(request.method==='DELETE'&&id&&!action){
      const e=await load(workspaceId,id);
      if(e.status==='planning'||e.status==='generating') throw new ExperimentError(409,'active_experiment','Cancel the experiment before deleting it.');
      // Retained slide images live under the retained prefix; remove them with the record.
      const paths=[...e.tasks.map(t=>t.path),...e.variants.flatMap(v=>v.slides.map(s=>s.path))].filter((p):p is string=>!!p);
      const deleted=await remove(workspaceId,id);
      if(!deleted) throw new ExperimentError(404,'experiment_not_found');
      if(paths.length)await deleteObjects(thumbBucket(),paths).catch(()=>0);
      response={deleted:true};
    }
    else return jsonResponse(405,{error:'method_not_allowed'},request);
    return jsonResponse(200,response,request);
  }catch(err){
    if(err instanceof ZodError)return jsonResponse(400,{error:'invalid_request',issues:err.issues},request);
    if(err instanceof ExperimentError)return jsonResponse(err.statusCode,{error:err.code,message:err.message},request);
    if(err instanceof InsufficientCreditsError)return jsonResponse(402,{error:'insufficient_credits',required:err.required,remaining:err.remaining},request);
    console.error('[experiments] request failed',err instanceof Error?err.name:'unknown');
    return jsonResponse(500,{error:'experiment_request_failed'},request);
  }
}
export const GET=handle;
export const POST=handle;
export const PATCH=handle;

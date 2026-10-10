import {thinkingIsReady} from './thinking.js';
export const EMPTY = () => ({version:2, resetAt:0, entries:{}});
export const storageKey = userId => 'crackSqlProgress:v2:' + (userId ? 'user:' + userId : 'guest');
export function sanitize(value, ids) {
  const result = EMPTY();
  if (!value || typeof value !== 'object' || typeof value.entries !== 'object' || !value.entries || Array.isArray(value.entries)) return result;
  result.version = 2;
  result.resetAt = Number.isFinite(value.resetAt) ? Math.max(0,value.resetAt) : 0;
  for (const [id,entry] of Object.entries(value.entries)) {
    if ((ids && ids.size > 0 && !ids.has(id)) || !entry || typeof entry !== 'object' || !Number.isFinite(entry.updatedAt) || entry.updatedAt <= result.resetAt) continue;
    const thinking = {response:String(entry.thinking?.response||'').slice(0,8000)};
    // Keep earlier four-box answers readable after upgrading to the single-box UI.
    for(const k of ['goal','sources','steps','check'])thinking[k]=String(entry.thinking?.[k]||'').slice(0,4000);
    const score = (typeof entry.assessment?.score === 'number') ? entry.assessment.score : null;
    const completed = !!entry.completed || (score !== null ? score >= 7 : false);
    const attempts = Number.isFinite(entry.attempts) ? Math.max(0, Math.floor(entry.attempts)) : (entry.assessment ? 1 : 0);
    const status = typeof entry.status === 'string' ? entry.status : (completed ? 'completed' : (attempts > 0 || score !== null) ? 'attempted' : 'in_progress');
    result.entries[id] = {thinking, sql:String(entry.sql || '').slice(0,20000),
      variantIndex: Number.isFinite(entry.variantIndex) ? entry.variantIndex : null,
      skill: typeof entry.skill === 'string' ? entry.skill : null,
      assessment: entry.assessment && typeof entry.assessment === 'object' ? entry.assessment : null,
      assessmentVersion: typeof entry.assessmentVersion === 'string' ? entry.assessmentVersion : (entry.assessment?.version ? `thinking_v${entry.assessment.version}` : 'thinking_v2'),
      completed,
      status,
      fiddleFingerprint: typeof entry.fiddleFingerprint === 'string' ? entry.fiddleFingerprint : null,
      evaluationFingerprint: typeof entry.evaluationFingerprint === 'string' ? entry.evaluationFingerprint : null,
      evaluationResult: entry.evaluationResult && typeof entry.evaluationResult === 'object' ? entry.evaluationResult : null,
      evaluationAt: Number.isFinite(entry.evaluationAt) ? entry.evaluationAt : null,
      attempts,
      validationNotes:String(entry.validationNotes || '').slice(0,4000),
      answerViewed:!!entry.answerViewed, legacyViewed:!!entry.legacyViewed,
      updatedAt:entry.updatedAt};
  }
  if (value.skills && typeof value.skills === 'object') {
    result.skills = value.skills;
  }
  if (value.levelFeedback && typeof value.levelFeedback === 'object' && !Array.isArray(value.levelFeedback)) {
    result.levelFeedback = value.levelFeedback;
  }
  return result;
}
export function isCompleted(scenario, entry) {
  if (!entry) return false;
  if (entry.completed === true) {
    return true;
  }
  if (entry.assessment && typeof entry.assessment.score === 'number') {
    return entry.assessment.score >= 7;
  }
  return false;
}
export function isAttempted(scenario, entry) {
  if (!entry) return false;
  if (isCompleted(scenario, entry)) return true;
  if (entry.status === 'attempted' || entry.status === 'in_progress') return true;
  if (Number.isFinite(entry.attempts) && entry.attempts > 0) return true;
  if (entry.assessment && typeof entry.assessment.score === 'number') return true;
  if (entry.thinking && (Boolean(entry.thinking.response && String(entry.thinking.response).trim()) || Boolean(entry.thinking.steps))) return true;
  if (entry.sql && String(entry.sql).trim().length > 0) return true;
  if (Number.isFinite(entry.updatedAt) && entry.updatedAt > 0) return true;
  return false;
}
export function readProgress(storage, userId, ids) {
  try { return sanitize(JSON.parse(storage.getItem(storageKey(userId))), ids); }
  catch { return EMPTY(); }
}
export function saveProgress(storage,userId,state) {
  try { storage.setItem(storageKey(userId),JSON.stringify(state)); return true; }
  catch { return false; }
}
export function mergeProgress(a,b,ids) {
  a=sanitize(a,ids); b=sanitize(b,ids);
  const result=EMPTY(); result.resetAt=Math.max(a.resetAt,b.resetAt);
  if (a.skills || b.skills) {
    result.skills = { ...(a.skills || {}), ...(b.skills || {}) };
  }
  if (a.levelFeedback || b.levelFeedback) {
    result.levelFeedback = { ...(a.levelFeedback || {}), ...(b.levelFeedback || {}) };
  }
  const allIds = new Set([...(ids || []), ...Object.keys(a.entries), ...Object.keys(b.entries)]);
  for(const id of allIds) {
    if (ids && ids.size > 0 && !ids.has(id)) continue;
    const x=a.entries[id],y=b.entries[id];
    let e = !x ? y : !y ? x : null;
    if (x && y) {
      // Preserve completed status (Score >= 7) so an uncompleted draft does not overwrite completion
      const xComp = isCompleted(null, x);
      const yComp = isCompleted(null, y);
      if (xComp && !yComp) {
        e = x;
      } else if (yComp && !xComp) {
        e = y;
      } else {
        e = x.updatedAt > y.updatedAt ? x : y;
      }
    }
    if(e && e.updatedAt>result.resetAt) result.entries[id]=e;
  }
  return result;
}
export function nextTimestamp(state, now=Date.now()) {
  return Math.max(now,state.resetAt+1,...Object.values(state.entries).map(e=>e.updatedAt+1));
}
export function workFingerprint(entry) {
  return JSON.stringify([entry.assessment?.fingerprint || '',String(entry.sql || '').trim()]);
}
export function stage(scenario,entry) {
  if(!entry) return 'not_started';
  if(!thinkingIsReady(scenario,entry)) return entry.legacyViewed?'answer_viewed':'thinking';
  if(!String(entry.sql||'').trim()) return 'thinking_ready';
  if(entry.evaluationFingerprint===workFingerprint(entry) && entry.evaluationResult?.passed) return 'verified';
  if(entry.fiddleFingerprint===workFingerprint(entry)) return 'fiddle_opened';
  return 'sql_written';
}
export function chooseNext(pool,state,currentId) {
  return pool.find(s=>s.id!==currentId && !isCompleted(s,state.entries[s.id]))
    || pool.find(s=>s.id===currentId && !isCompleted(s,state.entries[s.id])) || null;
}
export function importLegacy(idsFromOldStorage,state,aliases,ids,now=Date.now()) {
  const next=structuredClone(state);let timestamp=nextTimestamp(next,now);
  for(const oldId of Array.isArray(idsFromOldStorage)?idsFromOldStorage:[]) {
    const id=aliases[oldId];
    if(!ids.has(id) || next.entries[id]) continue;
    next.entries[id]={thinking:{},sql:'',legacyViewed:true,answerViewed:true,updatedAt:timestamp++};
  }
  return sanitize(next,ids);
}

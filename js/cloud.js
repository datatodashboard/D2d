import { mergeProgress } from './progress.js';

// A single serialized queue plus a session generation guard prevents cross-account writes.
export function createCloudSync({client,getContext,onMerged,onStatus}) {
  let generation=0, running=false, requested=false;
  async function drain() {
    if(running) return;
    running=true;
    try {
      while(requested) {
        requested=false;
        const token=generation, context=getContext();
        const activeClient = typeof client === 'function' ? client() : client;
        if(!activeClient || !context.userId) continue;

        const localEntries = (context.state && typeof context.state.entries === 'object' && context.state.entries) ? context.state.entries : {};
        const localCount = Object.keys(localEntries).length;
        const localResetAt = Number(context.state?.resetAt) || 0;

        // RULE 9: Protect against empty guest state overwriting non-empty saved cloud state upon initial sign in,
        // BUT allow clean reset states (localResetAt > 0) to sync to cloud.
        if (localCount === 0 && localResetAt === 0) {
          try {
            if (typeof activeClient.from === 'function') {
              const { data: row, error: fetchErr } = await activeClient
                .from('learning_progress')
                .select('state')
                .eq('user_id', context.userId)
                .maybeSingle();

              if (!fetchErr && row?.state) {
                const sanitizedRemote = mergeProgress(row.state, { version: 2, resetAt: 0, entries: {} });
                if (Object.keys(sanitizedRemote.entries).length > 0) {
                  if (token === generation && context.userId === getContext().userId) {
                    onMerged(sanitizedRemote, context.userId);
                    onStatus('Progress synced');
                  }
                }
              }
            }
          } catch (fetchErr) {
            console.warn('Fetch remote check warning:', fetchErr);
          }
          continue;
        }

        console.log('[D2D Progress] Saving progress to cloud');
        onStatus('Syncing…');
        let mergedData = null;

        // 1. Try atomic merge RPC
        try {
          if (typeof activeClient.rpc === 'function') {
            const {data, error} = await activeClient.rpc('merge_learning_progress', {
              incoming: context.state,
              expected_user: context.userId
            });
            if (!error && data) {
              mergedData = data;
              console.log('[D2D Progress] Cloud save successful (via RPC)');
            } else if (error) {
              console.warn('[D2D Progress] merge_learning_progress RPC notice:', error.message || error);
            }
          }
        } catch (rpcErr) {
          console.warn('[D2D Progress] merge_learning_progress RPC exception:', rpcErr);
        }

        // 2. Direct table fallback if RPC did not return data
        if (!mergedData && typeof activeClient.from === 'function') {
          try {
            const { data: row, error: fetchErr } = await activeClient
              .from('learning_progress')
              .select('state')
              .eq('user_id', context.userId)
              .maybeSingle();

            if (!fetchErr) {
              const remoteState = (row?.state && typeof row.state === 'object') ? row.state : { entries: {} };
              const localState = (context.state && typeof context.state === 'object') ? context.state : { entries: {} };
              const mergedState = mergeProgress(remoteState, localState);

              const { error: upsertErr } = await activeClient
                .from('learning_progress')
                .upsert({
                  user_id: context.userId,
                  state: mergedState,
                  updated_at: new Date().toISOString()
                }, { onConflict: 'user_id' });

              if (!upsertErr) {
                mergedData = mergedState;
                console.log('[D2D Progress] Cloud save successful');
              } else {
                console.error('[D2D Progress] Direct learning_progress upsert error:', upsertErr.message || upsertErr);
              }
            } else {
              console.error('[D2D Progress] Error fetching current cloud progress before upsert:', fetchErr.message || fetchErr);
            }
          } catch (tableErr) {
            console.error('[D2D Progress] learning_progress table fallback exception:', tableErr);
          }
        }

        if(token!==generation || context.userId!==getContext().userId) continue;
        if(mergedData) {
          onMerged(mergedData, context.userId);
          onStatus('Progress synced');
        } else {
          onStatus('Saved on this device. Cloud sync unavailable; retry when connected.');
        }
      }
    } finally {running=false;}
  }
  return {
    request(){requested=true;void drain();},
    changeSession(){generation++;requested=false;},
  };
}

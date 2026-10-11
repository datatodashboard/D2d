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

        // RULE 6 & 9: Protect against empty local state overwriting non-empty saved cloud state
        if (localCount === 0) {
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
                  continue;
                }
              }
            }
          } catch (fetchErr) {
            console.warn('Fetch remote check warning:', fetchErr);
          }
          if (localResetAt === 0) {
            continue;
          }
        }

        console.log('[D2D Progress] Saving progress to cloud');
        onStatus('Syncing…');
        let mergedData = null;
        let rpcFailed = false;

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
              rpcFailed = true;
              console.warn('[D2D Progress] merge_learning_progress RPC notice:', error.message || error);
            }
          } else {
            rpcFailed = true;
            console.warn('[D2D Progress] merge_learning_progress RPC not available on client');
          }
        } catch (rpcErr) {
          rpcFailed = true;
          console.warn('[D2D Progress] merge_learning_progress RPC exception:', rpcErr);
        }

        // 2. Direct table fallback if RPC failed or was not installed (skip if RPC failed)
        if (!mergedData && !rpcFailed && typeof activeClient.from === 'function') {
          try {
            console.log('[D2D Progress] Attempting direct table save fallback');
            let remoteState = null;
            const { data: row } = await activeClient
              .from('learning_progress')
              .select('state')
              .eq('user_id', context.userId)
              .maybeSingle();

            if (row?.state) {
              remoteState = row.state;
            }

            const merged = remoteState ? mergeProgress(remoteState, context.state) : context.state;

            const { error: upsertErr } = await activeClient
              .from('learning_progress')
              .upsert({
                user_id: context.userId,
                state: merged,
                updated_at: new Date().toISOString()
              });

            if (!upsertErr) {
              mergedData = merged;
              console.log('[D2D Progress] Cloud save successful (via direct table upsert)');

              // Mirror completed entries to progress table directly
              const completedEntries = Object.entries(merged.entries || {}).filter(([_, e]) => {
                const s = typeof e.score === 'number' ? e.score : (typeof e.thinkingScore === 'number' ? e.thinkingScore : (e.assessment?.score || 0));
                return e.completed === true || e.status === 'completed' || s >= 7;
              });

              for (const [sId, e] of completedEntries) {
                try {
                  await activeClient
                    .from('progress')
                    .insert({
                      user_id: context.userId,
                      scenario_id: sId,
                      completed_at: new Date(e.updatedAt || Date.now()).toISOString()
                    });
                } catch (_) {}
              }
            } else {
              console.warn('[D2D Progress] Direct table upsert notice:', upsertErr.message || upsertErr);
            }
          } catch (fallbackErr) {
            console.warn('[D2D Progress] Direct table fallback exception:', fallbackErr);
          }
        }

        if(token!==generation || context.userId!==getContext().userId) continue;
        if(mergedData) {
          onMerged(mergedData, context.userId);
          onStatus('Progress synced');
        } else {
          // On total network failure or unavailability, preserve local progress and indicate sync notice
          onStatus('Saved on this device. Cloud sync error; retry when connected.');
          if (context.state && context.state.entries) {
            for (const eId of Object.keys(context.state.entries)) {
              if (context.state.entries[eId]) {
                context.state.entries[eId].syncPending = true;
                context.state.entries[eId].syncStatus = 'pending';
              }
            }
          }
        }
      }
    } finally {running=false;}
  }
  return {
    request(){requested=true;void drain();},
    changeSession(){generation++;requested=false;},
  };
}

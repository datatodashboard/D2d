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

        // RULE 9: NEVER replace existing saved cloud progress with an empty progress state
        if (localCount === 0) {
          try {
            if (typeof activeClient.from === 'function') {
              const { data: row, error: fetchErr } = await activeClient
                .from('learning_progress')
                .select('state')
                .eq('user_id', context.userId)
                .maybeSingle();

              if (!fetchErr && row?.state) {
                const remoteEntries = (typeof row.state.entries === 'object' && row.state.entries) ? row.state.entries : {};
                if (Object.keys(remoteEntries).length > 0) {
                  if (token === generation && context.userId === getContext().userId) {
                    onMerged(row.state, context.userId);
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
            } else if (error) {
              console.warn('merge_learning_progress RPC notice:', error.message || error);
            }
          }
        } catch (rpcErr) {
          console.warn('merge_learning_progress RPC exception:', rpcErr);
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
              const remoteEntries = (row?.state && typeof row.state.entries === 'object') ? row.state.entries : {};
              const mergedEntries = { ...remoteEntries, ...localEntries };
              const mergedState = {
                version: 2,
                resetAt: Math.max(context.state?.resetAt || 0, row?.state?.resetAt || 0),
                entries: mergedEntries
              };

              const { error: upsertErr } = await activeClient
                .from('learning_progress')
                .upsert({
                  user_id: context.userId,
                  state: mergedState,
                  updated_at: new Date().toISOString()
                }, { onConflict: 'user_id' });

              if (!upsertErr) {
                mergedData = mergedState;
              } else {
                console.warn('Direct learning_progress upsert notice:', upsertErr);
              }
            }
          } catch (tableErr) {
            console.warn('learning_progress table fallback notice:', tableErr);
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

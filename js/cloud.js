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
            }
          }
        } catch (rpcErr) {
          console.warn('merge_learning_progress RPC notice:', rpcErr);
        }

        // 2. Direct table fallback if RPC was unavailable or did not return data
        if (!mergedData && typeof activeClient.from === 'function') {
          try {
            const { data: row, error: fetchErr } = await activeClient
              .from('learning_progress')
              .select('state')
              .eq('user_id', context.userId)
              .maybeSingle();

            if (!fetchErr) {
              const remoteEntries = (row?.state && typeof row.state.entries === 'object') ? row.state.entries : {};
              const localEntries = (context.state && typeof context.state.entries === 'object') ? context.state.entries : {};

              const mergedEntries = { ...remoteEntries, ...localEntries };
              const mergedState = {
                version: 2,
                resetAt: Math.max(context.state?.resetAt || 0, row?.state?.resetAt || 0),
                entries: mergedEntries
              };

              if (Object.keys(localEntries).length > 0) {
                await activeClient
                  .from('learning_progress')
                  .upsert({
                    user_id: context.userId,
                    state: mergedState,
                    updated_at: new Date().toISOString()
                  });
              }
              mergedData = mergedState;
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

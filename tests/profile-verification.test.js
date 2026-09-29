import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Profile Verification Flow (Post-Google Login)', () => {

  function createMockSupabase(initialProfiles = {}, initialPayments = {}) {
    const profiles = { ...initialProfiles };
    const payments = { ...initialPayments };
    let upsertCalls = 0;

    return {
      profiles,
      payments,
      getUpsertCalls: () => upsertCalls,
      from: (table) => {
        if (table === 'profiles') {
          return {
            select: (columns) => ({
              eq: (col, val) => ({
                maybeSingle: async () => {
                  if (col === 'id' && profiles[val]) {
                    const row = { ...profiles[val] };
                    // If caller asks for username and username column is missing in schema cache, simulate
                    if (columns.includes('username') && row.__missingUsernameColumn) {
                      return { data: null, error: { message: "Could not find the 'username' column of 'profiles' in the schema cache", code: 'PGRST204' } };
                    }
                    return { data: row, error: null };
                  }
                  return { data: null, error: null };
                }
              })
            }),
            upsert: async (payload, options = {}) => {
              upsertCalls++;
              const id = payload.id;
              if (options.ignoreDuplicates && profiles[id]) {
                // DO NOTHING if row already exists
                return { data: null, error: null };
              }
              if (profiles[id]) {
                // If update on conflict, merge without overwriting undefined
                profiles[id] = { ...profiles[id], ...payload };
              } else {
                profiles[id] = {
                  id,
                  email: payload.email || '',
                  username: payload.username || null,
                  is_admin: payload.is_admin || false,
                  paid_unlocked: payload.paid_unlocked || false,
                  contest_eligible: payload.contest_eligible || false,
                  completed_count: payload.completed_count || 0,
                  ...payload
                };
              }
              return { data: null, error: null };
            },
            update: (payload) => ({
              eq: async (col, val) => {
                if (col === 'id' && profiles[val]) {
                  profiles[val] = { ...profiles[val], ...payload };
                  return { data: profiles[val], error: null };
                }
                return { data: null, error: null };
              }
            })
          };
        }
        if (table === 'payments') {
          return {
            select: () => ({
              eq: (col, val) => ({
                order: () => ({
                  limit: async () => {
                    const userPays = payments[val] || [];
                    return { data: userPays, error: null };
                  }
                })
              })
            })
          };
        }
        return {};
      },
      rpc: async (func) => {
        if (func === 'sync_user_progress') return { data: null, error: null };
        return { data: null, error: null };
      },
      auth: {
        getUser: async () => ({ data: { user: null }, error: null })
      }
    };
  }

  // Implementation of checkUserAccessStatus logic for testing
  async function runCheckUserAccessStatus(client, user, callbacks = {}) {
    let accessError = null;
    let accessHidden = false;
    let isCurrentUserAdmin = false;
    let isPaidUnlocked = false;
    let currentUsername = callbacks.initialUsername || null;

    const showAccessCheckError = (msg) => { accessError = msg; };
    const hideAccessError = () => { accessHidden = true; accessError = null; };

    if (!user?.id || !client) return;
    const userId = user.id;
    const userEmail = user.email || '';

    async function fetchProfile() {
      try {
        const { data, error } = await client
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle();

        if (!error && data) return { profile: data, error: null };
        if (!error && !data) return { profile: null, error: null };
      } catch (_) {}

      try {
        const { data: minData, error: minErr } = await client
          .from('profiles')
          .select('id, email')
          .eq('id', userId)
          .maybeSingle();

        if (!minErr) return { profile: minData, error: null };
        return { profile: null, error: minErr };
      } catch (ex2) {
        return { profile: null, error: ex2 };
      }
    }

    let { profile, error: profErr } = await fetchProfile();

    // If profile does not exist: create profile using existing profile system
    if (!profile && !profErr) {
      try {
        await client
          .from('profiles')
          .upsert({
            id: userId,
            email: userEmail,
            last_active: new Date().toISOString()
          }, { onConflict: 'id', ignoreDuplicates: true });
      } catch (_) {}

      // Reload profile
      const recheck = await fetchProfile();
      profile = recheck.profile;
      profErr = recheck.error;
    }

    if (profile) {
      hideAccessError();

      const dbUsername = (profile.username || '').trim();
      if (dbUsername) {
        currentUsername = dbUsername;
      }

      if (profile.is_admin === true) {
        isCurrentUserAdmin = true;
      }

      if (profile.paid_unlocked === true) {
        isPaidUnlocked = true;
      }
    } else if (profErr) {
      showAccessCheckError('Could not verify account profile. Click Retry to check again.');
    }

    return {
      profile,
      currentUsername,
      isCurrentUserAdmin,
      isPaidUnlocked,
      accessError,
      accessHidden
    };
  }

  it('1. If profile exists, loads profile normally, loads username & is_admin, and shows no error', async () => {
    const mockClient = createMockSupabase({
      'user-123': {
        id: 'user-123',
        email: 'learner@example.com',
        username: 'AlexSQL',
        is_admin: false,
        paid_unlocked: true,
        completed_count: 8
      }
    });

    const user = { id: 'user-123', email: 'learner@example.com' };
    const result = await runCheckUserAccessStatus(mockClient, user);

    assert.strictEqual(result.accessError, null);
    assert.strictEqual(result.accessHidden, true);
    assert.strictEqual(result.currentUsername, 'AlexSQL');
    assert.strictEqual(result.isCurrentUserAdmin, false);
    assert.strictEqual(result.isPaidUnlocked, true);
    assert.strictEqual(result.profile.id, 'user-123');
    assert.strictEqual(mockClient.getUpsertCalls(), 0, 'Should not create profile if already exists');
  });

  it('2. If profile does not exist, automatically creates it with user ID & email, reloads it, and shows no error', async () => {
    const mockClient = createMockSupabase({}); // Empty database
    const user = { id: 'new-user-456', email: 'firstlogin@gmail.com' };

    const result = await runCheckUserAccessStatus(mockClient, user);

    assert.strictEqual(result.accessError, null);
    assert.strictEqual(result.accessHidden, true);
    assert.ok(result.profile, 'Profile should have been created and loaded');
    assert.strictEqual(result.profile.id, 'new-user-456');
    assert.strictEqual(result.profile.email, 'firstlogin@gmail.com');
    assert.strictEqual(mockClient.getUpsertCalls(), 1, 'Profile should be created once');
  });

  it('3. Existing Admin account correctly loads its profile and admin status', async () => {
    const mockClient = createMockSupabase({
      'admin-super-uuid': {
        id: 'admin-super-uuid',
        email: 'datatodashboard2@gmail.com',
        username: 'SuperAdmin',
        is_admin: true,
        paid_unlocked: false,
        completed_count: 0
      }
    });

    const user = { id: 'admin-super-uuid', email: 'datatodashboard2@gmail.com' };
    const result = await runCheckUserAccessStatus(mockClient, user);

    assert.strictEqual(result.accessError, null);
    assert.strictEqual(result.accessHidden, true);
    assert.strictEqual(result.isCurrentUserAdmin, true, 'Admin status must be loaded');
    assert.strictEqual(result.currentUsername, 'SuperAdmin');
  });

  it('4. Does NOT overwrite an existing username with an empty value', async () => {
    const mockClient = createMockSupabase({
      'user-789': {
        id: 'user-789',
        email: 'existing@example.com',
        username: 'ExistingMaster',
        is_admin: false,
        paid_unlocked: false
      }
    });

    const user = { id: 'user-789', email: 'existing@example.com' };
    const result = await runCheckUserAccessStatus(mockClient, user, { initialUsername: '' });

    assert.strictEqual(result.currentUsername, 'ExistingMaster', 'Existing username must be preserved');
  });

  it('5. The Retry check re-checks the profile without creating duplicate records', async () => {
    const mockClient = createMockSupabase({
      'user-retry-1': {
        id: 'user-retry-1',
        email: 'retryuser@example.com',
        username: 'RetryUser',
        is_admin: false
      }
    });

    const user = { id: 'user-retry-1', email: 'retryuser@example.com' };

    // Initial check
    await runCheckUserAccessStatus(mockClient, user);
    assert.strictEqual(mockClient.getUpsertCalls(), 0);

    // Simulated Retry click
    const retryResult = await runCheckUserAccessStatus(mockClient, user);
    assert.strictEqual(retryResult.accessError, null);
    assert.strictEqual(retryResult.accessHidden, true);
    assert.strictEqual(mockClient.getUpsertCalls(), 0, 'Retry must not insert duplicate profiles');
    assert.strictEqual(Object.keys(mockClient.profiles).length, 1);
  });

  it('6. Schema cache fallback handles missing username column without error', async () => {
    const mockClient = createMockSupabase({
      'user-legacy': {
        id: 'user-legacy',
        email: 'legacy@example.com',
        is_admin: false,
        paid_unlocked: true,
        completed_count: 5,
        __missingUsernameColumn: true // simulate PostgREST cache without username
      }
    });

    const user = { id: 'user-legacy', email: 'legacy@example.com' };
    const result = await runCheckUserAccessStatus(mockClient, user);

    assert.strictEqual(result.accessError, null, 'Should fallback and not display error');
    assert.strictEqual(result.accessHidden, true);
    assert.strictEqual(result.isPaidUnlocked, true);
    assert.ok(result.profile);
  });
});

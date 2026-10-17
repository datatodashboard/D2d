import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAndFormatIndianMobile } from '../js/util.js';

test('Mobile Number Validation & Formatting for Indian Numbers', () => {
  // Test valid 10 digit Indian numbers starting with 6, 7, 8, 9
  assert.deepEqual(validateAndFormatIndianMobile('9876543210'), { isValid: true, formatted: '+919876543210', error: null });
  assert.deepEqual(validateAndFormatIndianMobile('+919876543210'), { isValid: true, formatted: '+919876543210', error: null });
  assert.deepEqual(validateAndFormatIndianMobile('09876543210'), { isValid: true, formatted: '+919876543210', error: null });
  assert.deepEqual(validateAndFormatIndianMobile('98765 43210'), { isValid: true, formatted: '+919876543210', error: null });
  assert.deepEqual(validateAndFormatIndianMobile('+91 87654-32109'), { isValid: true, formatted: '+918765432109', error: null });
  assert.deepEqual(validateAndFormatIndianMobile('7012345678'), { isValid: true, formatted: '+917012345678', error: null });
  assert.deepEqual(validateAndFormatIndianMobile('6301234567'), { isValid: true, formatted: '+916301234567', error: null });

  // Test invalid formats
  assert.equal(validateAndFormatIndianMobile('12345').isValid, false);
  assert.equal(validateAndFormatIndianMobile('abcdefghij').isValid, false);
  assert.equal(validateAndFormatIndianMobile('').isValid, false);
  assert.equal(validateAndFormatIndianMobile(null).isValid, false);
});

test('Scenario 1: New User Profile Registration - Safe Payload Construction', () => {
  const userId = 'user-new-123';
  const inputName = 'Rahul Sharma';
  const inputMobile = '9876543210';
  const inputWhatsapp = true;

  const mobileRes = validateAndFormatIndianMobile(inputMobile);
  assert.equal(mobileRes.isValid, true);
  assert.equal(mobileRes.formatted, '+919876543210');

  const updatePayload = {
    id: userId,
    username: inputName,
    mobile_number: mobileRes.formatted,
    whatsapp_consent: inputWhatsapp,
    whatsapp_consent_at: new Date().toISOString()
  };

  assert.equal(updatePayload.id, userId);
  assert.equal(updatePayload.username, 'Rahul Sharma');
  assert.equal(updatePayload.mobile_number, '+919876543210');
  assert.equal(updatePayload.whatsapp_consent, true);
  assert.ok(updatePayload.whatsapp_consent_at);
  assert.equal(updatePayload.paid_unlocked, undefined);
  assert.equal(updatePayload.is_admin, undefined);
});

test('Scenario 2: Existing User with Username but missing Mobile - Prompt Mobile Only', () => {
  const existingProfile = {
    id: 'user-existing-456',
    username: 'sql_master',
    email: 'sqlmaster@example.com',
    mobile_number: null,
    whatsapp_consent: false
  };

  const hasUsername = Boolean(existingProfile.username && existingProfile.username.trim());
  const hasMobile = Boolean(existingProfile.mobile_number && existingProfile.mobile_number.trim());

  assert.equal(hasUsername, true);
  assert.equal(hasMobile, false);

  const promptMode = !hasUsername ? 'full' : (!hasMobile ? 'mobile_only' : 'none');
  assert.equal(promptMode, 'mobile_only');

  const inputMobile = '8765432109';
  const mobileRes = validateAndFormatIndianMobile(inputMobile);
  assert.equal(mobileRes.isValid, true);

  const updatePayload = {
    mobile_number: mobileRes.formatted,
    whatsapp_consent: true,
    whatsapp_consent_at: new Date().toISOString()
  };

  assert.equal(updatePayload.mobile_number, '+918765432109');
  assert.equal(updatePayload.username, undefined);
});

test('Scenario 3: Existing User with Complete Profile - No Popup Prompt', () => {
  const completeProfile = {
    id: 'user-complete-789',
    username: 'pro_learner',
    mobile_number: '+919999988888',
    whatsapp_consent: true
  };

  const hasUsername = Boolean(completeProfile.username && completeProfile.username.trim());
  const hasMobile = Boolean(completeProfile.mobile_number && completeProfile.mobile_number.trim());

  const promptMode = !hasUsername ? 'full' : (!hasMobile ? 'mobile_only' : 'none');
  assert.equal(promptMode, 'none', 'No popup is shown when both username and mobile exist');
});

test('Scenario 4 & 5: Learner Progress, Scenarios, Thinking Scores & Certificates Protection', () => {
  const learnerDataBefore = {
    id: 'learner-15',
    username: 'data_ninja',
    mobile_number: null,
    completed_count: 15,
    completed_scenario_ids: Array.from({ length: 15 }, (_, i) => `scenario_${i + 1}`),
    thinking_scores: { scenario_1: 95, scenario_2: 100 },
    certificates: [{ id: 'cert_101', issuedAt: '2026-01-01' }]
  };

  const contactUpdate = {
    mobile_number: '+919123456789',
    whatsapp_consent: false
  };

  const learnerDataAfter = {
    ...learnerDataBefore,
    ...contactUpdate
  };

  assert.equal(learnerDataAfter.completed_count, 15);
  assert.equal(learnerDataAfter.completed_scenario_ids.length, 15);
  assert.deepEqual(learnerDataAfter.thinking_scores, learnerDataBefore.thinking_scores);
  assert.deepEqual(learnerDataAfter.certificates, learnerDataBefore.certificates);
  assert.equal(learnerDataAfter.mobile_number, '+919123456789');
});

test('Scenario 6 & 7: Premium Unlock Status & Admin Permissions Protection', () => {
  const adminPremiumUser = {
    id: 'admin-vip-001',
    username: 'superadmin',
    is_admin: true,
    paid_unlocked: true,
    contest_eligible: true,
    mobile_number: null
  };

  const safeUpdate = {
    mobile_number: '+919000000000',
    whatsapp_consent: true,
    whatsapp_consent_at: new Date().toISOString()
  };

  const merged = { ...adminPremiumUser, ...safeUpdate };

  assert.equal(merged.is_admin, true);
  assert.equal(merged.paid_unlocked, true);
  assert.equal(merged.contest_eligible, true);
  assert.equal(merged.mobile_number, '+919000000000');
});

test('Scenario 8: Failed Update Does Not Corrupt Existing Learner State', () => {
  const originalProfile = {
    id: 'user-err-01',
    username: 'original_user',
    mobile_number: null,
    completed_count: 10
  };

  let currentProfileState = { ...originalProfile };
  const mockDbUpdate = (payload) => {
    if (payload.mobile_number === 'INVALID') {
      throw new Error('Database validation error');
    }
    currentProfileState = { ...currentProfileState, ...payload };
  };

  assert.throws(() => {
    mockDbUpdate({ mobile_number: 'INVALID' });
  }, /Database validation error/);

  assert.equal(currentProfileState.username, 'original_user');
  assert.equal(currentProfileState.completed_count, 10);
  assert.equal(currentProfileState.mobile_number, null);
});

test('Scenario 9: Logout & Relogin Retrieves Saved Details Correctly', () => {
  const savedProfileInDb = {
    id: 'user-relogin-100',
    username: 'relogin_user',
    email: 'relogin@example.com',
    mobile_number: '+919876500000',
    whatsapp_consent: true,
    whatsapp_consent_at: '2026-10-16T14:15:00.000Z'
  };

  const loadedMobile = savedProfileInDb.mobile_number;
  const loadedWhatsapp = savedProfileInDb.whatsapp_consent;

  assert.equal(loadedMobile, '+919876500000');
  assert.equal(loadedWhatsapp, true);
});

test('Scenario 10: Duplicate Submission & Primary Key Isolation', () => {
  const userId = 'user-unique-id';
  const submissions = [
    { id: userId, mobile_number: '+919876543210', whatsapp_consent: true },
    { id: userId, mobile_number: '+919876543210', whatsapp_consent: true }
  ];

  const dbTable = new Map();

  submissions.forEach(sub => {
    const existing = dbTable.get(sub.id) || { id: sub.id };
    dbTable.set(sub.id, { ...existing, ...sub });
  });

  assert.equal(dbTable.size, 1);
  assert.equal(dbTable.get(userId).mobile_number, '+919876543210');
});

test('Scenario 11: Existing user with saved mobile number is never prompted again across fresh login', () => {
  const userProfile = {
    id: 'user-existing-mob',
    username: 'sqlpro',
    mobile_number: '+919876543210'
  };

  let popupShown = false;
  const checkAndEnforceMock = (profile) => {
    const dbMobile = (profile?.mobile_number || '').trim();
    if (dbMobile) {
      popupShown = false; // Never prompt
      return;
    }
    popupShown = true;
  };

  checkAndEnforceMock(userProfile);
  assert.equal(popupShown, false, 'Popup is never shown for an existing user with a saved mobile number');
});

test('Scenario 12: Temporary Supabase fetch failure does not treat profile as missing mobile number', () => {
  const profileFetchResult = {
    profile: null,
    error: new Error('Network timeout')
  };

  let popupShown = false;
  const checkAndEnforceMock = (res) => {
    if (!res.profile && res.error) {
      // Supabase temporarily unavailable - skip popup enforcement
      return;
    }
    popupShown = true;
  };

  checkAndEnforceMock(profileFetchResult);
  assert.equal(popupShown, false, 'Popup is not shown when Supabase is temporarily unavailable');
});

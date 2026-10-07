import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import {
  initNotificationsState,
  getNotifications,
  claimCertificateNotification,
  markNotificationRead,
  markAllNotificationsAsRead
} from '../js/notifications.js';
import { checkLevelCompletion } from '../js/certificate.js';
import { EMPTY } from '../js/progress.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));
const scenarios = data.scenarios;

describe('Notification System & Dynamic Premium Customers', () => {

  // 1. Certificate Notification for Past/Existing Completed Users
  it('1. Generates certificate ready notification for users who previously completed a domain + level', () => {
    // Setup mock localStorage
    const storageMap = new Map();
    global.localStorage = {
      getItem: (k) => storageMap.get(k) || null,
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k)
    };

    const userId = 'usr_past_completer_1';
    initNotificationsState(userId);

    const state = EMPTY();
    const bankingBeg = scenarios.filter(s => s.domain === 'Banking' && s.level === 'Beginner');
    assert.strictEqual(bankingBeg.length, 20);

    // Simulate user who completed 20 Banking Beginner challenges in the past
    bankingBeg.forEach((s, idx) => {
      state.entries[s.id] = {
        thinking: { response: 'Completed previously' },
        assessment: { score: 9 },
        completed: true,
        updatedAt: 1600000000000 + idx * 1000
      };
    });

    const notifs = getNotifications({
      scenarios,
      state,
      user: { id: userId, email: 'past.learner@example.com' },
      currentUsername: 'pastlearner',
      activeContest: null
    });

    // Verify certificate notification exists
    const certNotif = notifs.find(n => n.id === 'cert_Banking_Beginner');
    assert.ok(certNotif, 'Must create notification for completed Banking Beginner');
    assert.strictEqual(certNotif.type, 'certificate');
    assert.strictEqual(certNotif.domain, 'Banking');
    assert.strictEqual(certNotif.level, 'Beginner');
    assert.ok(certNotif.message.includes('Your Beginner certificate in Banking is ready to claim') || certNotif.message.includes('ready to claim'));
    assert.strictEqual(certNotif.isClaimed, false);
    assert.strictEqual(certNotif.isRead, false);
    assert.ok(certNotif.actionLabel.includes('Claim Certificate'));
  });

  // 2. Claiming Certificate updates status & prevents duplicate notifications
  it('2. Clicking Claim marks notification as claimed & read without creating duplicates', () => {
    const storageMap = new Map();
    global.localStorage = {
      getItem: (k) => storageMap.get(k) || null,
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k)
    };

    const userId = 'usr_claim_test_2';
    initNotificationsState(userId);

    const state = EMPTY();
    const retailInt = scenarios.filter(s => s.domain === 'Retail' && s.level === 'Intermediate');
    retailInt.forEach((s, idx) => {
      state.entries[s.id] = { assessment: { score: 8 }, completed: true, updatedAt: 1600000000000 + idx };
    });

    // Get notifications before claim
    let notifs = getNotifications({
      scenarios,
      state,
      user: { id: userId, email: 'retailer@example.com' },
      currentUsername: 'retailer',
      activeContest: null
    });

    const notifId = 'cert_Retail_Intermediate';
    let retailNotif = notifs.find(n => n.id === notifId);
    assert.ok(retailNotif);
    assert.strictEqual(retailNotif.isClaimed, false);
    assert.strictEqual(retailNotif.isRead, false);

    // User claims the certificate
    claimCertificateNotification(notifId);

    // Get notifications after claim
    notifs = getNotifications({
      scenarios,
      state,
      user: { id: userId, email: 'retailer@example.com' },
      currentUsername: 'retailer',
      activeContest: null
    });

    retailNotif = notifs.find(n => n.id === notifId);
    assert.ok(retailNotif, 'Notification still exists in history with claimed status');
    assert.strictEqual(retailNotif.isClaimed, true, 'Must now be marked claimed');
    assert.strictEqual(retailNotif.isRead, true, 'Claimed notification is marked read');
    assert.ok(retailNotif.actionLabel.includes('View Certificate'), 'Action label updates to View');

    // Verify unread count excludes claimed
    const unreadCount = notifs.filter(n => !n.isRead && !n.isClaimed).length;
    // Only announcement might be unread, but cert is claimed
    const unreadCerts = notifs.filter(n => n.type === 'certificate' && !n.isClaimed && !n.isRead);
    assert.strictEqual(unreadCerts.length, 0, 'No unread/unclaimed certificate notifications remaining');
  });

  // 3. Contest Launched and Admin Announcement notifications
  it('3. Supports contest launched notifications and app announcements', () => {
    const storageMap = new Map();
    global.localStorage = {
      getItem: (k) => storageMap.get(k) || null,
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k)
    };

    const userId = 'usr_contest_notif_3';
    initNotificationsState(userId);

    const activeContest = {
      id: 'contest_autumn_2026',
      title: 'Crack SQL Grand Challenge #2',
      status: 'PUBLISHED',
      prize_first: '₹1000',
      created_at: new Date().toISOString()
    };

    const notifs = getNotifications({
      scenarios,
      state: EMPTY(),
      user: { id: userId, email: 'contestant@example.com' },
      currentUsername: 'contestant',
      activeContest
    });

    const contestNotif = notifs.find(n => n.id === 'contest_contest_autumn_2026');
    assert.ok(contestNotif, 'Contest launched notification must exist');
    assert.strictEqual(contestNotif.type, 'contest');
    assert.ok(contestNotif.title.includes('Crack SQL Grand Challenge #2'));

    const announcementNotif = notifs.find(n => n.type === 'announcement');
    assert.ok(announcementNotif, 'Announcement notification must exist');

    // Mark all as read
    markAllNotificationsAsRead(notifs);

    const afterReadNotifs = getNotifications({
      scenarios,
      state: EMPTY(),
      user: { id: userId, email: 'contestant@example.com' },
      currentUsername: 'contestant',
      activeContest
    });

    const unreadRemaining = afterReadNotifs.filter(n => !n.isRead && !n.isClaimed).length;
    assert.strictEqual(unreadRemaining, 0, 'Mark all as read must clear all unread badges');
  });

  // 4. Dynamic Premium Customers from Supabase in admin.js
  it('4. admin.js dynamically maps premium customers (profiles.paid_unlocked = true) without hardcoded customer lists', () => {
    const adminJs = fs.readFileSync('./js/admin.js', 'utf8');

    // Verify no hardcoded email injection blocks
    assert.strictEqual(adminJs.includes("email: 'sriramgokul6666@gmail.com'"), false, 'Must not hardcode sriramgokul email in admin.js');
    assert.strictEqual(adminJs.includes("customer_email: 'sundar.developer07@gmail.com'"), false, 'Must not hardcode sundar email in admin.js');

    // Verify dynamic filtering on profiles.paid_unlocked === true
    assert.ok(adminJs.includes('.filter(p => p.paid_unlocked === true)'), 'Must filter profiles where paid_unlocked is true');
    assert.ok(adminJs.includes('usernameDisplay'), 'Must derive dynamic usernameDisplay');
    assert.ok(adminJs.includes('payment_status'), 'Must map dynamic payment status');
  });

  // 5. index.html contains notification badge and dropdown UI
  it('5. index.html contains notification badge and dropdown elements', () => {
    const indexHtml = fs.readFileSync('./index.html', 'utf8');
    assert.ok(indexHtml.includes('id="notificationsBtn"'), 'Must have notificationsBtn');
    assert.ok(indexHtml.includes('id="notificationBadge"'), 'Must have notificationBadge');
    assert.ok(indexHtml.includes('id="notificationsDropdown"'), 'Must have notificationsDropdown');
    assert.ok(indexHtml.includes('id="notificationsList"'), 'Must have notificationsList');
  });
});

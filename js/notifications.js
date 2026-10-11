// Think and Crack SQL — Notification System
// Provides dynamic notifications for:
// 1. Certificate ready to claim (for past and future completed domain + levels)
// 2. Contest launched (published contests from Supabase)
// 3. Admin announcements / app updates

import { CERTIFICATE_DOMAINS, CERTIFICATE_LEVELS, checkLevelCompletion, formatCompletionDate } from './certificate.js';
import { escapeHtml } from './util.js';

let notificationsState = {
  readIds: new Set(),
  claimedIds: new Set()
};

let currentUserId = null;

export function initNotificationsState(userId) {
  currentUserId = userId || 'guest';
  try {
    const key = `cracksql_notifications_${currentUserId}`;
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      notificationsState.readIds = new Set(Array.isArray(parsed.readIds) ? parsed.readIds : []);
      notificationsState.claimedIds = new Set(Array.isArray(parsed.claimedIds) ? parsed.claimedIds : []);
    } else {
      notificationsState.readIds = new Set();
      notificationsState.claimedIds = new Set();
    }
  } catch (err) {
    console.warn('Notifications state load error:', err);
    notificationsState.readIds = new Set();
    notificationsState.claimedIds = new Set();
  }
}

export function saveNotificationsState() {
  try {
    const key = `cracksql_notifications_${currentUserId || 'guest'}`;
    localStorage.setItem(key, JSON.stringify({
      readIds: Array.from(notificationsState.readIds),
      claimedIds: Array.from(notificationsState.claimedIds)
    }));
  } catch (err) {
    console.warn('Notifications state save error:', err);
  }
}

/**
 * Builds all eligible notifications for the current user and state
 */
export function getNotifications({ scenarios, state, user, currentUsername, activeContest, adminNotifications = [] }) {
  const list = [];

  // 1. Certificate Notifications (Both existing past completions and future completions)
  if (Array.isArray(scenarios) && scenarios.length > 0 && state) {
    for (const domain of CERTIFICATE_DOMAINS) {
      for (const level of CERTIFICATE_LEVELS) {
        const completion = checkLevelCompletion(domain, level, scenarios, state);
        if (completion.isCompleted) {
          const notifId = `cert_${domain.replace(/\s+/g, '_')}_${level}`;
          const isClaimed = notificationsState.claimedIds.has(notifId);
          const isRead = notificationsState.readIds.has(notifId) || isClaimed;

          list.push({
            id: notifId,
            type: 'certificate',
            domain,
            level,
            title: `🏆 ${level} Certificate Ready`,
            message: `Your ${level} certificate for ${domain} is ready to claim.`,
            completionDate: completion.completionDate || formatCompletionDate(Date.now()),
            timestamp: completion.completedTimestamp || Date.now(),
            isClaimed,
            isRead,
            actionLabel: isClaimed ? 'View Certificate 🏆' : 'Claim Certificate 🎓'
          });
        }
      }
    }
  }

  // 2. Contest Launched Notifications
  if (activeContest && activeContest.id && (activeContest.status === 'PUBLISHED' || activeContest.status === 'REGISTRATION_CLOSED')) {
    const notifId = `contest_${activeContest.id}`;
    const isRead = notificationsState.readIds.has(notifId);
    list.push({
      id: notifId,
      type: 'contest',
      contestId: activeContest.id,
      title: `🚀 Live Contest: ${activeContest.title || 'Crack SQL Thinking Challenge'}`,
      message: `A new SQL thinking challenge is active! Test your data engineering problem solving.`,
      timestamp: activeContest.created_at ? new Date(activeContest.created_at).getTime() : Date.now(),
      isRead,
      isClaimed: false,
      actionLabel: 'View Contest 🏆'
    });
  }

  // 3. Dynamic Admin Broadcast Notifications from Supabase
  if (Array.isArray(adminNotifications) && adminNotifications.length > 0) {
    adminNotifications.forEach(adminNotif => {
      if (!adminNotif || !adminNotif.id || adminNotif.is_active === false) return;
      const notifId = `admin_${adminNotif.id}`;
      const isRead = notificationsState.readIds.has(notifId);
      list.push({
        id: notifId,
        type: adminNotif.type || 'announcement',
        title: adminNotif.title,
        message: adminNotif.message,
        actionTarget: adminNotif.action_target || 'home',
        timestamp: adminNotif.created_at ? new Date(adminNotif.created_at).getTime() : Date.now(),
        isRead,
        isClaimed: false,
        actionLabel: adminNotif.type === 'contest' ? 'View Contest 🏆' : (adminNotif.action_target === 'progress' ? 'View Certificates →' : 'View Update →')
      });
    });
  }

  // 4. Default Admin Announcement
  const appUpdateId = 'announcement_certificates_v1';
  if (!list.some(n => n.id === appUpdateId)) {
    list.push({
      id: appUpdateId,
      type: 'announcement',
      title: '📢 Official Certificates Available',
      message: 'Master all 20 scenarios in any domain & level to earn your official Crack SQL Certificate of Completion.',
      timestamp: new Date('2026-10-01T00:00:00Z').getTime(),
      isRead: notificationsState.readIds.has(appUpdateId),
      isClaimed: false,
      actionLabel: 'View Certificates →'
    });
  }

  // Sort by timestamp descending (newest first), but unread/unclaimed at the top
  list.sort((a, b) => {
    const aUnread = (!a.isRead && !a.isClaimed) ? 1 : 0;
    const bUnread = (!b.isRead && !b.isClaimed) ? 1 : 0;
    if (aUnread !== bUnread) return bUnread - aUnread;
    return (b.timestamp || 0) - (a.timestamp || 0);
  });

  return list;
}

/**
 * Claims a certificate from a notification: marks it claimed + read, saves state
 */
export function claimCertificateNotification(notifId) {
  notificationsState.claimedIds.add(notifId);
  notificationsState.readIds.add(notifId);
  saveNotificationsState();
}

/**
 * Marks a single notification as read
 */
export function markNotificationRead(notifId) {
  notificationsState.readIds.add(notifId);
  saveNotificationsState();
}

/**
 * Marks all notifications as read
 */
export function markAllNotificationsAsRead(notifications) {
  if (Array.isArray(notifications)) {
    notifications.forEach(n => notificationsState.readIds.add(n.id));
  }
  saveNotificationsState();
}

/**
 * Renders the notification badge and dropdown UI
 */
export function renderNotificationsUI({ scenarios, state, user, currentUsername, activeContest, adminNotifications = [] }) {
  const notifications = getNotifications({ scenarios, state, user, currentUsername, activeContest, adminNotifications });
  const unreadCount = notifications.filter(n => !n.isRead && !n.isClaimed).length;

  // Update badge counters
  const badgeEls = document.querySelectorAll('.notification-badge, #notificationBadge, #practiceNotificationBadge');
  badgeEls.forEach(el => {
    if (el) {
      if (unreadCount > 0) {
        el.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        el.style.display = 'inline-flex';
      } else {
        el.style.display = 'none';
      }
    }
  });

  const headerCountEl = document.getElementById('notificationsHeaderCount');
  if (headerCountEl) {
    if (unreadCount > 0) {
      headerCountEl.textContent = `${unreadCount} new`;
      headerCountEl.style.display = 'inline-block';
    } else {
      headerCountEl.style.display = 'none';
    }
  }

  // Render list inside dropdown
  const listContainer = document.getElementById('notificationsList');
  if (listContainer) {
    if (notifications.length === 0) {
      listContainer.innerHTML = `
        <div style="padding:28px 16px;text-align:center;color:var(--muted);font-size:13px;">
          <div style="font-size:24px;margin-bottom:6px;">✨</div>
          <div style="font-weight:700;color:var(--ink);margin-bottom:2px;">All Caught Up</div>
          <div>No new notifications right now.</div>
        </div>
      `;
      return;
    }

    listContainer.innerHTML = notifications.map(item => {
      const isUnread = !item.isRead && !item.isClaimed;
      let icon = '🔔';
      let iconBg = '#eff6ff';
      if (item.type === 'certificate') {
        icon = '🏆';
        iconBg = '#fef3c7';
      } else if (item.type === 'contest') {
        icon = '🚀';
        iconBg = '#f0fdf4';
      } else if (item.type === 'announcement') {
        icon = '📢';
        iconBg = '#ede9fe';
      }

      const formattedTime = formatNotificationTime(item.timestamp);

      return `
        <div class="notification-item ${isUnread ? 'unread' : 'read'}" id="notif-item-${escapeHtml(item.id)}">
          <div class="notif-icon-box" style="background:${iconBg};">
            ${icon}
          </div>
          <div class="notif-content">
            <div class="notif-title-row">
              <span class="notif-title">${escapeHtml(item.title)}</span>
              ${isUnread ? '<span class="notif-unread-dot"></span>' : ''}
            </div>
            <div class="notif-msg">${escapeHtml(item.message)}</div>
            <div class="notif-footer-row">
              <span class="notif-time">${escapeHtml(formattedTime)}</span>
              <button class="notif-action-btn ${item.type === 'certificate' && !item.isClaimed ? 'primary' : 'secondary'}" 
                onclick="window.handleNotificationAction('${escapeHtml(item.id)}', '${escapeHtml(item.type)}', '${escapeHtml(item.domain || '')}', '${escapeHtml(item.level || '')}', '${escapeHtml(item.completionDate || '')}')">
                ${escapeHtml(item.actionLabel)}
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }
}

function formatNotificationTime(timestamp) {
  if (!timestamp) return 'Recently';
  const diff = Date.now() - Number(timestamp);
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  try {
    return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return 'Recently';
  }
}

// Think and Crack SQL — Certificate System
// Primary Visual Reference: image.png
// Generates, manages, and renders Certificates of Completion across 7 domains and 3 levels (21 total).

export const CERTIFICATE_DOMAINS = [
  'Banking',
  'Healthcare',
  'Insurance',
  'Retail',
  'Capital Markets',
  'Semiconductor',
  'Education'
];

export const CERTIFICATE_LEVELS = [
  'Beginner',
  'Intermediate',
  'Expert'
];

/**
 * Standardizes level text for display on certificate pill:
 * "BEGINNER LEVEL", "INTERMEDIATE LEVEL", "EXPERT LEVEL"
 */
export function formatCertificateLevel(level) {
  const norm = String(level || 'Beginner').trim().toUpperCase();
  if (norm.endsWith('LEVEL')) return norm;
  return `${norm} LEVEL`;
}

/**
 * Standardizes domain text for display on certificate:
 * "BANKING", "HEALTHCARE", "INSURANCE", "RETAIL", "CAPITAL MARKETS", "SEMICONDUCTOR", "EDUCATION"
 */
export function formatCertificateDomain(domain) {
  return String(domain || 'Banking').trim().toUpperCase();
}

/**
 * Derives user display name from authenticated profile / metadata
 */
export function getLearnerDisplayName(user, currentUsername) {
  if (!user) return 'Guest Learner';
  const meta = user.user_metadata || {};
  if (meta.full_name && String(meta.full_name).trim()) return String(meta.full_name).trim();
  if (meta.name && String(meta.name).trim()) return String(meta.name).trim();
  if (currentUsername && String(currentUsername).trim()) return String(currentUsername).trim();
  if (user.email) {
    const prefix = user.email.split('@')[0];
    return prefix.charAt(0).toUpperCase() + prefix.slice(1);
  }
  return 'Learner';
}

/**
 * Formats completion date into human-readable format e.g. "October 7, 2026"
 */
export function formatCompletionDate(dateVal) {
  if (!dateVal) {
    dateVal = new Date();
  }
  const d = (dateVal instanceof Date) ? dateVal : new Date(dateVal);
  if (isNaN(d.getTime())) {
    return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Checks whether all 20 valid scenarios for a domain and level have been successfully completed.
 * Returns authoritative completion data.
 */
export function checkLevelCompletion(domain, level, scenarios, state) {
  if (!Array.isArray(scenarios) || !domain || !level) {
    return {
      domain,
      level,
      isCompleted: false,
      completedCount: 0,
      totalCount: 20,
      completionDate: null,
      completedScenarioIds: []
    };
  }

  const pool = scenarios.filter(s => s.domain === domain && s.level === level);
  const totalCount = pool.length; // 20
  const completedScenarios = [];
  let latestTimestamp = 0;

  for (const scenario of pool) {
    const entry = state?.entries?.[scenario.id];
    if (entry) {
      const score = (typeof entry.assessment?.score === 'number') ? entry.assessment.score : null;
      const isSolved = (score !== null ? score >= 7 : !!entry.completed);
      if (isSolved) {
        completedScenarios.push(scenario);
        if (entry.updatedAt && entry.updatedAt > latestTimestamp) {
          latestTimestamp = entry.updatedAt;
        }
      }
    }
  }

  const isCompleted = (totalCount > 0 && completedScenarios.length >= totalCount);
  const questionsCompleted = isCompleted;
  const feedbackSubmitted = isLevelFeedbackSubmitted(domain, level, state);
  const completionDate = isCompleted
    ? formatCompletionDate(latestTimestamp || Date.now())
    : null;

  return {
    domain,
    level,
    isCompleted,
    questionsCompleted,
    feedbackSubmitted,
    completedCount: completedScenarios.length,
    totalCount,
    completionDate,
    completedTimestamp: latestTimestamp || (isCompleted ? Date.now() : 0),
    completedScenarioIds: completedScenarios.map(s => s.id)
  };
}

/**
 * Returns all earned certificates (out of 21) for the current user and state.
 */
export function getEarnedCertificates(scenarios, state, user, currentUsername) {
  const learnerName = getLearnerDisplayName(user, currentUsername);
  const results = [];

  for (const domain of CERTIFICATE_DOMAINS) {
    for (const level of CERTIFICATE_LEVELS) {
      const status = checkLevelCompletion(domain, level, scenarios, state);
      if (status.isCompleted) {
        results.push({
          domain,
          level,
          learnerName,
          completionDate: status.completionDate,
          completedTimestamp: status.completedTimestamp,
          completedCount: status.completedCount,
          totalCount: status.totalCount
        });
      }
    }
  }

  return results;
}

/**
 * Returns complete progress status across all 21 certificates (7 domains x 3 levels).
 */
export function getAllCertificatesStatus(scenarios, state, user, currentUsername) {
  const learnerName = getLearnerDisplayName(user, currentUsername);
  const list = [];

  for (const domain of CERTIFICATE_DOMAINS) {
    for (const level of CERTIFICATE_LEVELS) {
      const status = checkLevelCompletion(domain, level, scenarios, state);
      list.push({
        domain,
        level,
        learnerName,
        isCompleted: status.isCompleted,
        completedCount: status.completedCount,
        totalCount: status.totalCount,
        completionDate: status.completionDate,
        completedTimestamp: status.completedTimestamp
      });
    }
  }

  return list;
}

/**
 * Generates the clean, vector-crisp Certificate SVG matching image.png exactly.
 * ViewBox 1200 x 800 (landscape 3:2).
 */
export function generateCertificateSvg({ userName, level, domain, completionDate }) {
  const cleanName = String(userName || 'Learner').trim();
  const levelDisplay = formatCertificateLevel(level);
  const domainDisplay = formatCertificateDomain(domain);
  const dateDisplay = formatCompletionDate(completionDate);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="100%" height="100%" style="background:#ffffff;font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <defs>
    <!-- Gold Linear Gradient for accents -->
    <linearGradient id="certGoldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#b88628"/>
      <stop offset="25%" stop-color="#dfb758"/>
      <stop offset="50%" stop-color="#f5d77f"/>
      <stop offset="75%" stop-color="#d4a338"/>
      <stop offset="100%" stop-color="#a6771e"/>
    </linearGradient>

    <!-- Deep Blue Ribbon Gradient -->
    <linearGradient id="certNavyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#071b38"/>
      <stop offset="50%" stop-color="#0c2e63"/>
      <stop offset="100%" stop-color="#144186"/>
    </linearGradient>

    <!-- Vibrant Royal Blue Ribbon Gradient -->
    <linearGradient id="certRoyalGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0d3da6"/>
      <stop offset="50%" stop-color="#1856db"/>
      <stop offset="100%" stop-color="#2563eb"/>
    </linearGradient>

    <!-- Subtle Background Wave Gradient -->
    <linearGradient id="certBgWaveGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#eff6ff" stop-opacity="0.8"/>
      <stop offset="50%" stop-color="#f8fafc" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- Clean White Canvas -->
  <rect width="1200" height="800" fill="#ffffff"/>

  <!-- Subtle Translucent Background Ambient Waves -->
  <path d="M 0,0 L 480,0 C 380,240 220,440 0,560 Z" fill="url(#certBgWaveGrad)"/>
  <path d="M 1200,800 L 720,800 C 820,560 980,360 1200,240 Z" fill="url(#certBgWaveGrad)"/>
  <path d="M 0,0 C 400,200 800,100 1200,320 L 1200,0 Z" fill="#f8fafc" opacity="0.35"/>
  <path d="M 0,480 C 400,700 800,600 1200,800 L 0,800 Z" fill="#f8fafc" opacity="0.35"/>

  <!-- Outer Navy Inner Framed Border with Classic Chamfered Notched Corners -->
  <path d="M 52,32 L 1148,32 
           L 1168,52 L 1168,748 
           L 1148,768 L 52,768 
           L 32,748 L 32,52 Z" 
        fill="none" stroke="#0a2246" stroke-width="2.5" stroke-linejoin="round"/>

  <!-- Inner Subtle Accent Line -->
  <path d="M 56,36 L 1144,36 
           L 1164,56 L 1164,744 
           L 1144,764 L 56,764 
           L 36,744 L 36,56 Z" 
        fill="none" stroke="#e2e8f0" stroke-width="1" stroke-linejoin="round" opacity="0.6"/>

  <!-- Corner Brackets in Top-Right and Bottom-Left -->
  <path d="M 1120,42 L 1158,42 L 1158,80" fill="none" stroke="#0a2246" stroke-width="2"/>
  <path d="M 42,720 L 42,758 L 80,758" fill="none" stroke="#0a2246" stroke-width="2"/>

  <!-- TOP-LEFT CORNER FLOWING WAVES (Matching image.png) -->
  <!-- 1. Deep Navy Main Wave -->
  <path d="M 0,0 L 260,0 C 220,110 130,220 0,320 Z" fill="url(#certNavyGrad)"/>
  
  <!-- 2. Middle Royal Blue Layer -->
  <path d="M 0,0 L 200,0 C 170,85 100,170 0,250 Z" fill="url(#certRoyalGrad)"/>

  <!-- 3. Outer Flowing Gold Ribbon -->
  <path d="M 0,320 C 130,220 220,110 260,0 L 285,0 C 240,125 145,245 0,355 Z" fill="url(#certGoldGrad)"/>

  <!-- 4. Deep Accent Overlay Ribbon -->
  <path d="M 0,0 L 130,0 C 110,50 65,115 0,170 Z" fill="#06162d"/>


  <!-- BOTTOM-RIGHT CORNER FLOWING WAVES (Matching image.png) -->
  <!-- 1. Flowing Gold Ribbon -->
  <path d="M 1200,480 C 1070,580 980,690 940,800 L 915,800 C 960,675 1055,555 1200,445 Z" fill="url(#certGoldGrad)"/>

  <!-- 2. Deep Navy Main Wave -->
  <path d="M 1200,800 L 940,800 C 980,690 1070,580 1200,480 Z" fill="url(#certNavyGrad)"/>

  <!-- 3. Middle Royal Blue Layer -->
  <path d="M 1200,800 L 1000,800 C 1030,715 1100,630 1200,550 Z" fill="url(#certRoyalGrad)"/>

  <!-- 4. Deep Accent Overlay Ribbon -->
  <path d="M 1200,800 L 1070,800 C 1090,750 1135,685 1200,630 Z" fill="#06162d"/>


  <!-- ============================================================ -->
  <!-- EXACT CONTENT STRUCTURE 1 TO 10 (Centered vertically & horizontally) -->
  <!-- ============================================================ -->

  <!-- 1. TOP: Crack SQL Brand -->
  <g transform="translate(600, 115)">
    <text text-anchor="middle" font-size="44" font-weight="900" letter-spacing="-0.5">
      <tspan fill="#0a192f">Crack </tspan>
      <tspan fill="#0052cc">SQL</tspan>
    </text>
  </g>

  <!-- 2. MAIN HEADING: CERTIFICATE OF COMPLETION -->
  <g transform="translate(600, 165)">
    <text text-anchor="middle" font-family="'Cinzel','Playfair Display','Georgia',serif" font-size="24" font-weight="700" fill="#b48324" letter-spacing="5">
      CERTIFICATE OF COMPLETION
    </text>
  </g>

  <!-- Divider 1: Delicate Gold Diamond & Accent Lines -->
  <g transform="translate(600, 195)">
    <line x1="-160" y1="0" x2="-20" y2="0" stroke="url(#certGoldGrad)" stroke-width="1.2"/>
    <path d="M 0,-6 L 6,0 L 0,6 L -6,0 Z" fill="#b48324"/>
    <line x1="20" y1="0" x2="160" y2="0" stroke="url(#certGoldGrad)" stroke-width="1.2"/>
  </g>

  <!-- 3. PRESENTATION TEXT: This certificate is proudly presented to -->
  <g transform="translate(600, 235)">
    <text text-anchor="middle" font-size="18" font-weight="500" fill="#334155" letter-spacing="0.2">
      This certificate is proudly presented to
    </text>
  </g>

  <!-- 4. DYNAMIC LEARNER NAME: [USER NAME] -->
  <g transform="translate(600, 298)">
    <text text-anchor="middle" font-family="'Cinzel','Playfair Display','Georgia',serif" font-size="40" font-weight="800" fill="#0a2246" letter-spacing="0.5">
      ${escapeXml(cleanName)}
    </text>
  </g>

  <!-- 5. COMPLETION TEXT: for successfully completing -->
  <g transform="translate(600, 350)">
    <text text-anchor="middle" font-size="17" font-weight="500" fill="#475569" letter-spacing="0.2">
      for successfully completing
    </text>
  </g>

  <!-- 6. DYNAMIC LEVEL PILL: [LEVEL] LEVEL -->
  <g transform="translate(600, 400)">
    <!-- Pill background container -->
    <rect x="-140" y="-18" width="280" height="36" rx="18" fill="#dbeafe"/>
    <text text-anchor="middle" y="6" font-size="17" font-weight="800" fill="#0052cc" letter-spacing="1">
      ${escapeXml(levelDisplay)}
    </text>
  </g>

  <!-- 7. DOMAIN: in [DOMAIN] -->
  <g transform="translate(600, 452)">
    <text text-anchor="middle" font-size="16" font-weight="500" fill="#334155">
      in
    </text>
  </g>
  <g transform="translate(600, 492)">
    <text text-anchor="middle" font-size="28" font-weight="800" fill="#0052cc" letter-spacing="0.8">
      ${escapeXml(domainDisplay)}
    </text>
  </g>

  <!-- 8. COMPLETION STATEMENT -->
  <g transform="translate(600, 542)">
    <text text-anchor="middle" font-size="16" font-weight="500" fill="#334155" line-height="1.5">
      <tspan x="0" dy="0">The learner has successfully completed 20 SQL scenarios</tspan>
      <tspan x="0" dy="24">and demonstrated the required SQL thinking skills for this level.</tspan>
    </text>
  </g>

  <!-- Divider 2: Delicate Gold Diamond & Accent Lines -->
  <g transform="translate(600, 598)">
    <line x1="-120" y1="0" x2="-18" y2="0" stroke="url(#certGoldGrad)" stroke-width="1.2"/>
    <path d="M 0,-5 L 5,0 L 0,5 L -5,0 Z" fill="#b48324"/>
    <line x1="18" y1="0" x2="120" y2="0" stroke="url(#certGoldGrad)" stroke-width="1.2"/>
  </g>

  <!-- 9. COMPLETION DATE -->
  <g transform="translate(600, 630)">
    <text text-anchor="middle" font-size="13" font-weight="600" fill="#64748b" letter-spacing="0.5">
      Completion Date
    </text>
  </g>
  <g transform="translate(600, 658)">
    <text text-anchor="middle" font-size="20" font-weight="800" fill="#0a2246" letter-spacing="0.3">
      ${escapeXml(dateDisplay)}
    </text>
  </g>

  <!-- Divider 3: Delicate Gold Diamond & Accent Lines -->
  <g transform="translate(600, 686)">
    <line x1="-80" y1="0" x2="-14" y2="0" stroke="url(#certGoldGrad)" stroke-width="1"/>
    <path d="M 0,-4 L 4,0 L 0,4 L -4,0 Z" fill="#b48324"/>
    <line x1="14" y1="0" x2="80" y2="0" stroke="url(#certGoldGrad)" stroke-width="1"/>
  </g>

  <!-- 10. FOOTER: Powered by Data to Dashboard -->
  <g transform="translate(600, 726)">
    <text text-anchor="middle" font-size="15" font-weight="500" fill="#1e293b">
      <tspan>Powered by </tspan>
      <tspan font-weight="700" fill="#0052cc">Data to Dashboard</tspan>
    </text>
  </g>
</svg>`;
}

function escapeXml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Downloads high-resolution 2400 x 1600 (300 DPI clarity) PNG certificate.
 */
export async function downloadCertificateImage(data) {
  return new Promise((resolve, reject) => {
    try {
      const svgString = generateCertificateSvg(data);
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const URL = window.URL || window.webkitURL || window;
      const blobUrl = URL.createObjectURL(blob);

      const img = new Image();
      img.onload = () => {
        try {
          const width = 2400;
          const height = 1600;
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');

          // High quality rendering
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);

          URL.revokeObjectURL(blobUrl);

          canvas.toBlob((pngBlob) => {
            if (!pngBlob) {
              reject(new Error('Failed to generate PNG blob'));
              return;
            }
            const link = document.createElement('a');
            const safeDomain = String(data.domain || 'Domain').replace(/[^a-zA-Z0-9]/g, '_');
            const safeLevel = String(data.level || 'Level').replace(/[^a-zA-Z0-9]/g, '_');
            link.download = `Crack_SQL_Certificate_${safeDomain}_${safeLevel}.png`;
            link.href = URL.createObjectURL(pngBlob);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(link.href), 1500);
            resolve(true);
          }, 'image/png');
        } catch (canvasErr) {
          URL.revokeObjectURL(blobUrl);
          reject(canvasErr);
        }
      };

      img.onerror = (e) => {
        URL.revokeObjectURL(blobUrl);
        reject(new Error('Failed to load certificate SVG for rasterization: ' + e));
      };

      img.src = blobUrl;
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Triggers clean print/save-as-PDF dialog for landscape certificate.
 */
export function printCertificate(data) {
  const svgString = generateCertificateSvg(data);
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to print/download PDF');
    return;
  }
  printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <title>Crack SQL Certificate — ${escapeXml(data.domain)} ${escapeXml(data.level)}</title>
  <style>
    @page {
      size: A4 landscape;
      margin: 0;
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #ffffff;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    svg {
      width: 100vw;
      height: 100vh;
      max-width: 100vw;
      max-height: 100vh;
      display: block;
    }
  </style>
</head>
<body>
  ${svgString}
  <script>
    window.onload = function() {
      setTimeout(function() {
        window.print();
        window.close();
      }, 300);
    };
  <\/script>
</body>
</html>`);
  printWindow.document.close();
}

/**
 * Progression & Level Lock System
 * 7 Domains in sequential order:
 * Banking → Healthcare → Insurance → Retail → Capital Markets → Semiconductor → Education
 * 3 Levels per domain: Beginner → Intermediate → Expert (20 questions each)
 */
export const ORDERED_DOMAINS = [
  'Banking',
  'Healthcare',
  'Insurance',
  'Retail',
  'Capital Markets',
  'Semiconductor',
  'Education'
];

export const ORDERED_LEVELS = [
  'Beginner',
  'Intermediate',
  'Expert'
];

export function isLevelQuestionsCompleted(domain, level, scenarios, state) {
  if (!domain || !level || !Array.isArray(scenarios)) return false;
  const pool = scenarios.filter(s => s.domain === domain && s.level === level);
  if (!pool.length) return false;
  let solved = 0;
  for (const s of pool) {
    const entry = state?.entries?.[s.id];
    if (entry) {
      const score = (typeof entry.assessment?.score === 'number') ? entry.assessment.score : null;
      if (score !== null ? score >= 7 : !!entry.completed) {
        solved++;
      }
    }
  }
  return solved >= pool.length;
}

export function isLevelFeedbackSubmitted(domain, level, state) {
  if (!domain || !level) return false;
  const key = `${domain}_${level}`;
  if (state?.levelFeedback && state.levelFeedback[key]) {
    return true;
  }
  if (typeof window !== 'undefined' && Array.isArray(window.userFeedbackList)) {
    const found = window.userFeedbackList.some(f => f.domain === domain && f.level === level);
    if (found) {
      if (state) {
        state.levelFeedback = state.levelFeedback || {};
        state.levelFeedback[key] = { submittedAt: Date.now() };
      }
      return true;
    }
  }
  return false;
}

export function isLevelCompleted(domain, level, scenarios, state) {
  return isLevelQuestionsCompleted(domain, level, scenarios, state) && isLevelFeedbackSubmitted(domain, level, state);
}

export function isDomainCompleted(domain, scenarios, state) {
  return ORDERED_LEVELS.every(lvl => isLevelCompleted(domain, lvl, scenarios, state));
}

export function isDomainUnlocked(domain, scenarios, state) {
  const idx = ORDERED_DOMAINS.indexOf(domain);
  if (idx <= 0) return true; // Domain 1 (Banking) is always unlocked
  const prevDomain = ORDERED_DOMAINS[idx - 1];
  return isDomainCompleted(prevDomain, scenarios, state);
}

export function isLevelUnlocked(domain, level, scenarios, state) {
  if (!isDomainUnlocked(domain, scenarios, state)) return false;
  if (level === 'Beginner') return true;
  if (level === 'Intermediate') {
    return isLevelCompleted(domain, 'Beginner', scenarios, state);
  }
  if (level === 'Expert') {
    return isLevelCompleted(domain, 'Intermediate', scenarios, state);
  }
  return false;
}

export function getFirstUnlockedLevel(domain, scenarios, state) {
  for (const lvl of ORDERED_LEVELS) {
    if (isLevelUnlocked(domain, lvl, scenarios, state) && !isLevelCompleted(domain, lvl, scenarios, state)) {
      return lvl;
    }
  }
  return 'Beginner';
}

export function getNextProgressionTarget(domain, level) {
  if (level === 'Beginner') {
    return { type: 'level', nextDomain: domain, nextLevel: 'Intermediate', label: 'Intermediate Level' };
  }
  if (level === 'Intermediate') {
    return { type: 'level', nextDomain: domain, nextLevel: 'Expert', label: 'Expert Level' };
  }
  if (level === 'Expert') {
    const idx = ORDERED_DOMAINS.indexOf(domain);
    if (idx >= 0 && idx < ORDERED_DOMAINS.length - 1) {
      const nextDomain = ORDERED_DOMAINS[idx + 1];
      return { type: 'domain', nextDomain, nextLevel: 'Beginner', label: `${nextDomain} (Beginner)` };
    }
    return { type: 'complete', nextDomain: null, nextLevel: null, label: 'All Domains Completed!' };
  }
  return { type: 'level', nextDomain: domain, nextLevel: 'Intermediate', label: 'Intermediate Level' };
}

/**
 * Generates an Instagram-ready square (1080x1080) share SVG based on certificate data.
 */
export function generateInstagramShareSvg({ userName, level, domain, completionDate }) {
  const cleanName = String(userName || 'Learner').trim();
  const levelDisplay = formatCertificateLevel(level);
  const domainDisplay = formatCertificateDomain(domain);
  const dateDisplay = formatCompletionDate(completionDate);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="100%" height="100%" style="background:#071b38;font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <defs>
    <linearGradient id="igGold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#b88628"/>
      <stop offset="50%" stop-color="#dfb758"/>
      <stop offset="100%" stop-color="#a6771e"/>
    </linearGradient>
    <linearGradient id="igCardBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#f8fafc"/>
    </linearGradient>
  </defs>

  <rect width="1080" height="1080" fill="#071b38"/>
  <circle cx="540" cy="540" r="480" fill="#0c2e63" opacity="0.4"/>

  <!-- Outer Gold Decorative Border -->
  <rect x="60" y="60" width="960" height="960" rx="32" fill="none" stroke="url(#igGold)" stroke-width="3"/>
  <rect x="72" y="72" width="936" height="936" rx="24" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.15"/>

  <!-- Central Card -->
  <rect x="110" y="110" width="860" height="860" rx="20" fill="url(#igCardBg)" filter="drop-shadow(0 20px 40px rgba(0,0,0,0.3))"/>

  <!-- Top Brand -->
  <g transform="translate(540, 185)">
    <text text-anchor="middle" font-size="38" font-weight="900">
      <tspan fill="#0a192f">Crack </tspan>
      <tspan fill="#0052cc">SQL</tspan>
    </text>
  </g>

  <!-- Badge: 20 Questions Completed -->
  <g transform="translate(540, 250)">
    <rect x="-160" y="-18" width="320" height="36" rx="18" fill="#dbeafe"/>
    <text text-anchor="middle" y="6" font-size="15" font-weight="800" fill="#0052cc" letter-spacing="0.5">
      ✅ 20 / 20 QUESTIONS COMPLETED
    </text>
  </g>

  <!-- Title -->
  <g transform="translate(540, 330)">
    <text text-anchor="middle" font-family="'Cinzel','Playfair Display','Georgia',serif" font-size="22" font-weight="700" fill="#b48324" letter-spacing="4">
      CERTIFICATE OF ACHIEVEMENT
    </text>
  </g>

  <!-- Presented to -->
  <g transform="translate(540, 390)">
    <text text-anchor="middle" font-size="16" font-weight="500" fill="#64748b">
      Proudly presented to
    </text>
  </g>

  <!-- User Name -->
  <g transform="translate(540, 450)">
    <text text-anchor="middle" font-family="'Cinzel','Playfair Display','Georgia',serif" font-size="36" font-weight="800" fill="#0a2246">
      ${escapeXml(cleanName)}
    </text>
  </g>

  <!-- Completed level & domain -->
  <g transform="translate(540, 520)">
    <text text-anchor="middle" font-size="16" font-weight="600" fill="#334155">
      for successfully mastering
    </text>
  </g>

  <g transform="translate(540, 570)">
    <rect x="-240" y="-22" width="480" height="44" rx="22" fill="#eff6ff" stroke="#bfdbfe" stroke-width="1.5"/>
    <text text-anchor="middle" y="7" font-size="18" font-weight="800" fill="#0052cc" letter-spacing="0.5">
      ${escapeXml(domainDisplay)} — ${escapeXml(levelDisplay)}
    </text>
  </g>

  <!-- Achievement message -->
  <g transform="translate(540, 650)">
    <text text-anchor="middle" font-size="15" font-weight="500" fill="#475569">
      Demonstrated advanced SQL thinking and data engineering skills.
    </text>
  </g>

  <!-- Date & Handle -->
  <g transform="translate(540, 720)">
    <text text-anchor="middle" font-size="14" font-weight="600" fill="#64748b">
      Earned on ${escapeXml(dateDisplay)}
    </text>
  </g>

  <!-- Footer Branding -->
  <g transform="translate(540, 850)">
    <text text-anchor="middle" font-size="16" font-weight="700" fill="#0a2246">
      Built with <tspan fill="#0052cc">Data To Dashboard</tspan>
    </text>
  </g>
  <g transform="translate(540, 885)">
    <text text-anchor="middle" font-size="15" font-weight="800" fill="#2563eb" letter-spacing="1">
      @data_to_dashboard_
    </text>
  </g>
</svg>`;
}

export function getInstagramShareCaption({ userName, level, domain }) {
  const levelDisplay = formatCertificateLevel(level).replace(/ LEVEL/i, '').trim();
  const domainDisplay = formatCertificateDomain(domain);
  return `🎓 I’ve successfully completed the ${domainDisplay} – ${levelDisplay} level on Crack SQL!

✅ 20 Questions Completed
🚀 Continuing my SQL & Data Engineering journey.

Built with Data To Dashboard.

@data_to_dashboard_

#CrackSQL #DataToDashboard #SQL #DataEngineering #Learning #Certificate`;
}

export async function downloadInstagramShareImage(data) {
  return new Promise((resolve, reject) => {
    try {
      const svgString = generateInstagramShareSvg(data);
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const URL = window.URL || window.webkitURL || window;
      const blobUrl = URL.createObjectURL(blob);

      const img = new Image();
      img.onload = () => {
        try {
          const width = 1080;
          const height = 1080;
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');

          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.fillStyle = '#071b38';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);

          URL.revokeObjectURL(blobUrl);

          canvas.toBlob((pngBlob) => {
            if (!pngBlob) {
              reject(new Error('Failed to generate Instagram PNG blob'));
              return;
            }
            const link = document.createElement('a');
            const safeDomain = String(data.domain || 'Domain').replace(/[^a-zA-Z0-9]/g, '_');
            const safeLevel = String(data.level || 'Level').replace(/[^a-zA-Z0-9]/g, '_');
            link.download = `Crack_SQL_Instagram_${safeDomain}_${safeLevel}.png`;
            link.href = URL.createObjectURL(pngBlob);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(link.href), 1500);
            resolve(true);
          }, 'image/png');
        } catch (canvasErr) {
          URL.revokeObjectURL(blobUrl);
          reject(canvasErr);
        }
      };

      img.onerror = (e) => {
        URL.revokeObjectURL(blobUrl);
        reject(new Error('Failed to load Instagram share SVG for rasterization: ' + e));
      };

      img.src = blobUrl;
    } catch (err) {
      reject(err);
    }
  });
}


